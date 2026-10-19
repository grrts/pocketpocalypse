// npx vite-node tools/model-debug/chunkmodel.ts <id> [lon lat] : the model chunkgen builds for one building
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseOverpass } from '../../src/data/overpass';
import { decodePackTile } from '../../src/data/pack';
import { simulateOutbreak, regionStateAt } from '../../src/sim/outbreak';
import { NETHERLANDS } from '../../src/country/nl';
import { generateChunk } from '../../src/world/chunkgen';
import { CHUNK_TEXELS, DATA_TEXELS, lonLatToWorld } from '../../src/core/geo';

const D = 'public/data/nl';
const gz = (p: string) => JSON.parse(gunzipSync(readFileSync(p)).toString());
const [id, lonS, latS] = process.argv.slice(2);
const places: [number, number][] = lonS ? [[+lonS, +latS]] : [[5.1214, 52.0907], [5.11, 52.099]];
const cities = JSON.parse(readFileSync(`${D}/manifest.json`, 'utf8')).cities;
const history = simulateOutbreak(1, NETHERLANDS, cities);
for (const [lon, lat] of places) {
  const w = lonLatToWorld(lon, lat);
  const tx = Math.floor(w.x / DATA_TEXELS), ty = Math.floor(w.y / DATA_TEXELS);
  const geo = parseOverpass(gz(`${D}/detail/15/${tx}/${ty}.json.gz`), tx, ty, 'baked');
  const pack = decodePackTile(gz(`${D}/pack/10/${Math.floor(tx / 32)}/${Math.floor(ty / 32)}.json.gz`));
  const c = generateChunk({ cx: Math.floor(w.x / CHUNK_TEXELS), cy: Math.floor(w.y / CHUNK_TEXELS), seed: 1, geo, pack, packExtent: 4096, elevation: null, region: regionStateAt(history, lon, lat) });
  for (const m of c.models) {
    if (m.id !== id) continue;
    console.log(m.type, m.row, m.storeys, JSON.stringify(m.wings.map((x) => [x.box.s0, x.box.s1, x.box.d0, x.box.d1].map((v) => +v.toFixed(2)))));
    console.log(JSON.stringify(m.src?.rings.map((r) => r.length / 2)), m.party);
  }
}
