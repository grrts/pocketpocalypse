import { describe, expect, it } from 'vitest';
import {
  CHUNK_TEXELS, lonLatToWorld, worldToLonLat, metersPerTexel, tileAt, tileOrigin, pointInPolygon, ringArea, lonLatDistanceM,
} from '../../src/core/geo';

describe('geo', () => {
  it('round-trips lon/lat through world texels', () => {
    for (const [lon, lat] of [[5.1214, 52.0907], [3.3, 51.4], [7.2, 53.5]]) {
      const w = lonLatToWorld(lon, lat);
      const back = worldToLonLat(w.x, w.y);
      expect(back.lon).toBeCloseTo(lon, 7);
      expect(back.lat).toBeCloseTo(lat, 7);
    }
  });

  it('uses ~0.37 m texels in the Netherlands', () => {
    const w = lonLatToWorld(5.12, 52.09);
    expect(metersPerTexel(w.y)).toBeGreaterThan(0.35);
    expect(metersPerTexel(w.y)).toBeLessThan(0.39);
  });

  it('places the Dom tower in the expected z15 tile and chunk', () => {
    const w = lonLatToWorld(5.1214, 52.0907);
    expect(tileAt(15, w.x, w.y)).toEqual({ tx: 16850, ty: 10810 });
    const o = tileOrigin(16, Math.floor(w.x / CHUNK_TEXELS), Math.floor(w.y / CHUNK_TEXELS));
    expect(w.x - o.x).toBeGreaterThanOrEqual(0);
    expect(w.x - o.x).toBeLessThan(CHUNK_TEXELS);
  });

  it('handles polygons with holes', () => {
    const outer = [0, 0, 10, 0, 10, 10, 0, 10];
    const hole = [3, 3, 7, 3, 7, 7, 3, 7];
    expect(pointInPolygon(1, 1, [outer, hole])).toBe(true);
    expect(pointInPolygon(5, 5, [outer, hole])).toBe(false);
    expect(Math.abs(ringArea(outer))).toBe(100);
  });

  it('measures Utrecht to Amsterdam at ~35 km', () => {
    const d = lonLatDistanceM({ lon: 5.1214, lat: 52.0907 }, { lon: 4.9041, lat: 52.3676 });
    expect(d / 1000).toBeGreaterThan(33);
    expect(d / 1000).toBeLessThan(36);
  });
});
