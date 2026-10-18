// Global elevation from the public AWS Terrain Tiles (Terrarium encoding):
// metres = R*256 + G + B/256 - 32768. Used for hillshading the overview and for
// the flooding of below-sea-level polders once the pumps stop.

import { TILE_PX, tileTexels } from '../core/geo';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export class ElevationGrid {
  constructor(readonly z: number, readonly tx: number, readonly ty: number, readonly data: Float32Array | null) {}

  /** Bilinear sample at world texel coordinates (0 when unavailable). */
  sample(wx: number, wy: number): number {
    if (!this.data) return 0;
    const s = tileTexels(this.z) / TILE_PX;
    const fx = (wx - this.tx * tileTexels(this.z)) / s - 0.5;
    const fy = (wy - this.ty * tileTexels(this.z)) / s - 0.5;
    const x0 = Math.max(0, Math.min(TILE_PX - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(TILE_PX - 1, Math.floor(fy)));
    const x1 = Math.min(TILE_PX - 1, x0 + 1), y1 = Math.min(TILE_PX - 1, y0 + 1);
    const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
    const d = this.data;
    const a = d[y0 * TILE_PX + x0], b = d[y0 * TILE_PX + x1];
    const c = d[y1 * TILE_PX + x0], e = d[y1 * TILE_PX + x1];
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + e * ax) * ay;
  }
}

export function decodeTerrarium(rgba: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

export class ElevationSource {
  private cache = new Map<string, Promise<ElevationGrid>>();
  constructor(private urlTemplate: string = TERRARIUM_URL) {}

  get(z: number, tx: number, ty: number): Promise<ElevationGrid> {
    const key = `${z}/${tx}/${ty}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.load(z, tx, ty);
      this.cache.set(key, p);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  private async load(z: number, tx: number, ty: number): Promise<ElevationGrid> {
    try {
      const url = this.urlTemplate.replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty));
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const bmp = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(TILE_PX, TILE_PX);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      return new ElevationGrid(z, tx, ty, decodeTerrarium(ctx.getImageData(0, 0, TILE_PX, TILE_PX).data));
    } catch {
      return new ElevationGrid(z, tx, ty, null);
    }
  }
}
