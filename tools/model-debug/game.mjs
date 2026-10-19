// node tools/model-debug/game.mjs <port> <outdir> "name lon lat [wheel]; ..." : in-game screenshots on an iPhone 13
import { chromium, devices } from '../../node_modules/playwright/index.mjs';

const [port, out, spec] = process.argv.slice(2);
const browser = await chromium.launch();
for (const item of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
  const [name, lon, lat, wheel] = item.split(/\s+/);
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(name, 'pageerror', e.message));
  await page.goto(`http://localhost:${port}/?autostart=1&seed=test&spawn=${lon},${lat}&fast=1`);
  await page.waitForFunction(() => window.__pp && window.__pp.mode === 'playing', null, { timeout: 120000 });
  // hide the zombies near the player so the buildings show
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/game-${name}.png` });
  if (wheel) {
    const vp = page.viewportSize();
    await page.mouse.move(vp.width / 2, vp.height / 2);
    for (let k = 0; k < 6; k++) { await page.mouse.wheel(0, +wheel / 6); await page.waitForTimeout(150); }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/game-${name}-wide.png` });
  }
  const st = await page.evaluate(() => {
    const ch = window.__pp.chunks;
    const ms = [];
    for (const c of (ch.loaded?.values?.() ?? ch.chunks?.values?.() ?? [])) if (c?.stats?.ms) ms.push(c.stats.ms);
    return { ms: ms.map((v) => Math.round(v)), zoom: window.__pp.cam.zoom };
  });
  console.log(name, JSON.stringify(st));
  await ctx.close();
}
await browser.close();
