import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodePackTile } from '../../src/data/pack';

describe('decodePackTile', () => {
  it('undoes delta encoding', () => {
    const t = decodePackTile({ z: 8, x: 1, y: 2, enc: 'delta', k: ['land', 'motorway'], a: [[0, [10, 10, 5, 0, 0, 5, -5, 0]]], l: [[1, [1, 1, 2, 2]]] });
    expect(Array.from(t.areas[0].rings[0])).toEqual([10, 10, 15, 10, 15, 15, 10, 15]);
    expect(t.areas[0].cls).toBe('land');
    expect(Array.from(t.lines[0].pts)).toEqual([1, 1, 3, 3]);
  });

  it('reads the baked Netherlands pack', () => {
    const m = JSON.parse(readFileSync('public/data/nl/manifest.json', 'utf8'));
    expect(m.cities.length).toBeGreaterThan(50);
    const [x, y] = m.tiles['8'][0];
    const t = decodePackTile(JSON.parse(gunzipSync(readFileSync(`public/data/nl/pack/8/${x}/${y}.json.gz`)).toString()));
    expect(t.areas.length + t.lines.length).toBeGreaterThan(0);
  });
});
