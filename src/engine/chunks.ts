import { CHUNK_TEXELS, chunkKey, type Vec2 } from '../core/geo';
import { C } from '../render/materials';
import type { ChunkResult } from '../worker/protocol';
import type { ChunkSpawns, ChunkStats } from '../world/spawnTypes';
import type { Camera } from './camera';
import type { WorkerPool } from './workerPool';

export interface Chunk {
  key: string;
  cx: number;
  cy: number;
  state: 'loading' | 'ready' | 'error';
  bitmap?: ImageBitmap;
  collision?: Uint8Array;
  spawns?: ChunkSpawns;
  stats?: ChunkStats;
  readyAt: number;
  lastNeeded: number;
  cancel?: () => void;
  error?: string;
}

export interface ChunkListener {
  onChunkReady(c: Chunk): void;
  onChunkUnload(c: Chunk): void;
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

  unload(c: Chunk) {
    if (c.state === 'ready') this.listener.onChunkUnload(c);
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
