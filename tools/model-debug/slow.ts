// npx vite-node tools/model-debug/slow.ts lon lat : the slowest buildings to model
import { placeInputs } from '../../tests/unit/modelSamples';
import { buildModel } from '../../src/world/buildingModel';
const [lon, lat] = process.argv.slice(2).map(Number);
const { inputs } = await placeInputs(lon, lat, 0);
for (let k = 0; k < 5; k++) for (const i of inputs) buildModel(i);
const t: [number, string, number, string, number][] = [];
for (const i of inputs) {
  const a = performance.now();
  for (let k = 0; k < 20; k++) buildModel(i);
  t.push([(performance.now() - a) / 20, i.id, i.rings[0].length / 2, i.cls, i.rings.length]);
}
t.sort((a, b) => b[0] - a[0]);
console.log(t.slice(0, 10).map((x) => `${x[0].toFixed(3)} ms ${x[1]} nv ${x[2]} ${x[3]} rings ${x[4]}`).join('\n'));
console.log('total', t.reduce((s, x) => s + x[0], 0).toFixed(2), 'ms, median', t[t.length >> 1][0].toFixed(4));
