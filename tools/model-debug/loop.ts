// npx vite-node tools/model-debug/loop.ts lon lat : buildModel + groupRows in a loop (for profiling)
import { placeInputs } from '../../tests/unit/modelSamples';
import { buildModel, groupRows, type BuildingModel } from '../../src/world/buildingModel';
const [lon, lat] = process.argv.slice(2).map(Number);
const { inputs } = await placeInputs(lon, lat, 0);
let tb = 0, tg = 0;
const N = 30;
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  const ms = inputs.map(buildModel).filter((m): m is BuildingModel => !!m);
  const t1 = performance.now();
  groupRows(ms);
  const t2 = performance.now();
  if (i >= 5) { tb += t1 - t0; tg += t2 - t1; }
}
console.log(`${inputs.length} buildings: build ${(tb / (N - 5)).toFixed(2)} ms, group ${(tg / (N - 5)).toFixed(2)} ms`);
