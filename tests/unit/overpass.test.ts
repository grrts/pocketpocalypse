import { describe, expect, it } from 'vitest';
import { assembleRings, buildOverpassQuery, parseOverpass, type OverpassResponse } from '../../src/data/overpass';
import { tileLonLatBounds } from '../../src/core/geo';

describe('assembleRings', () => {
  it('joins open ways into a closed ring, whatever their direction', () => {
    const rings = assembleRings([
      [0, 0, 10, 0],
      [10, 10, 10, 0], // reversed
      [10, 10, 0, 10],
      [0, 10, 0, 0],
    ]);
    expect(rings).toHaveLength(1);
    const r = rings[0];
    expect([r[0], r[1]]).toEqual([r[r.length - 2], r[r.length - 1]]);
    expect(r.length).toBe(10);
  });

  it('keeps already closed rings', () => {
    expect(assembleRings([[0, 0, 1, 0, 1, 1, 0, 0]])).toHaveLength(1);
  });
});

describe('parseOverpass', () => {
  const b = tileLonLatBounds(15, 16850, 10810);
  const lon = (f: number) => b.w + (b.e - b.w) * f;
  const lat = (f: number) => b.n - (b.n - b.s) * f;
  const sq = (f0: number, f1: number) => [
    { lon: lon(f0), lat: lat(f0) }, { lon: lon(f1), lat: lat(f0) }, { lon: lon(f1), lat: lat(f1) }, { lon: lon(f0), lat: lat(f1) }, { lon: lon(f0), lat: lat(f0) },
  ];
  const resp = {
    elements: [
      { type: 'way', id: 1, tags: { building: 'house', 'building:levels': '3' }, geometry: sq(0.1, 0.2) },
      { type: 'way', id: 2, tags: { highway: 'residential', name: 'Oudegracht' }, geometry: [{ lon: lon(0), lat: lat(0.5) }, { lon: lon(1), lat: lat(0.5) }] },
      { type: 'way', id: 3, tags: { natural: 'water' }, geometry: sq(0.6, 0.9) },
      { type: 'node', id: 4, lat: lat(0.15), lon: lon(0.15), tags: { shop: 'supermarket' } },
    ],
  } as unknown as OverpassResponse;

  it('converts OSM features into tile-local texels', () => {
    const g = parseOverpass(resp, 16850, 10810, 'test');
    const bld = g.areas.find((a) => a.kind === 'building')!;
    expect(bld.levels).toBe(3);
    expect(bld.rings[0][0]).toBeCloseTo(0.1 * 2048, 0);
    const road = g.lines.find((l) => l.kind === 'road')!;
    expect(road.name).toBe('Oudegracht');
    expect(road.pts[1]).toBeCloseTo(1024, 0);
    expect(g.areas.some((a) => a.kind === 'water')).toBe(true);
    expect(g.pois.length).toBe(1);
  });

  it('builds a bbox query for the tile', () => {
    const q = buildOverpassQuery(16850, 10810);
    expect(q).toContain(b.s.toFixed(4).slice(0, 6));
    expect(q).toContain('out geom');
  });
});
