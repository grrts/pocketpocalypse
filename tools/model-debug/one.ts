// npx vite-node tools/model-debug/one.ts lon lat id : build one building many times (for profiling)
import { placeInputs } from '../../tests/unit/modelSamples';
import { buildModel } from '../../src/world/buildingModel';
const [lon, lat, id] = process.argv.slice(2);
const { inputs } = await placeInputs(+lon, +lat, 0);
const inp = inputs.find((i) => i.id === id)!;
const t0 = performance.now();
let m = null;
for (let k = 0; k < 20000; k++) m = buildModel(inp);
console.log(((performance.now() - t0) / 20000).toFixed(4), 'ms', m!.type, m!.wings.length, m!.openings.length);
