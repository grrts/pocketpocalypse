import { describe, expect, it } from 'vitest';
import { corpseLook, headingIndex, renderPerson, survivorLook, zombieLook, type Raster } from '../../src/render/people';

function box(r: Raster) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    if (!r.rgba[(y * r.w + x) * 4 + 3]) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, bottom: y1, cx: (x0 + x1 + 1) / 2 };
}

describe('people sprites', () => {
  it('draws a survivor 1.25x life size with an outline: ~10 px across, ~23 px tall, feet on the anchor', () => {
    const r = renderPerson(survivorLook(), { act: 'idle', frame: 0 }, 2); // facing the camera (south)
    const b = box(r);
    expect(b.w).toBeGreaterThanOrEqual(9);
    expect(b.w).toBeLessThanOrEqual(14);
    expect(b.h).toBeGreaterThanOrEqual(20);
    expect(b.h).toBeLessThanOrEqual(29);
    expect(Math.abs(b.bottom - r.oy)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.cx - r.ox)).toBeLessThanOrEqual(1.5);
  });

  it('gives every heading and walk frame its own picture', () => {
    const seen = new Set<string>();
    for (let d = 0; d < 8; d++) for (let f = 0; f < 4; f++) {
      const r = renderPerson(survivorLook(), { act: 'walk', frame: f }, d);
      seen.add(Buffer.from(r.rgba).toString('base64'));
    }
    expect(seen.size).toBeGreaterThanOrEqual(28);
  });

  it('is deterministic and uses no pure black or white', () => {
    const a = renderPerson(zombieLook('police', 3), { act: 'lunge', frame: 1 }, 5);
    const b = renderPerson(zombieLook('police', 3), { act: 'lunge', frame: 1 }, 5);
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
    for (let i = 0; i < a.rgba.length; i += 4) {
      if (!a.rgba[i + 3]) continue;
      const s = a.rgba[i] + a.rgba[i + 1] + a.rgba[i + 2];
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(765);
    }
  });

  it('lays a corpse out about 2.25 m long (1.25x) with a blood pool', () => {
    const r = renderPerson(corpseLook('civilian', 2), { act: 'lying', frame: 0 }, 0); // lying east-west
    const b = box(r);
    expect(b.w).toBeGreaterThanOrEqual(21);
    expect(b.w).toBeLessThanOrEqual(32);
    let red = 0;
    for (let i = 0; i < r.rgba.length; i += 4) if (r.rgba[i + 3] && r.rgba[i] > 70 && r.rgba[i] > r.rgba[i + 1] * 2.5) red++;
    expect(red).toBeGreaterThan(20);
  });

  it('outlines every figure in the dark outline colour and can flash white', () => {
    const r = renderPerson(zombieLook('runner', 1), { act: 'shamble', frame: 0 }, 1);
    const f = renderPerson(zombieLook('runner', 1), { act: 'shamble', frame: 0 }, 1, { flash: true });
    let outline = 0, white = 0;
    for (let i = 0; i < r.rgba.length; i += 4) {
      if (r.rgba[i + 3] && r.rgba[i] === 0x1b && r.rgba[i + 1] === 0x1a && r.rgba[i + 2] === 0x2e) outline++;
      if (f.rgba[i + 3] && f.rgba[i] > 240 && f.rgba[i + 1] > 240) white++;
      expect(!!r.rgba[i + 3]).toBe(!!f.rgba[i + 3]);
    }
    expect(outline).toBeGreaterThan(30);
    expect(white).toBeGreaterThan(60);
  });

  it('snaps angles to 8 headings', () => {
    expect(headingIndex(0)).toBe(0);
    expect(headingIndex(Math.PI / 2)).toBe(2);
    expect(headingIndex(-Math.PI / 2)).toBe(6);
    expect(headingIndex(Math.PI)).toBe(4);
    expect(headingIndex(0.3)).toBe(0);
    expect(headingIndex(0.5)).toBe(1);
  });
});
