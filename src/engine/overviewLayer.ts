import { TILE_PX, tileTexels } from '../core/geo';
import type { OverviewResult } from '../worker/protocol';
import type { Camera } from './camera';
import type { WorkerPool } from './workerPool';

interface Tile {
  z: number;
  x: number;
  y: number;
  bitmap?: ImageBitmap;
  loading: boolean;
  used: number;
  cancel?: () => void;
}

/** Raster pyramid for zoomed-out views. Missing tiles fall back to a scaled-up ancestor. */
export class OverviewLayer {
  private tiles = new Map<string, Tile>();
  maxTiles = 220;
  minZ = 2;
  maxZ = 16;

  constructor(private pool: WorkerPool) {}

  /** Raster zoom for a camera zoom: one raster pixel ~ two screen pixels (chunky look). */
  rasterZoom(camZoom: number, dpr: number): number {
    return Math.max(this.minZ, Math.min(this.maxZ, Math.round(camZoom + Math.log2(dpr) - 1)));
  }

  get pending(): number {
    let n = 0;
    for (const t of this.tiles.values()) if (t.loading) n++;
    return n;
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, now: number, alpha = 1): void {
    const rz = this.rasterZoom(cam.zoom, cam.dpr);
    const size = tileTexels(rz);
    const b = cam.bounds();
    const n = 2 ** rz;
    const x0 = Math.max(0, Math.floor(b.x0 / size)), x1 = Math.min(n - 1, Math.floor(b.x1 / size));
    const y0 = Math.max(0, Math.floor(b.y0 / size)), y1 = Math.min(n - 1, Math.floor(b.y1 / size));
    const wanted = new Set<string>();
    ctx.globalAlpha = alpha;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${rz}/${x}/${y}`;
        wanted.add(key);
        const t = this.ensure(rz, x, y, now, cam);
        if (t.bitmap) {
          this.blit(ctx, cam, t.bitmap, rz, x, y, 0, 0, TILE_PX);
          continue;
        }
        // fallback: nearest loaded ancestor
        for (let up = 1; up <= 6 && rz - up >= 0; up++) {
          const az = rz - up;
          const ax = x >> up, ay = y >> up;
          const a = this.tiles.get(`${az}/${ax}/${ay}`);
          if (a?.bitmap) {
            a.used = now;
            const sub = TILE_PX >> up;
            this.blit(ctx, cam, a.bitmap, rz, x, y, (x - (ax << up)) * sub, (y - (ay << up)) * sub, sub);
            break;
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    // Cancel stale requests and trim the cache
    for (const [k, t] of this.tiles) {
      if (t.loading && !wanted.has(k) && now - t.used > 300) {
        t.cancel?.();
      }
    }
    if (this.tiles.size > this.maxTiles) {
      const old = [...this.tiles.entries()].filter(([, t]) => !t.loading).sort((a, b) => a[1].used - b[1].used);
      for (const [k, t] of old.slice(0, this.tiles.size - this.maxTiles)) {
        t.bitmap?.close();
        this.tiles.delete(k);
      }
    }
  }

  private blit(ctx: CanvasRenderingContext2D, cam: Camera, bmp: ImageBitmap, z: number, x: number, y: number, sx: number, sy: number, ss: number) {
    const size = tileTexels(z);
    // snap corners to whole device pixels so neighbouring tiles never show seams
    const a = cam.worldToScreen(x * size, y * size);
    const c = cam.worldToScreen((x + 1) * size, (y + 1) * size);
    const ax = Math.round(a.x), ay = Math.round(a.y);
    ctx.drawImage(bmp, sx, sy, ss, ss, ax, ay, Math.round(c.x) - ax, Math.round(c.y) - ay);
  }

  private ensure(z: number, x: number, y: number, now: number, cam: Camera): Tile {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { z, x, y, loading: true, used: now };
      this.tiles.set(key, t);
      const size = tileTexels(z);
      const d = Math.hypot((x + 0.5) * size - cam.center.x, (y + 0.5) * size - cam.center.y) / size;
      const tile = t;
      const job = this.pool.run<OverviewResult>({ type: 'overview', z, x, y }, 100 + d - z * 0.01);
      t.cancel = job.cancel;
      job.promise.then(
        (r) => {
          tile.bitmap = r.bitmap;
          tile.loading = false;
          if (this.tiles.get(key) !== tile) r.bitmap.close();
        },
        () => {
          if (this.tiles.get(key) === tile) this.tiles.delete(key);
        },
      );
    }
    t.used = now;
    return t;
  }

  /** Make sure the coarse levels used during a fly-to are already there. */
  prefetch(cam: Camera, zs: number[]): void {
    const now = performance.now();
    for (const z of zs) {
      const size = tileTexels(z);
      const x = Math.floor(cam.center.x / size), y = Math.floor(cam.center.y / size);
      this.ensure(z, x, y, now, cam);
    }
  }
}
