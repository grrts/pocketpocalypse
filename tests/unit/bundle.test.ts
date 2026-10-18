import { describe, expect, it } from 'vitest';
import { tileOrigin } from '../../src/core/geo';
import { decodeTile, mergeNeighbours, readBundle } from '../../src/data/bundle';

// Mirrors the writer in tools/geobake/bake_bundles.py
function varint(out: number[], v: number) {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}
const zz = (v: number) => (v < 0 ? -2 * v - 1 : 2 * v);

type Feat = [type: number, tagset: number, name: number, rings: [number, number][][]];

function encode(tags: string[], names: string[], tiles: Record<string, Feat[]>, q = 2): Uint8Array {
  const blobs: number[][] = [];
  const index: [number, number, number, number][] = [];
  let off = 0;
  for (const [key, feats] of Object.entries(tiles)) {
    const raw: number[] = [];
    varint(raw, feats.length);
    let lx = 0, ly = 0;
    for (const [typ, ts, nm, rings] of feats) {
      raw.push(typ);
      varint(raw, ts);
      varint(raw, nm);
      if (typ === 0) varint(raw, rings.length);
      for (const g of rings) {
        varint(raw, g.length);
        g.forEach(([x, y], i) => {
          const px = i ? g[i - 1][0] : lx, py = i ? g[i - 1][1] : ly;
          varint(raw, zz(x - px));
          varint(raw, zz(y - py));
        });
        [lx, ly] = g[0];
      }
    }
    const [x, y] = key.split(',').map(Number);
    index.push([x, y, off, raw.length]);
    blobs.push(raw);
    off += raw.length;
  }
  const header = new TextEncoder().encode(JSON.stringify({ v: 2, z: 15, q, tags, names, tiles: index, pack: null }));
  const out = new Uint8Array(8 + header.length + off);
  out.set([0x50, 0x50, 0x47, 0x32], 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  let p = 8 + header.length;
  for (const b of blobs) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

const TAGS = ['building=house\x1fbuilding:levels=3', 'highway=residential', 'amenity=pharmacy', 'landuse=forest'];

describe('map bundles', () => {
  const buf = encode(TAGS, ['Oudegracht', 'Apotheek'], {
    '16840,10790': [
      [0, 0, 0, [[[10, 10], [20, 10], [20, 18], [10, 18]]]],
      [1, 1, 1, [[[0, 50], [100, 50], [100, 120]]]],
      [2, 2, 2, [[[40, 40]]]],
    ],
    '16841,10790': [[0, 3, 0, [[[1, 1], [30, 1], [30, 30]]]]],
  });
  const b = readBundle(buf);

  it('decodes buildings, streets and shops in texel coordinates', () => {
    const g = decodeTile(b, 16840, 10790, 'bundle');
    expect(g.origin).toEqual(tileOrigin(15, 16840, 10790));
    const house = g.areas.find((a) => a.kind === 'building')!;
    expect(house.levels).toBe(3);
    // q = 2 texels per unit, ring closed like an OSM way
    expect(house.rings[0]).toEqual([20, 20, 40, 20, 40, 36, 20, 36, 20, 20]);
    const road = g.lines[0];
    expect(road.name).toBe('Oudegracht');
    expect(road.pts).toEqual([0, 100, 200, 100, 200, 240]);
    expect(g.pois).toHaveLength(1);
    expect(g.pois[0]).toMatchObject({ x: 80, y: 80, name: 'Apotheek' });
  });

  it('returns an empty tile for tiles the bundle does not hold', () => {
    const g = decodeTile(b, 1, 1, 'bundle');
    expect(g.areas).toHaveLength(0);
  });

  it('pulls in neighbour features that reach into a window', () => {
    const base = decodeTile(b, 16840, 10790, 'bundle');
    const east = decodeTile(b, 16841, 10790, 'bundle');
    expect(east.areas).toHaveLength(1);
    const w = 2048;
    const near = mergeNeighbours(base, [east], w - 100, 0, w + 10, 100);
    expect(near.areas).toHaveLength(base.areas.length + 1);
    expect(near.areas.at(-1)!.rings[0][0]).toBe(w + 2);
    const far = mergeNeighbours(base, [east], 0, 0, 100, 100);
    expect(far.areas).toHaveLength(base.areas.length);
  });
});
