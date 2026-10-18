// Cloud-free Sentinel-2 colour mosaic baked by tools/geobake/sentinel.py into
// Web Mercator JPEG tiles (z8 and z10, ~90 m and ~23 m per pixel in NL). The
// game tints open ground with it so fields, heath, dunes and forest have the
// colours they have from orbit.

import { tileTexels } from '../core/geo';
import type { Resolve } from './bundle';

interface SatIndex {
  levels: number[];
  size: Record<string, number>;
}

export class SatTile {
  constructor(readonly z: number, readonly x: number, readonly y: number, readonly size: number, readonly rgba: Uint8ClampedArray) {}

  /** Bilinear colour at a world texel, written to out[0..2]; false where there is no imagery. */
  sample(wx: number, wy: number, out: Float32Array | number[]): boolean {
    const s = tileTexels(this.z) / this.size;
    const fx = (wx - this.x * tileTexels(this.z)) / s - 0.5;
    const fy = (wy - this.y * tileTexels(this.z)) / s - 0.5;
    const n = this.size;
    const x0 = Math.max(0, Math.min(n - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(n - 1, Math.floor(fy)));
    const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
    const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
    const d = this.rgba;
    const i00 = (y0 * n + x0) * 4, i10 = (y0 * n + x1) * 4, i01 = (y1 * n + x0) * 4, i11 = (y1 * n + x1) * 4;
    // black means no imagery (outside the mosaic)
    if (d[i00] + d[i00 + 1] + d[i00 + 2] < 6) return false;
    for (let c = 0; c < 3; c++) {
      out[c] = (d[i00 + c] * (1 - ax) + d[i10 + c] * ax) * (1 - ay) + (d[i01 + c] * (1 - ax) + d[i11 + c] * ax) * ay;
    }
    return true;
  }
}

export class SatelliteSource {
  private levels: number[] = [];
  private have = new Set<string>();
  private ready: Promise<void>;
  private cache = new Map<string, Promise<SatTile | null>>();

  constructor(private resolve: Resolve, private dir = 'sat') {
    this.ready = fetch(resolve(`${dir}/index.json`))
      .then((r) => (r.ok ? (r.json() as Promise<SatIndex & { tiles?: Record<string, [number, number][]> }>) : null))
      .then((j) => {
        if (!j) return;
        this.levels = j.levels.slice().sort((a, b) => a - b);
        if (j.tiles) for (const [z, list] of Object.entries(j.tiles)) for (const [x, y] of list) this.have.add(`${z}/${x}/${y}`);
      })
      .catch(() => undefined);
  }

  /** Finest mosaic tile covering tile (z, x, y), not finer than maxLevel. */
  async covering(z: number, x: number, y: number, maxLevel = 99): Promise<SatTile | null> {
    await this.ready;
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const l = this.levels[i];
      if (l > maxLevel || l > z) continue;
      const d = z - l;
      const t = await this.get(l, x >> d, y >> d);
      if (t) return t;
    }
    return null;
  }

  private get(z: number, x: number, y: number): Promise<SatTile | null> {
    const key = `${z}/${x}/${y}`;
    if (this.have.size && !this.have.has(key)) return Promise.resolve(null);
    let p = this.cache.get(key);
    if (!p) {
      p = this.load(z, x, y);
      this.cache.set(key, p);
      if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  private async load(z: number, x: number, y: number): Promise<SatTile | null> {
    try {
      const res = await fetch(this.resolve(`${this.dir}/${z}/${x}/${y}.jpg`));
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      const n = bmp.width;
      const c = new OffscreenCanvas(n, n);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      return new SatTile(z, x, y, n, ctx.getImageData(0, 0, n, n).data);
    } catch {
      return null;
    }
  }
}
