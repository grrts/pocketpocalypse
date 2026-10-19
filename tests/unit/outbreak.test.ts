import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { simulateOutbreak, regionStateAt } from '../../src/sim/outbreak';
import { NETHERLANDS } from '../../src/country/nl';

const cities = JSON.parse(readFileSync('public/data/nl/manifest.json', 'utf8')).cities;

describe('outbreak simulation', () => {
  it('is deterministic for a seed', () => {
    const a = simulateOutbreak(123, NETHERLANDS, cities);
    const b = simulateOutbreak(123, NETHERLANDS, cities);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(simulateOutbreak(124, NETHERLANDS, cities))).not.toBe(JSON.stringify(a));
  });

  it('collapses cities before the present day and survives structured cloning', () => {
    const h = simulateOutbreak(1, NETHERLANDS, cities);
    expect(h.cities.every((c) => c.collapseDay <= h.presentDay)).toBe(true);
    expect(structuredClone(h)).toEqual(h);
    expect(h.timeline.length).toBeGreaterThan(3);
  });

  it('is denser in Utrecht centre than on the Veluwe', () => {
    const h = simulateOutbreak(1, NETHERLANDS, cities);
    const city = regionStateAt(h, 5.1214, 52.0907);
    const forest = regionStateAt(h, 5.83, 52.12);
    expect(city.city?.name).toBe('Utrecht');
    expect(city.urban).toBeGreaterThan(forest.urban);
    expect(city.intensity).toBeGreaterThan(forest.intensity);
  });
});
