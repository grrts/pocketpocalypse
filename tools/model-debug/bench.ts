// npx vite-node tools/model-debug/bench.ts lon lat
import { placeInputs } from '../../tests/unit/modelSamples';
import { buildModel, groupRows, type BuildingModel } from '../../src/world/buildingModel';
const [lon, lat] = process.argv.slice(2).map(Number);
const { inputs, chunks } = await placeInputs(lon, lat, 1);
const byId = new Map(inputs.map((i) => [i.id, i]));
let worst = 0, worstN = 0, tb = 0, tg = 0;
for (let rep = 0; rep < 4; rep++) {
  for (const ids of chunks) {
    const t0 = performance.now();
    const ms = ids.map((id) => buildModel(byId.get(id)!)).filter((m): m is BuildingModel => !!m);
    const t1 = performance.now();
    groupRows(ms);
    const t2 = performance.now();
    if (rep === 3) { tb += t1 - t0; tg += t2 - t1; if (t2 - t0 > worst) { worst = t2 - t0; worstN = ids.length; } }
  }
}
console.log((await import('../../src/world/buildingModel') as any).PTDUMP?.());
console.log(`chunks ${chunks.length}, buildings ${inputs.length}, avg/chunk build ${(tb / chunks.length).toFixed(2)} ms group ${(tg / chunks.length).toFixed(2)} ms, worst chunk ${worst.toFixed(2)} ms (${worstN} bldgs)`);
