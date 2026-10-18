import { describe, expect, it } from 'vitest';
import { IdRaster } from '../../src/render/raster';

const ident = { ox: 0, oy: 0, scale: 1 };
const count = (r: IdRaster, id: number) => r.ids.reduce((n, v) => n + (v === id ? 1 : 0), 0);

describe('IdRaster', () => {
  it('fills a square exactly', () => {
    const r = new IdRaster(32, 32);
    r.fillPolygon([[4, 4, 14, 4, 14, 14, 4, 14]], 5, ident);
    expect(count(r, 5)).toBe(100);
    expect(r.get(4, 4)).toBe(5);
    expect(r.get(14, 14)).toBe(0);
  });

  it('leaves holes empty (even-odd)', () => {
    const r = new IdRaster(32, 32);
    r.fillPolygon([[0, 0, 20, 0, 20, 20, 0, 20], [5, 5, 15, 5, 15, 15, 5, 15]], 3, ident);
    expect(count(r, 3)).toBe(400 - 100);
    expect(r.get(10, 10)).toBe(0);
  });

  it('applies the transform and clips to the raster', () => {
    const r = new IdRaster(16, 16);
    r.fillPolygon([[-100, -100, 1000, -100, 1000, 1000, -100, 1000]], 1, ident);
    expect(count(r, 1)).toBe(256);
    const s = new IdRaster(16, 16);
    s.fillPolygon([[100, 100, 104, 100, 104, 104, 100, 104]], 2, { ox: 100, oy: 100, scale: 2 });
    expect(count(s, 2)).toBe(64);
  });

  it('respects masks and draws thick lines', () => {
    const r = new IdRaster(64, 64, 1);
    r.fillDisk(32, 32, 6, 9);
    r.fillPolyline([0, 32, 64, 32], 4, 7, ident, (cur) => cur !== 9);
    expect(r.get(32, 32)).toBe(9);
    expect(r.get(5, 32)).toBe(7);
    expect(r.get(5, 40)).toBe(1);
  });
});
