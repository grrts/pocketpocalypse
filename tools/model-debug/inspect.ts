// npx vite-node tools/model-debug/inspect.ts lon lat radiusMetres
import { placeInputs } from '../../tests/unit/modelSamples';
import { buildModel, groupRows, type BuildingModel } from '../../src/world/buildingModel';
import { lonLatToWorld, texelsPerMeter, worldToLonLat } from '../../src/core/geo';
const [lon, lat, rad] = process.argv.slice(2).map(Number);
const { inputs } = await placeInputs(lon, lat, 0);
const models = inputs.map(buildModel).filter((m): m is BuildingModel => !!m);
groupRows(models);
const w = lonLatToWorld(lon, lat), tpm = texelsPerMeter(w.y);
for (const m of models) {
  const d = Math.hypot(m.ox - w.x, m.oy - w.y) / tpm;
  if (d > rad) continue;
  const s = m.src!;
  const ll = worldToLonLat(m.ox, m.oy);
  console.log(ll.lon.toFixed(5), ll.lat.toFixed(5), m.id, s.cls, s.levels, m.type, m.row, m.storeys, m.wings.map((x) => `${x.roof}${x.ridgeAlongS ? 'S' : 'D'} ${(x.box.s1 - x.box.s0).toFixed(1)}x${(x.box.d1 - x.box.d0).toFixed(1)} h${x.wallH}+${x.roofH.toFixed(1)} p${x.party?.map(Number).join('')}`).join(' | '), 'door', (s.door.nx).toFixed(2), s.door.ny.toFixed(2));
}
