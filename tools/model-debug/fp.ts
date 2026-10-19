// npx vite-node tools/model-debug/fp.ts <id> : the floor plan of one sample building
import { sampleBuildings } from '../../tests/unit/buildingSamples';
import { floorPlanOf } from '../../src/world/interior';
const id = process.argv[2];
const b = sampleBuildings().find((x) => x.id === id)!;
const tpm = b.tpm;
console.log(b.cls, JSON.stringify(b.rings.map((r) => r.map((v) => +(v / tpm).toFixed(2)))), b.door);
const p = floorPlanOf(b)!;
for (const [i, r] of p.plan.rooms.entries()) console.log(i, r.kind, r.parent, JSON.stringify(r.parts.map((q) => [q.s0, q.s1, q.d0, q.d1].map((v) => +v.toFixed(2)))));
console.log(p.plan.doors, JSON.stringify(p.plan.blocks));
