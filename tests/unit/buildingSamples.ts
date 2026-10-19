// Real buildings from the baked Utrecht data, for floor-plan tests.
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseOverpass } from '../../src/data/overpass';
import { decodePackTile } from '../../src/data/pack';
import { simulateOutbreak, regionStateAt } from '../../src/sim/outbreak';
import { NETHERLANDS } from '../../src/country/nl';
import { generateChunk } from '../../src/world/chunkgen';
import { CHUNK_TEXELS, DATA_TEXELS, lonLatToWorld } from '../../src/core/geo';
import type { BuildingInfo } from '../../src/world/spawnTypes';

const D = 'public/data/nl';
const gz = (p: string) => JSON.parse(gunzipSync(readFileSync(p)).toString());

/** Every enterable building in the chunks at these places (lon, lat). */
export function sampleBuildings(places: [number, number][] = [[5.1214, 52.0907], [5.1100, 52.0990]]): BuildingInfo[] {
  const cities = JSON.parse(readFileSync(`${D}/manifest.json`, 'utf8')).cities;
  const history = simulateOutbreak(1, NETHERLANDS, cities);
  const out: BuildingInfo[] = [];
  const seen = new Set<string>();
  for (const [lon, lat] of places) {
    const w = lonLatToWorld(lon, lat);
    const tx = Math.floor(w.x / DATA_TEXELS), ty = Math.floor(w.y / DATA_TEXELS);
    const path = `${D}/detail/15/${tx}/${ty}.json.gz`;
    if (!existsSync(path)) continue;
    const geo = parseOverpass(gz(path), tx, ty, 'baked');
    const pack = decodePackTile(gz(`${D}/pack/10/${Math.floor(tx / 32)}/${Math.floor(ty / 32)}.json.gz`));
    const cx = Math.floor(w.x / CHUNK_TEXELS), cy = Math.floor(w.y / CHUNK_TEXELS);
    const c = generateChunk({ cx, cy, seed: 1, geo, pack, packExtent: 4096, elevation: null, region: regionStateAt(history, lon, lat) });
    for (const b of c.interiors) if (!seen.has(b.id)) { seen.add(b.id); out.push(b); }
  }
  return out;
}
