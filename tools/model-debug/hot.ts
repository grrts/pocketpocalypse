// npx vite-node tools/model-debug/hot.ts lon lat type [r] : where in the area a type is densest
import { placeInputs } from '../../tests/unit/modelSamples';
import { buildModel, groupRows, type BuildingModel } from '../../src/world/buildingModel';
import { worldToLonLat } from '../../src/core/geo';
const [lon, lat, type, r] = process.argv.slice(2);
const { inputs } = await placeInputs(+lon, +lat, +(r ?? 1));
const models = inputs.map(buildModel).filter((m): m is BuildingModel => !!m);
groupRows(models);
const cells = new Map<string, { n: number; x: number; y: number }>();
const C = 100 * models[0].tpm;
for (const m of models) {
  if (m.type !== type) continue;
  const k = `${Math.floor(m.ox / C)},${Math.floor(m.oy / C)}`;
  const c = cells.get(k) ?? { n: 0, x: 0, y: 0 };
  c.n++; c.x += m.ox; c.y += m.oy;
  cells.set(k, c);
}
const top = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 4);
for (const c of top) { const ll = worldToLonLat(c.x / c.n, c.y / c.n); console.log(c.n, ll.lon.toFixed(5), ll.lat.toFixed(5)); }
