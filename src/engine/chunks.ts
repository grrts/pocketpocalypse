import { CHUNK_TEXELS, chunkKey, pointInPolygon, type Vec2 } from '../core/geo';
import { C, COLLISION } from '../render/materials';
import type { ChunkResult } from '../worker/protocol';
import { openInterior } from '../world/interior';
import type { BuildingInfo, ChunkSpawns, ChunkStats } from '../world/spawnTypes';
import type { BuildingModel } from '../world/buildingModel';
import { makeRec, type BuildingRec } from '../render/buildingDraw';
import type { Camera } from './camera';
import type { WorkerPool } from './workerPool';

const BCELL = 64;
/** how close (texels, ~15 m) someone must come before a building's inside is built */
const OPEN_RADIUS = 40;

// Street-level ground near the player is rendered at 2 art pixels per texel
// (16 MB per chunk instead of 4 MB), so it holds up next to the people at play
// zoom. Only a handful of chunks get it: those within HI_NEAR texels (~60 m) of
// the player, at most HI_MAX at once; they drop back to 1x beyond HI_FAR.
const HI_ZOOM = 19;
const HI_NEAR = 160;
const HI_FAR = 320;
const HI_MAX = 4;

export interface Chunk {
  key: string;
  cx: number;
  cy: number;
  state: 'loading' | 'ready' | 'error';
  bitmap?: ImageBitmap;
  /** art pixels per texel in bitmap (2 near the player, see ChunkManager.updateDetail) */
  scale?: number;
  /** pending 2x render */
  upgrade?: () => void;
  collision?: Uint8Array;
  spawns?: ChunkSpawns;
  /** buildings owned by this chunk (centre inside it) that can be entered */
  interiors?: BuildingInfo[];
  /** every building touching this chunk (shared with neighbours through ChunkManager.buildings) */
  models?: BuildingModel[];
  /** trees, bushes and hedges (world/vegetation.ts records) */
  veg?: Int32Array;
  stats?: ChunkStats;
  readyAt: number;
  lastNeeded: number;
  cancel?: () => void;
  error?: string;
}

export interface ChunkListener {
  onChunkReady(c: Chunk): void;
  onChunkUnload(c: Chunk): void;
  onChunkError?(c: Chunk): void;
  /** buildings appeared or went (their neighbours' party walls may have changed) */
  onBuildingsChanged?(ids: string[]): void;
}

/** Streams street-level chunks around the camera and the player. */
export class ChunkManager {
  readonly chunks = new Map<string, Chunk>();
  maxResident = 40;
  /** zoom below which street chunks are not streamed */
  readonly minZoom = 16.6;

  constructor(private pool: WorkerPool, private listener: ChunkListener) {}

  get loading(): number {
    let n = 0;
    for (const c of this.chunks.values()) if (c.state === 'loading') n++;
    return n;
  }

  /** Chunks needed this frame: visible ones (when zoomed in) plus a ring around focus points. */
  update(cam: Camera, focus: Vec2[], now: number): void {
    const needed = new Map<string, number>();
    const want = (cx: number, cy: number, prio: number) => {
      const k = chunkKey(cx, cy);
      const p = needed.get(k);
      if (p === undefined || prio < p) needed.set(k, prio);
    };
    if (cam.zoom >= this.minZoom) {
      const b = cam.bounds(CHUNK_TEXELS * 0.5);
      const cx0 = Math.floor(b.x0 / CHUNK_TEXELS), cx1 = Math.floor(b.x1 / CHUNK_TEXELS);
      const cy0 = Math.floor(b.y0 / CHUNK_TEXELS), cy1 = Math.floor(b.y1 / CHUNK_TEXELS);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) <= 30) {
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const d = Math.hypot((cx + 0.5) * CHUNK_TEXELS - cam.center.x, (cy + 0.5) * CHUNK_TEXELS - cam.center.y);
            want(cx, cy, d / CHUNK_TEXELS);
          }
        }
      }
    }
    for (const f of focus) {
      const fcx = Math.floor(f.x / CHUNK_TEXELS), fcy = Math.floor(f.y / CHUNK_TEXELS);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) want(fcx + dx, fcy + dy, Math.hypot(dx, dy) * 0.5);
      this.openNear(f, OPEN_RADIUS);
    }

    for (const [k, prio] of needed) {
      let c = this.chunks.get(k);
      if (!c) {
        const [cx, cy] = k.split(',').map(Number);
        c = { key: k, cx, cy, state: 'loading', readyAt: 0, lastNeeded: now };
        this.chunks.set(k, c);
        this.load(c, prio);
      }
      c.lastNeeded = now;
    }
    // Drop queued loads nobody needs any more
    for (const c of this.chunks.values()) {
      if (c.state === 'loading' && !needed.has(c.key) && now - c.lastNeeded > 500) {
        c.cancel?.();
      }
    }
    this.evict(needed, now);
    this.updateDetail(cam, focus);
  }

  /** Upgrade chunks around the player to the 2x ground texture, and drop far ones back to 1x. */
  private updateDetail(cam: Camera, focus: Vec2[]) {
    const p = focus[0];
    const dist = (c: Chunk) => {
      if (!p) return Infinity;
      const x0 = c.cx * CHUNK_TEXELS, y0 = c.cy * CHUNK_TEXELS;
      const dx = Math.max(x0 - p.x, 0, p.x - x0 - CHUNK_TEXELS), dy = Math.max(y0 - p.y, 0, p.y - y0 - CHUNK_TEXELS);
      return Math.hypot(dx, dy);
    };
    const hi: Chunk[] = [];
    let busy = 0;
    for (const c of this.chunks.values()) {
      if (c.scale === 2) hi.push(c);
      if (c.upgrade) busy++;
    }
    // farthest first
    hi.sort((a, b) => dist(b) - dist(a));
    let nHi = hi.length;
    for (const c of hi) {
      if (dist(c) <= HI_FAR && nHi <= HI_MAX) break;
      this.downgrade(c);
      nHi--;
    }
    if (!p || cam.zoom < HI_ZOOM) return;
    for (const c of this.chunks.values()) {
      if (c.state !== 'ready' || c.scale === 2 || c.upgrade || nHi + busy >= HI_MAX) continue;
      const d = dist(c);
      if (d > HI_NEAR) continue;
      busy++;
      const affinity = ((c.cx >> 1) * 31 + (c.cy >> 1)) >>> 0;
      const job = this.pool.run<ChunkResult>({ type: 'chunk', cx: c.cx, cy: c.cy, scale: 2 }, 1 + d / CHUNK_TEXELS, affinity);
      c.upgrade = job.cancel;
      job.promise.then(
        (r) => {
          c.upgrade = undefined;
          if (this.chunks.get(c.key) !== c || c.state !== 'ready') {
            r.bitmap.close();
            return;
          }
          c.bitmap?.close();
          c.bitmap = r.bitmap;
          c.scale = 2;
        },
        () => {
          c.upgrade = undefined;
        },
      );
    }
  }

  /** Back to a 1x bitmap (nearest-neighbour halving of the 2x one). */
  private downgrade(c: Chunk) {
    const bmp = c.bitmap;
    c.scale = 1;
    if (!bmp) return;
    createImageBitmap(bmp, { resizeWidth: CHUNK_TEXELS, resizeHeight: CHUNK_TEXELS, resizeQuality: 'pixelated' }).then(
      (small) => {
        if (c.bitmap !== bmp) {
          small.close();
          return;
        }
        c.bitmap = small;
        bmp.close();
      },
      () => {
        // cannot resize here: free the memory by dropping the chunk; it reloads at 1x when needed
        if (c.bitmap === bmp && this.chunks.get(c.key) === c) this.unload(c);
      },
    );
  }

  private load(c: Chunk, prio: number) {
    // chunks sharing a z15 data tile go to the same worker
    const affinity = ((c.cx >> 1) * 31 + (c.cy >> 1)) >>> 0;
    const job = this.pool.run<ChunkResult>({ type: 'chunk', cx: c.cx, cy: c.cy }, prio, affinity);
    c.cancel = job.cancel;
    job.promise.then(
      (r) => {
        if (this.chunks.get(c.key) !== c) {
          r.bitmap.close();
          return;
        }
        c.state = 'ready';
        c.bitmap = r.bitmap;
        c.collision = new Uint8Array(r.collision);
        c.spawns = r.spawns;
        c.interiors = r.interiors;
        c.models = r.models;
        this.addModels(r.models);
        c.veg = new Int32Array(r.veg);
        this.indexBuildings(r.interiors, true);
        // insides already opened that reach into this chunk
        for (const b of this.opened) this.stamp(b, c);
        c.stats = r.stats;
        c.readyAt = performance.now();
        c.cancel = undefined;
        this.listener.onChunkReady(c);
      },
      (e: Error) => {
        if (e.message === 'cancelled') {
          if (this.chunks.get(c.key) === c) this.chunks.delete(c.key);
          return;
        }
        console.warn('chunk failed', c.key, e.message);
        c.state = 'error';
        c.error = e.message;
        this.listener.onChunkError?.(c);
      },
    );
  }

  private evict(needed: Map<string, number>, now: number) {
    if (this.chunks.size <= this.maxResident) return;
    const victims = [...this.chunks.values()]
      .filter((c) => !needed.has(c.key) && c.state !== 'loading')
      .sort((a, b) => a.lastNeeded - b.lastNeeded);
    for (const c of victims) {
      if (this.chunks.size <= this.maxResident) break;
      if (now - c.lastNeeded < 1000) continue;
      this.unload(c);
    }
  }

  /**
   * Every loaded building once, by id (a building on a chunk edge comes with
   * both chunks), ready to draw.
   */
  readonly buildings = new Map<string, BuildingRec>();
  /** buildings whose drawing may have changed (new neighbours); the renderer drains this */
  readonly dirtyBuildings = new Set<string>();
  private mcells = new Map<number, BuildingRec[]>();

  private modelCells(r: BuildingRec, f: (k: number) => void) {
    for (let gy = Math.floor(r.y0 / BCELL); gy <= Math.floor(r.y1 / BCELL); gy++) {
      for (let gx = Math.floor(r.x0 / BCELL); gx <= Math.floor(r.x1 / BCELL); gx++) f(gx * 1048576 + gy);
    }
  }

  private addModels(list: BuildingModel[]) {
    const fresh: string[] = [];
    for (const m of list) {
      let r = this.buildings.get(m.id);
      if (!r) {
        r = makeRec(m);
        this.buildings.set(m.id, r);
        const rec = r;
        this.modelCells(r, (k) => { const cell = this.mcells.get(k); if (cell) cell.push(rec); else this.mcells.set(k, [rec]); });
        fresh.push(m.id);
      }
      r.refs++;
    }
    if (!fresh.length) return;
    // neighbours of new buildings may now have party walls
    const touched = new Set(fresh);
    for (const id of fresh) {
      const r = this.buildings.get(id)!;
      for (const o of this.modelsNear(r.x0 - 2, r.y0 - 2, r.x1 + 2, r.y1 + 2)) touched.add(o.m.id);
    }
    for (const id of touched) this.dirtyBuildings.add(id);
    this.listener.onBuildingsChanged?.([...touched]);
  }

  private dropModels(list: BuildingModel[]) {
    for (const m of list) {
      const r = this.buildings.get(m.id);
      if (!r || --r.refs > 0) continue;
      this.buildings.delete(m.id);
      this.modelCells(r, (k) => {
        const cell = this.mcells.get(k);
        if (!cell) return;
        const i = cell.indexOf(r);
        if (i >= 0) cell.splice(i, 1);
        if (!cell.length) this.mcells.delete(k);
      });
    }
  }

  /** Loaded buildings whose footprint box meets the given world box. */
  modelsNear(x0: number, y0: number, x1: number, y1: number): BuildingRec[] {
    const out = new Set<BuildingRec>();
    for (let gy = Math.floor(y0 / BCELL); gy <= Math.floor(y1 / BCELL); gy++) {
      for (let gx = Math.floor(x0 / BCELL); gx <= Math.floor(x1 / BCELL); gx++) {
        for (const r of this.mcells.get(gx * 1048576 + gy) ?? []) if (r.x1 >= x0 && r.x0 <= x1 && r.y1 >= y0 && r.y0 <= y1) out.add(r);
      }
    }
    return [...out];
  }

  unload(c: Chunk) {
    if (c.state === 'ready') this.listener.onChunkUnload(c);
    if (c.models) this.dropModels(c.models);
    if (c.interiors) {
      this.indexBuildings(c.interiors, false);
      for (const b of c.interiors) this.opened.delete(b);
    }
    c.upgrade?.();
    c.bitmap?.close();
    this.chunks.delete(c.key);
  }

  get(cx: number, cy: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  isReadyAround(p: Vec2, radius = 1): boolean {
    const cx = Math.floor(p.x / CHUNK_TEXELS), cy = Math.floor(p.y / CHUNK_TEXELS);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const c = this.get(cx + dx, cy + dy);
        if (!c || c.state === 'loading') return false;
      }
    }
    return true;
  }

  /** Movement class at a world texel; unloaded ground is treated as solid. */
  collisionAt(x: number, y: number): number {
    const cx = Math.floor(x / CHUNK_TEXELS), cy = Math.floor(y / CHUNK_TEXELS);
    const c = this.chunks.get(chunkKey(cx, cy));
    if (!c || !c.collision) return C.SOLID;
    const lx = Math.floor(x - cx * CHUNK_TEXELS), ly = Math.floor(y - cy * CHUNK_TEXELS);
    return c.collision[ly * CHUNK_TEXELS + lx];
  }

  /** Spatial hash of enterable buildings, so lookups per entity per frame stay cheap. */
  private bcells = new Map<number, BuildingInfo[]>();

  private indexBuildings(list: BuildingInfo[], add: boolean) {
    for (const b of list) {
      for (let gy = Math.floor(b.y0 / BCELL); gy <= Math.floor((b.y0 + b.h) / BCELL); gy++) {
        for (let gx = Math.floor(b.x0 / BCELL); gx <= Math.floor((b.x0 + b.w) / BCELL); gx++) {
          const k = gx * 1048576 + gy;
          const cell = this.bcells.get(k);
          if (add) {
            if (cell) cell.push(b);
            else this.bcells.set(k, [b]);
          } else if (cell) {
            const i = cell.indexOf(b);
            if (i >= 0) cell.splice(i, 1);
            if (!cell.length) this.bcells.delete(k);
          }
        }
      }
    }
  }

  /** Buildings whose insides have been built and cut into the collision grid. */
  private opened = new Set<BuildingInfo>();

  /**
   * Build the insides of buildings near p (rooms, doors, furniture) and cut them
   * into the collision grid. Until then a building is solid, which keeps chunk
   * generation cheap; a few are opened per call so walking never stutters.
   */
  openNear(p: Vec2, r: number, budget = 6): void {
    for (let gy = Math.floor((p.y - r) / BCELL); gy <= Math.floor((p.y + r) / BCELL); gy++) {
      for (let gx = Math.floor((p.x - r) / BCELL); gx <= Math.floor((p.x + r) / BCELL); gx++) {
        const cell = this.bcells.get(gx * 1048576 + gy);
        if (!cell) continue;
        for (const b of cell) {
          if (b.ids || budget <= 0) continue;
          if (p.x < b.x0 - r || p.y < b.y0 - r || p.x > b.x0 + b.w + r || p.y > b.y0 + b.h + r) continue;
          budget--;
          if (!openInterior(b)) continue;
          this.opened.add(b);
          for (let cy = Math.floor(b.y0 / CHUNK_TEXELS); cy <= Math.floor((b.y0 + b.h) / CHUNK_TEXELS); cy++) {
            for (let cx = Math.floor(b.x0 / CHUNK_TEXELS); cx <= Math.floor((b.x0 + b.w) / CHUNK_TEXELS); cx++) {
              const c = this.get(cx, cy);
              if (c) this.stamp(b, c);
            }
          }
        }
      }
    }
  }

  /** Copy an opened building's inside into one chunk's collision grid. */
  private stamp(b: BuildingInfo, c: Chunk) {
    if (!b.ids || !c.collision) return;
    const ox = c.cx * CHUNK_TEXELS, oy = c.cy * CHUNK_TEXELS;
    const x0 = Math.max(b.x0, ox), x1 = Math.min(b.x0 + b.w, ox + CHUNK_TEXELS);
    const y0 = Math.max(b.y0, oy), y1 = Math.min(b.y0 + b.h, oy + CHUNK_TEXELS);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = b.ids[(y - b.y0) * b.w + (x - b.x0)];
        if (v) c.collision[(y - oy) * CHUNK_TEXELS + (x - ox)] = COLLISION[v];
      }
    }
  }

  /** The enterable building whose footprint contains (x, y), if it is loaded. */
  buildingAt(x: number, y: number): BuildingInfo | null {
    const cell = this.bcells.get(Math.floor(x / BCELL) * 1048576 + Math.floor(y / BCELL));
    if (!cell) return null;
    for (const b of cell) {
      if (x < b.x0 || y < b.y0 || x >= b.x0 + b.w || y >= b.y0 + b.h) continue;
      if (pointInPolygon(x, y, b.rings)) return b;
    }
    return null;
  }

  /** Nearest walkable texel to p (spiral search), or null. */
  findWalkable(p: Vec2, maxR = 200): Vec2 | null {
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
    const ok = (x: number, y: number) => {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (this.collisionAt(x + dx, y + dy) !== C.WALK) return false;
      return true;
    };
    for (let r = 0; r < maxR; r++) {
      for (let i = -r; i <= r; i++) {
        for (const [x, y] of [[x0 + i, y0 - r], [x0 + i, y0 + r], [x0 - r, y0 + i], [x0 + r, y0 + i]]) {
          if (ok(x, y)) return { x: x + 0.5, y: y + 0.5 };
        }
      }
    }
    return null;
  }

  clear() {
    for (const c of [...this.chunks.values()]) {
      c.cancel?.();
      this.unload(c);
    }
  }
}
