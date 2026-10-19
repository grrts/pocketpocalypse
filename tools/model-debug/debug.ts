// Usage (from the worktree): npx vite-node <this> name lon lat [halfMetres] [r]
import { readFileSync } from 'node:fs';
import { placeInputs } from '../../tests/unit/modelSamples';
import { buildModel, groupRows, coverageOf, type BuildingModel } from '../../src/world/buildingModel';
import { lonLatToWorld, texelsPerMeter } from '../../src/core/geo';
import { chromium } from 'playwright';

const OUT = process.env.OUT ?? '.';
const places = process.argv.slice(2).join(' ').split(';').map((p) => p.trim().split(/\s+/)).filter((p) => p.length >= 3);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
await page.addScriptTag({ content: readFileSync('tools/model-debug/view.js', 'utf8') });
for (const [name, lonS, latS, halfS, rS] of places) {
  const lon = +lonS, lat = +latS, half = +(halfS ?? 90), r = +(rS ?? 0);
  const { inputs } = await placeInputs(lon, lat, r);
  const t0 = performance.now();
  const models = inputs.map(buildModel).filter((m): m is BuildingModel => !!m);
  const t1 = performance.now();
  groupRows(models);
  const t2 = performance.now();
  let cov = 0, over = 0, A = 0, wings = 0, bad = 0;
  const kinds: Record<string, number> = {};
  for (const m of models) {
    const c = coverageOf(m);
    cov += c.cover * c.area; over += c.over * c.area; A += c.area; wings += m.wings.length;
    if (c.cover < 0.85 || c.over > 0.15) bad++;
    kinds[m.kind!] = (kinds[m.kind!] ?? 0) + 1;
  }
  const rows = new Set(models.map((m) => m.row).filter(Boolean));
  console.log(`${name}: ${models.length} models, build ${(t1 - t0).toFixed(1)} ms, group ${(t2 - t1).toFixed(1)} ms, cover ${(cov / A * 100).toFixed(1)}%, over ${(over / A * 100).toFixed(1)}%, wings/bldg ${(wings / models.length).toFixed(2)}, poor ${bad}, rows ${rows.size}`, JSON.stringify(kinds));
  const types: Record<string, number> = {};
  for (const m of models) types[m.type!] = (types[m.type!] ?? 0) + 1;
  console.log(JSON.stringify(types));
  const w = lonLatToWorld(lon, lat);
  const tpm = texelsPerMeter(w.y);
  const R = half * tpm;
  const near = models.filter((m) => Math.abs(m.ox - w.x) < R * 1.3 && Math.abs(m.oy - w.y) < R * 1.3);
  await page.evaluate((d) => (window as any).drawModels(d), { models: near, cx: w.x, cy: w.y, half, ppm: 900 / (2 * half), tpm, title: `${name} ${lon},${lat}` });
  const el = await page.$('#c');
  await el!.screenshot({ path: `${OUT}/${name}.png` });
}
await browser.close();
