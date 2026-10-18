import { expect, test, type Page } from '@playwright/test';

// Uses the baked Utrecht tiles and blocks every external host, so it runs offline.
declare global {
  interface Window { __pp: any }
}

const mode = (page: Page) => page.evaluate(() => window.__pp?.mode);

test('spawn, loot, die, recover the corpse and keep changes across a reload', async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('?autostart=1&seed=e2e&spawn=5.1214,52.0907&geo=baked&fast=1');
  await expect.poll(() => mode(page), { timeout: 60_000 }).toBe('playing');

  // walk
  const p0 = await page.evaluate(() => window.__pp.world.player.x);
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(800);
  await page.keyboard.up('KeyD');
  expect(await page.evaluate(() => window.__pp.world.player.x)).toBeGreaterThan(p0);

  // search the nearest building and take everything
  const cid = await page.evaluate(() => {
    const w = window.__pp.world, p = w.player;
    let best: any = null, bd = Infinity;
    for (const c of w.allContainers()) {
      if (c.kind !== 'building') continue;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bd) { bd = d; best = c; }
    }
    p.x = best.x; p.y = best.y;
    return best.id as string;
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('KeyE');
  await expect(page.locator('#loot')).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('KeyF');
  await page.keyboard.press('Escape');

  // die and come back as the next survivor
  const carried = await page.evaluate(() => JSON.stringify(window.__pp.world.player.inventory));
  await page.evaluate(() => window.__pp.world.damagePlayer(999, 'zombie'));
  await expect(page.locator('#death button')).toBeVisible({ timeout: 5000 });
  expect(await page.evaluate(() => window.__pp.world.save.playerCorpses.length)).toBe(1);
  await page.click('#death button');
  await expect.poll(() => mode(page)).toBe('playing');

  // recover the body
  await page.evaluate(() => {
    const w = window.__pp.world, c = w.save.playerCorpses[0];
    w.player.x = c.x + 1; w.player.y = c.y;
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('KeyE');
  await expect(page.locator('#loot')).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('KeyF');
  await expect.poll(() => page.evaluate(() => window.__pp.world.save.playerCorpses.length)).toBe(0);
  const recovered = await page.evaluate(() => window.__pp.world.player.inventory.map((s: any) => s.id));
  for (const s of JSON.parse(carried)) expect(recovered).toContain(s.id);

  // reload: the searched building stays searched
  await page.evaluate(() => window.__pp.flush());
  await page.goto('?continue=1&geo=baked&fast=1');
  await expect.poll(() => mode(page), { timeout: 60_000 }).toBe('playing');
  await page.waitForTimeout(1000);
  const state = await page.evaluate((id) => {
    const w = window.__pp.world;
    for (const c of w.allContainers()) if (c.id === id) return { searched: w.isSearched(c), survivor: w.player.survivor };
    return null;
  }, cid);
  expect(state).toEqual({ searched: true, survivor: 2 });
  expect(errors).toEqual([]);
});
