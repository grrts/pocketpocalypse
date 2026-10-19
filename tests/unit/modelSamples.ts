// Real buildings from the baked country bundles, as building-model inputs:
// footprint, class, storeys and the front door chunkgen finds for them.
import { readFileSync, existsSync } from 'node:fs';
import { decodeTile, mergeNeighbours, readBundle, unwrapPng } from '../../src/data/bundle';
import { simulateOutbreak, regionStateAt } from '../../src/sim/outbreak';
import { NETHERLANDS } from '../../src/country/nl';
import { generateChunk } from '../../src/world/chunkgen';
import { CHUNK_TEXELS, DATA_TEXELS, lonLatToWorld } from '../../src/core/geo';
import type { GeoData } from '../../src/data/types';
import type { ModelInput } from '../../src/world/buildingModel';

const D = 'public/data/nl';
let history: ReturnType<typeof simulateOutbreak> | null = null;
const bundles = new Map<string, ReturnType<typeof readBundle> | null>();

async function bundle(bx: number, by: number) {
  const key = `${bx},${by}`;
  if (!bundles.has(key)) {
    const p = `${D}/geo/10/${bx}/${by}.png`;
    bundles.set(key, existsSync(p) ? readBundle(await unwrapPng(new Blob([readFileSync(p)]))) : null);
  }
  return bundles.get(key)!;
}

async function tile(tx: number, ty: number): Promise<GeoData | null> {
  const b = await bundle(tx >> 5, ty >> 5);
  return b ? decodeTile(b, tx, ty, 'bundle') : null;
}

export const haveBundles = () => existsSync(`${D}/geo/index.json`);

/**
 * Every enterable building in the (2r+1)² chunks around a place, and per chunk
 * the ids of the buildings that chunk holds.
 */
export async function placeInputs(lon: number, lat: number, r = 1): Promise<{ inputs: ModelInput[]; chunks: string[][] }> {
  history ??= simulateOutbreak(1, NETHERLANDS, JSON.parse(readFileSync(`${D}/manifest.json`, 'utf8')).cities);
  const w = lonLatToWorld(lon, lat);
  const ccx = Math.floor(w.x / CHUNK_TEXELS), ccy = Math.floor(w.y / CHUNK_TEXELS);
  const out: ModelInput[] = [];
  const chunks: string[][] = [];
  const seen = new Set<string>();
  for (let cy = ccy - r; cy <= ccy + r; cy++) for (let cx = ccx - r; cx <= ccx + r; cx++) {
    const tx = Math.floor((cx * CHUNK_TEXELS) / DATA_TEXELS), ty = Math.floor((cy * CHUNK_TEXELS) / DATA_TEXELS);
    const base = await tile(tx, ty);
    if (!base) continue;
    const lx0 = cx * CHUNK_TEXELS - tx * DATA_TEXELS, ly0 = cy * CHUNK_TEXELS - ty * DATA_TEXELS;
    const nx = lx0 === 0 ? -1 : 1, ny = ly0 === 0 ? -1 : 1;
    const others = (await Promise.all([[nx, 0], [0, ny], [nx, ny]].map(([dx, dy]) => tile(tx + dx, ty + dy)))).filter((g): g is GeoData => !!g);
    const pad = 160;
    const geo = mergeNeighbours(base, others, lx0 - pad, ly0 - pad, lx0 + CHUNK_TEXELS + pad, ly0 + CHUNK_TEXELS + pad);
    const levels = new Map(geo.areas.map((a) => [a.id, a.levels]));
    const c = generateChunk({ cx, cy, seed: 1, geo, pack: null, packExtent: 4096, elevation: null, region: regionStateAt(history, lon, lat) });
    const ids: string[] = [];
    for (const b of c.interiors) {
      ids.push(b.id);
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push({ id: b.id, rings: b.rings, cls: b.cls, levels: levels.get(b.id), seed: b.seed, burnt: b.burnt, tpm: b.tpm, door: b.door });
    }
    chunks.push(ids);
  }
  return { inputs: out, chunks };
}
