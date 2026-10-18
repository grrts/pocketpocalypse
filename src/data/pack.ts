// Static overview pack produced by tools/geobake/build_pack.py: land/sea, land
// cover, land use, water, major roads, rail and waterways at z5, z8 and z10.

import { fetchMaybeGzipJson } from './fetchJson';
import type { PackManifest, PackTile } from './types';

interface RawPackTile {
  z: number;
  x: number;
  y: number;
  enc?: 'delta';
  k: string[];
  a: [number, ...number[][]][];
  l: [number, number[]][];
}

function undelta(flat: number[], delta: boolean): Float32Array {
  const out = new Float32Array(flat.length);
  let x = 0, y = 0;
  for (let i = 0; i < flat.length; i += 2) {
    if (delta) {
      x += flat[i];
      y += flat[i + 1];
    } else {
      x = flat[i];
      y = flat[i + 1];
    }
    out[i] = x;
    out[i + 1] = y;
  }
  return out;
}

export function decodePackTile(raw: RawPackTile): PackTile {
  const delta = raw.enc === 'delta';
  return {
    z: raw.z,
    x: raw.x,
    y: raw.y,
    areas: raw.a.map(([ci, ...rings]) => ({ cls: raw.k[ci], rings: (rings as number[][]).map((r) => undelta(r, delta)) })),
    lines: raw.l.map(([ci, pts]) => ({ cls: raw.k[ci], pts: undelta(pts, delta) })),
  };
}

export class PackSource {
  private index = new Map<number, Set<string>>();
  private cache = new Map<string, Promise<PackTile | null>>();

  constructor(readonly baseUrl: string, readonly manifest: PackManifest) {
    for (const [z, list] of Object.entries(manifest.tiles)) {
      this.index.set(Number(z), new Set(list.map(([x, y]) => `${x},${y}`)));
    }
  }

  static async load(baseUrl: string): Promise<PackSource> {
    const res = await fetch(`${baseUrl}/manifest.json`);
    if (!res.ok) throw new Error(`Pack manifest missing at ${baseUrl}`);
    return new PackSource(baseUrl, (await res.json()) as PackManifest);
  }

  get levels(): number[] {
    return this.manifest.levels;
  }

  has(z: number, x: number, y: number): boolean {
    return !!this.index.get(z)?.has(`${x},${y}`);
  }

  /** Best pack level for drawing at raster zoom rz (never finer than rz). */
  levelFor(rz: number): number | null {
    let best: number | null = null;
    for (const l of this.levels) if (l <= rz) best = l;
    return best;
  }

  get(z: number, x: number, y: number): Promise<PackTile | null> {
    const key = `${z}/${x}/${y}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.has(z, x, y)
        ? fetchMaybeGzipJson<RawPackTile>(`${this.baseUrl}/pack/${z}/${x}/${y}${this.manifest.ext ?? '.json.gz'}`).then(decodePackTile).catch(() => null)
        : Promise.resolve(null);
      this.cache.set(key, p);
      if (this.cache.size > 96) {
        const first = this.cache.keys().next().value!;
        this.cache.delete(first);
      }
    }
    return p;
  }
}
