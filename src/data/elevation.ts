// Terrain height baked from the public AWS Terrain Tiles by
// tools/geobake/elevation.py (Terrarium encoding: metres = R*256 + G + B/256 -
// 32768), one 1024 px tile per z9 tile. Used for hillshading the overview and
// for the flooding of below-sea-level polders once the pumps stop. Nothing is
// fetched from outside the game's own files.

import { tileTexels } from '../core/geo';
import { decodePng } from './png';

export class ElevationGrid {
  constructor(readonly z: number, readonly tx: number, readonly ty: number, readonly data: Float32Array | null, readonly size = 256) {}

  /** Bilinear sample at world texel coordinates (0 when unavailable). */
  sample(wx: number, wy: number): number {
    if (!this.data) return 0;
    const N = this.size;
    const s = tileTexels(this.z) / N;
    const fx = (wx - this.tx * tileTexels(this.z)) / s - 0.5;
    const fy = (wy - this.ty * tileTexels(this.z)) / s - 0.5;
    const x0 = Math.max(0, Math.min(N - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(N - 1, Math.floor(fy)));
    const x1 = Math.min(N - 1, x0 + 1), y1 = Math.min(N - 1, y0 + 1);
    const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
    const d = this.data;
    const a = d[y0 * N + x0], b = d[y0 * N + x1];
    const c = d[y1 * N + x0], e = d[y1 * N + x1];
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + e * ax) * ay;
  }
}

export function decodeTerrarium(px: ArrayLike<number>, channels = 4): Float32Array {
  const out = new Float32Array(px.length / channels);
  for (let i = 0; i < out.length; i++) {
    out[i] = px[i * channels] * 256 + px[i * channels + 1] + px[i * channels + 2] / 256 - 32768;
  }
  return out;
}

export class ElevationSource {
  private cache = new Map<string, Promise<ElevationGrid | null>>();
  private z = 9;
  private have = new Set<string>();
  private ready: Promise<void>;

  /** url: the baked elevation folder, or undefined for no terrain. */
  constructor(private url?: string) {
    this.ready = url
      ? fetch(`${url}/index.json`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j: { z: number; tiles: [number, number][] } | null) => {
            if (!j) return;
            this.z = j.z;
            for (const [x, y] of j.tiles) this.have.add(`${x},${y}`);
          })
          .catch(() => undefined)
      : Promise.resolve();
  }

  /** Terrain covering tile (z, tx, ty); flat (no data) where nothing is baked or the tile is coarser than the bake. */
  async get(z: number, tx: number, ty: number): Promise<ElevationGrid> {
    await this.ready;
    const empty = new ElevationGrid(z, tx, ty, null);
    if (z < this.z) return empty;
    const d = z - this.z, x = tx >> d, y = ty >> d;
    const key = `${x},${y}`;
    if (!this.have.has(key)) return empty;
    let p = this.cache.get(key);
    if (!p) {
      p = this.load(x, y);
      this.cache.set(key, p);
      if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
    }
    return (await p) ?? empty;
  }

  private async load(x: number, y: number): Promise<ElevationGrid | null> {
    try {
      const res = await fetch(`${this.url}/${this.z}/${x}/${y}.png`);
      if (!res.ok) throw new Error(String(res.status));
      const png = await decodePng(new Uint8Array(await res.arrayBuffer()));
      return new ElevationGrid(this.z, x, y, decodeTerrarium(png.data, png.channels), png.width);
    } catch (e) {
      console.warn('terrain tile failed', x, y, e);
      return null;
    }
  }
}
