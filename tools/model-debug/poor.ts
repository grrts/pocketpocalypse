// npx vite-node tools/model-debug/poor.ts lon lat : the worst-covered buildings
import { placeInputs } from '../../tests/unit/modelSamples';
import { buildModel, groupRows, coverageOf, type BuildingModel } from '../../src/world/buildingModel';
import { worldToLonLat } from '../../src/core/geo';
const [lon, lat] = process.argv.slice(2).map(Number);
const { inputs } = await placeInputs(lon, lat, 0);
const models = inputs.map(buildModel).filter((m): m is BuildingModel => !!m);
groupRows(models);
const rows = models.map((m) => ({ m, c: coverageOf(m) })).sort((a, b) => (a.c.cover - a.c.over) - (b.c.cover - b.c.over));
for (const { m, c } of rows.slice(0, 15)) {
  const ll = worldToLonLat(m.ox, m.oy);
  console.log(ll.lon.toFixed(5), ll.lat.toFixed(5), m.id, m.type, c.area.toFixed(0), 'cover', c.cover.toFixed(2), 'over', c.over.toFixed(2), 'nv', m.src!.rings[0].length / 2, 'rings', m.src!.rings.length, 'wings', m.wings.length);
}
