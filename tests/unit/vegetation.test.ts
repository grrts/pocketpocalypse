import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseOverpass } from '../../src/data/overpass';
import { decodePackTile } from '../../src/data/pack';
import { simulateOutbreak, regionStateAt } from '../../src/sim/outbreak';
import { NETHERLANDS } from '../../src/country/nl';
import { generateChunk } from '../../src/world/chunkgen';
import { C, M } from '../../src/render/materials';
import { CHUNK_TEXELS as N, lonLatToWorld } from '../../src/core/geo';
import { ART, VEG_STRIDE, VK, isTree, placeVegetation } from '../../src/world/vegetation';

// A synthetic chunk: forest in the north, a park in the south, a road and a canal across.
const cx = 33700, cy = 21630, tpm = 2.73;
function raster(): Uint8Array {
  const ids = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let m: number = y < N / 2 ? M.FOREST : M.PARK;
      if (Math.abs(y - 300) < 6) m = M.ROAD_MINOR;
      else if (Math.abs(y - 300) < 11) m = M.SIDEWALK;
      if (Math.abs(x - 700) < 15) m = M.WATER;
      if (x > 100 && x < 140 && y > 700 && y < 740) m = M.ROOF_RED;
      ids[y * N + x] = m;
    }
  }
  return ids;
}
const road = { id: 'w1', kind: 'road' as const, cls: 'residential', pts: [0, 300, N, 300], width: 4.4 };
const place = (seed: number) =>
  placeVegetation({ cx, cy, seed, ids: raster(), tpm, roads: [road], origin: { x: cx * N, y: cy * N }, sidewalks: true });

describe('placeVegetation', () => {
  const a = place(7);
  const ids = raster();
  const recs = [...Array(a.length / VEG_STRIDE).keys()].map((i) => a.subarray(i * VEG_STRIDE, (i + 1) * VEG_STRIDE));
  const local = (r: Int32Array) => [Math.floor(r[0] / ART - cx * N), Math.floor(r[1] / ART - cy * N)];

  it('is a pure function of chunk, seed and raster', () => {
    expect(Buffer.from(place(7).buffer).equals(Buffer.from(a.buffer))).toBe(true);
    expect(Buffer.from(place(8).buffer).equals(Buffer.from(a.buffer))).toBe(false);
    for (let i = 1; i < recs.length; i++) expect(recs[i][1]).toBeGreaterThanOrEqual(recs[i - 1][1]);
  });

  it('fills the forest densely with 6-12 m canopies', () => {
    const forest = recs.filter((r) => isTree(r[2]) && local(r)[1] < 280);
    // ~190 x 380 m of forest
    expect(forest.length).toBeGreaterThan(1000);
    for (const r of forest) {
      const d = (2 * r[3]) / (ART * tpm);
      expect(d).toBeGreaterThan(3.5);
      expect(d).toBeLessThan(12.5);
    }
  });

  it('lines the street with trees on the sidewalk', () => {
    const street = recs.filter((r) => isTree(r[2]) && Math.abs(local(r)[1] - 300) < 12);
    expect(street.length).toBeGreaterThan(10);
  });

  it('never plants on roads, water or roofs', () => {
    for (const r of recs) {
      if (r[2] === VK.HEDGE) continue;
      const [x, y] = local(r);
      const m = ids[y * N + x];
      expect(m).not.toBe(M.ROAD_MINOR);
      expect(m).not.toBe(M.WATER);
      expect(m).not.toBe(M.ROOF_RED);
    }
  });
});

describe('vegetation in a real chunk (Utrecht centre)', () => {
  const D = 'public/data/nl';
  const gz = (p: string) => JSON.parse(gunzipSync(readFileSync(p)).toString());
  const cities = JSON.parse(readFileSync(`${D}/manifest.json`, 'utf8')).cities;
  const history = simulateOutbreak(1, NETHERLANDS, cities);
  const geo = parseOverpass(gz(`${D}/detail/15/16850/10810.json.gz`), 16850, 10810, 'baked');
  const pack = decodePackTile(gz(`${D}/pack/10/526/337.json.gz`));
  const dom = lonLatToWorld(5.1214, 52.0907);
  const ux = Math.floor(dom.x / N), uy = Math.floor(dom.y / N);
  const region = regionStateAt(history, 5.1214, 52.0907);
  const out = generateChunk({ cx: ux, cy: uy, seed: 1, geo, pack, packExtent: 4096, elevation: null, region });

  it('has trees with solid trunks, clear of zombies', () => {
    let trees = 0;
    for (let i = 0; i < out.veg.length; i += VEG_STRIDE) {
      if (!isTree(out.veg[i + 2])) continue;
      trees++;
      const x = Math.floor(out.veg[i] / ART - ux * N), y = Math.floor(out.veg[i + 1] / ART - uy * N);
      expect(out.collision[y * N + x]).toBe(C.SOLID);
    }
    expect(trees).toBeGreaterThan(30);
    for (const z of out.spawns.zombies) expect(out.collision[Math.floor(z.y - uy * N) * N + Math.floor(z.x - ux * N)]).not.toBe(C.SOLID);
  });
});
