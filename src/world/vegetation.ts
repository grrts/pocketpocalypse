// Trees, bushes, hedges and ferns. Nothing about vegetation is baked into the
// map data, so it is placed procedurally per chunk as a pure function of the
// chunk's coordinates, the world seed, its material raster and its streets.
// Candidate points sit on world-aligned jittered grids, so a chunk always gets
// the same plants and neighbouring chunks agree on the grid.
//
// Output is one flat Int32Array of records (VEG_STRIDE ints each), sorted by y:
//   x, y      world position of the base (trunk foot / bush centre / hedge start) in art px (1/4 texel)
//   kind      a VK value
//   size      canopy / bush radius, or hedge half-depth, in art px
//   variant   0..255 hash, picks the sprite shape and tint
//   a, b      trees: visible trunk height (art px), trunk radius (art px)
//             hedges: dx, dy to the hedge's end point (art px)

import { CHUNK_TEXELS } from '../core/geo';
import { hash2, hashString, valueNoise } from '../core/rng';
import type { GeoLine } from '../data/types';
import { C, IS_ROOF, M } from '../render/materials';
import type { ChunkSpawns } from './spawnTypes';

export const VEG_STRIDE = 7;
/** Art pixels per world texel (see docs/ART_STYLE.md section 3). */
export const ART = 4;
/** Ground material that replaces M.FOREST at street level: earth, needles, moss. */
export const FOREST_FLOOR = 70;

/** Vegetation kinds. Below 10 are trees (trunk + canopy). */
export const VK = {
  LIME: 0, PLANE: 1, OAK: 2, BIRCH: 3, PINE: 4, SPRUCE: 5, WILLOW: 6, FRUIT: 7, DEAD: 8,
  BUSH: 10, HEDGE: 11, FERN: 12,
} as const;

export const isTree = (kind: number) => kind < 10;

const N = CHUNK_TEXELS;
// Fixed grid sizes in texels (about 5.1 m and 2.9 m in the Netherlands), so the
// grids line up across chunks regardless of latitude.
const TREE_CELL = 14;
const BUSH_CELL = 8;
const AVOID_CELL = 4;

// Ground a trunk or bush may stand on.
const PLANT_OK = new Uint8Array(256);
for (const m of [M.GRASS, M.LAND, M.FOREST, M.SCRUB, M.PARK, M.CEMETERY, M.RESIDENTIAL, M.ORCHARD, M.ALLOTMENT,
  M.URBAN, M.WETLAND, M.FARM, M.FARMYARD, M.COMMERCIAL, M.INDUSTRIAL, M.MILITARY, M.SAND, FOREST_FLOOR]) PLANT_OK[m] = 1;
// Street trees may also stand on the sidewalk.
const STREET_OK = PLANT_OK.slice();
STREET_OK[M.SIDEWALK] = 1;
// Front-garden hedges
const HEDGE_OK = new Uint8Array(256);
for (const m of [M.RESIDENTIAL, M.GRASS, M.LAND, M.URBAN, M.PARK]) HEDGE_OK[m] = 1;

// Highest chance per land cover of a tree / bush (or fern) per grid cell, for early outs.
const TREE_MAX = new Float32Array(256).fill(0.025);
for (const [m, p] of [[M.FOREST, 0.9], [M.PARK, 0.6], [M.CEMETERY, 0.35], [M.GRASS, 0.3], [M.RESIDENTIAL, 0.13], [M.FARMYARD, 0.18],
  [M.WETLAND, 0.07], [M.SCRUB, 0.08], [M.SAND, 0.04], [M.ALLOTMENT, 0.06], [M.LAND, 0.2], [M.MILITARY, 0.2], [M.FARM, 0.006]]) TREE_MAX[m] = p;
const BUSH_MAX = new Float32Array(256);
for (const [m, p] of [[M.SCRUB, 0.6], [M.FOREST, 0.28], [M.PARK, 0.35], [M.CEMETERY, 0.12], [M.RESIDENTIAL, 0.13], [M.ALLOTMENT, 0.15],
  [M.WETLAND, 0.22], [M.SAND, 0.07], [M.FARMYARD, 0.06], [M.LAND, 0.06], [M.GRASS, 0.12], [M.COMMERCIAL, 0.02], [M.INDUSTRIAL, 0.02], [M.URBAN, 0.02]]) BUSH_MAX[m] = p;

const STREET_TREE_ROADS = new Set(['residential', 'minor', 'tertiary', 'secondary', 'pedestrian']);
const HEDGE_ROADS = new Set(['residential', 'minor']);

export interface VegInput {
  cx: number;
  cy: number;
  seed: number;
  /** chunk material raster, N*N */
  ids: Uint8Array;
  /** texels per metre */
  tpm: number;
  /** streets touching the chunk, in coordinates relative to `origin` */
  roads: GeoLine[];
  origin: { x: number; y: number };
  /** whether streets got sidewalks */
  sidewalks: boolean;
  /** things already standing here (world texels) that plants must not grow on */
  spawns?: ChunkSpawns;
}

type Pick = [number, number][];

function weighted(list: Pick, u: number): number {
  let total = 0;
  for (const [, w] of list) total += w;
  let r = u * total;
  for (const [k, w] of list) if ((r -= w) < 0) return k;
  return list[list.length - 1][0];
}

/** Uniform [0,1) stream from a 32-bit hash. */
class Stream {
  constructor(private s: number) {}
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
}

export function placeVegetation(inp: VegInput): Int32Array {
  const { cx, cy, seed, ids, tpm } = inp;
  const ox = cx * N, oy = cy * N;
  const out: number[] = [];
  const A = ART * tpm; // art px per metre

  const mat = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= N || iy >= N) return -1;
    return ids[iy * N + ix];
  };
  /** centre and four points at radius r (texels) all on allowed ground (unknown = allowed) */
  const clear = (x: number, y: number, r: number, ok: Uint8Array) => {
    for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const v = mat(x + dx, y + dy);
      if (v >= 0 && !ok[v]) return false;
    }
    return true;
  };
  const roofNear = (x: number, y: number, r: number) => {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const v = mat(x + Math.cos(a) * r, y + Math.sin(a) * r);
      if (v >= 0 && IS_ROOF[v]) return true;
    }
    return false;
  };
  const waterNear = (x: number, y: number, r: number) => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const v = mat(x + Math.cos(a) * r, y + Math.sin(a) * r);
      if (v === M.WATER) return true;
    }
    return false;
  };

  // Cells already taken by cars, bodies, zombies and loot.
  const AW = N / AVOID_CELL;
  const avoid = new Uint8Array(AW * AW);
  const block = (wx: number, wy: number, r: number) => {
    const x0 = Math.max(0, Math.floor((wx - ox - r) / AVOID_CELL)), x1 = Math.min(AW - 1, Math.floor((wx - ox + r) / AVOID_CELL));
    const y0 = Math.max(0, Math.floor((wy - oy - r) / AVOID_CELL)), y1 = Math.min(AW - 1, Math.floor((wy - oy + r) / AVOID_CELL));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) avoid[y * AW + x] = 1;
  };
  const avoided = (x: number, y: number) => {
    const ix = Math.floor(x / AVOID_CELL), iy = Math.floor(y / AVOID_CELL);
    return ix >= 0 && iy >= 0 && ix < AW && iy < AW && avoid[iy * AW + ix] === 1;
  };
  if (inp.spawns) {
    for (const v of inp.spawns.vehicles) block(v.x, v.y, 1.3 * tpm);
    for (const c of inp.spawns.corpses) block(c.x, c.y, 0.9 * tpm);
    for (const z of inp.spawns.zombies) block(z.x, z.y, 0.9 * tpm);
    for (const c of inp.spawns.containers) block(c.x, c.y, 1 * tpm);
  }
  // Trunks and bushes claim their spot so later layers don't overlap them.
  const claim = (x: number, y: number, r: number) => block(ox + x, oy + y, r);

  const pushTree = (x: number, y: number, kind: number, rM: number, s: Stream, trunkM?: number) => {
    const variant = (s.next() * 256) | 0;
    let vis: number;
    if (trunkM !== undefined) vis = trunkM;
    else if (kind === VK.SPRUCE) vis = s.range(0.5, 0.9);
    else if (kind === VK.PINE) vis = s.range(2.3, 3.0);
    else if (kind === VK.FRUIT) vis = s.range(1.1, 1.6);
    else if (kind === VK.WILLOW) vis = s.range(1.4, 2.0);
    else vis = Math.min(3, 1.7 + rM * 0.12 + s.range(0, 0.35));
    const trunkR = Math.min(0.3, 0.14 + rM * 0.025);
    out.push(Math.round((ox + x) * ART), Math.round((oy + y) * ART), kind, Math.round(rM * A), variant, Math.round(vis * A), Math.max(1, Math.round(trunkR * A)));
    claim(x, y, Math.max(trunkR * tpm + 0.8 * tpm, AVOID_CELL * 0.6));
  };
  const pushBush = (x: number, y: number, kind: number, rM: number, s: Stream) => {
    out.push(Math.round((ox + x) * ART), Math.round((oy + y) * ART), kind, Math.max(2, Math.round(rM * A)), (s.next() * 256) | 0, 0, 0);
    if (kind === VK.BUSH) claim(x, y, rM * tpm * 0.7);
  };

  // 1. Street trees: one species per street, every 8-12 m along one or both sides.
  //    Streets are often split into short pieces, so everything is keyed on the
  //    street's name and the phase along each segment comes from its world position.
  const roadsOrigin = inp.origin;
  const pts = (l: GeoLine, i: number) => [l.pts[i] + roadsOrigin.x - ox, l.pts[i + 1] + roadsOrigin.y - oy];
  for (const l of inp.roads) {
    if (!STREET_TREE_ROADS.has(l.cls) || l.bridge) continue;
    const h = hashString(l.name ?? l.id) ^ seed;
    const s = new Stream(h);
    if (s.next() < 0.15) continue; // a bare street
    const sides = s.next() < 0.65 ? [1, -1] : [s.next() < 0.5 ? 1 : -1];
    const spacing = s.range(8, 12) * tpm;
    const species = weighted([[VK.LIME, 40], [VK.PLANE, 22], [VK.OAK, 10], [VK.BIRCH, 10], [VK.FRUIT, 12], [VK.SPRUCE, 0.5]], s.next());
    const baseR = species === VK.FRUIT ? s.range(1.8, 2.4) : s.range(2.2, 3.8);
    const halfW = (l.width * tpm) / 2;
    const off = halfW + (inp.sidewalks ? 0.75 : 1.6) * tpm;
    for (const side of sides) {
      for (let i = 0; i + 3 < l.pts.length; i += 2) {
        const [ax, ay] = pts(l, i), [bx, by] = pts(l, i + 2);
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-6) continue;
        const ux = (bx - ax) / len, uy = (by - ay) / len;
        const nx = -uy * side, ny = ux * side;
        const u0 = (ax + ox) * ux + (ay + oy) * uy;
        let acc = (((spacing - (u0 % spacing)) % spacing) + spacing) % spacing;
        for (; acc < len; acc += spacing) {
          const x = ax + ux * acc + nx * off, y = ay + uy * acc + ny * off;
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          const v = mat(x, y);
          if (v < 0 || !STREET_OK[v] || !clear(x, y, 0.6 * tpm, STREET_OK)) continue;
          if (avoided(x, y) || roofNear(x, y, 0.8 * tpm)) continue;
          const ts = new Stream(hash2(Math.round((ox + x) * 2), Math.round((oy + y) * 2), h));
          pushTree(x, y, ts.next() < 0.04 ? VK.DEAD : species, baseR * ts.range(0.85, 1.15), ts);
        }
      }
    }
  }

  // 2. Trees on land: dense forest, groves in parks, scattered in gardens and fields.
  const g0x = Math.floor(ox / TREE_CELL), g1x = Math.floor((ox + N - 1) / TREE_CELL);
  const g0y = Math.floor(oy / TREE_CELL), g1y = Math.floor((oy + N - 1) / TREE_CELL);
  const treeSalt = (seed ^ 0x51ed27) >>> 0;
  for (let gy = g0y; gy <= g1y; gy++) {
    for (let gx = g0x; gx <= g1x; gx++) {
      const s = new Stream(hash2(gx, gy, treeSalt));
      const wx = (gx + 0.1 + 0.8 * s.next()) * TREE_CELL, wy = (gy + 0.1 + 0.8 * s.next()) * TREE_CELL;
      const x = wx - ox, y = wy - oy;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const v = mat(x, y);
      if (!PLANT_OK[v]) continue;
      const u = s.next();
      if (u >= TREE_MAX[v]) continue;
      const clump = valueNoise(wx / 70, wy / 70, seed + 31);
      let p = 0, r0 = 2.5, r1 = 4.5;
      let list: Pick;
      switch (v) {
        case M.FOREST: {
          p = clump < 0.2 ? 0.12 : 0.9;
          r0 = 3; r1 = 6;
          const stand = valueNoise(wx / 300, wy / 300, seed + 7);
          list = stand < 0.42 ? [[VK.PINE, 70], [VK.SPRUCE, 22], [VK.BIRCH, 8]]
            : stand > 0.58 ? [[VK.OAK, 45], [VK.LIME, 25], [VK.BIRCH, 18], [VK.PLANE, 12]]
            : [[VK.PINE, 30], [VK.OAK, 30], [VK.BIRCH, 25], [VK.SPRUCE, 15]];
          break;
        }
        case M.PARK:
          p = clump > 0.55 ? 0.6 : 0.1;
          r0 = 3; r1 = 6.5;
          list = [[VK.OAK, 30], [VK.PLANE, 25], [VK.LIME, 25], [VK.BIRCH, 10], [VK.SPRUCE, 5], [VK.WILLOW, 5]];
          break;
        case M.CEMETERY:
          p = 0.35; r0 = 2.5; r1 = 4.5;
          list = [[VK.LIME, 40], [VK.SPRUCE, 25], [VK.BIRCH, 15], [VK.OAK, 20]];
          break;
        case M.GRASS:
          p = clump > 0.6 ? 0.3 : 0.06; r0 = 2.8; r1 = 5;
          list = [[VK.LIME, 30], [VK.OAK, 25], [VK.BIRCH, 20], [VK.PLANE, 15], [VK.WILLOW, 10]];
          break;
        case M.RESIDENTIAL:
          p = 0.13; r0 = 1.6; r1 = 3.4;
          list = [[VK.FRUIT, 30], [VK.BIRCH, 20], [VK.LIME, 20], [VK.SPRUCE, 15], [VK.PLANE, 10], [VK.DEAD, 5]];
          break;
        case M.FARMYARD:
          p = 0.18; r0 = 3; r1 = 5.5;
          list = [[VK.OAK, 40], [VK.LIME, 30], [VK.WILLOW, 15], [VK.FRUIT, 15]];
          break;
        case M.WETLAND:
          p = 0.07; r0 = 2.5; r1 = 4;
          list = [[VK.WILLOW, 60], [VK.BIRCH, 40]];
          break;
        case M.SCRUB:
          p = 0.08; r0 = 1.8; r1 = 3.2;
          list = [[VK.BIRCH, 50], [VK.PINE, 30], [VK.OAK, 20]];
          break;
        case M.SAND:
          p = 0.04; r0 = 2; r1 = 3.5;
          list = [[VK.PINE, 100]];
          break;
        case M.ALLOTMENT:
          p = 0.06; r0 = 1.6; r1 = 2.6;
          list = [[VK.FRUIT, 80], [VK.BIRCH, 20]];
          break;
        case M.LAND: case M.MILITARY:
          p = clump > 0.6 ? 0.2 : 0.04; r0 = 2.5; r1 = 5;
          list = [[VK.OAK, 35], [VK.BIRCH, 30], [VK.LIME, 20], [VK.PINE, 15]];
          break;
        case M.FARM:
          p = 0.006; r0 = 3.5; r1 = 6;
          list = [[VK.OAK, 70], [VK.WILLOW, 30]];
          break;
        default:
          p = 0.025; r0 = 2; r1 = 3.5;
          list = [[VK.LIME, 50], [VK.PLANE, 30], [VK.BIRCH, 20]];
      }
      if (u >= p) continue;
      if (!clear(x, y, 0.8 * tpm, PLANT_OK) || avoided(x, y)) continue;
      const rM = s.range(r0, r1);
      if (v !== M.FOREST && roofNear(x, y, Math.max(1.2, rM * 0.55) * tpm)) continue;
      let kind = weighted(list, s.next());
      if (v !== M.FOREST && kind !== VK.PINE && waterNear(x, y, 4 * tpm) && s.next() < 0.6) kind = VK.WILLOW;
      if (s.next() < 0.03) kind = VK.DEAD;
      pushTree(x, y, kind, kind === VK.SPRUCE ? rM * 0.75 : rM, s);
    }
  }

  // Orchards: fruit trees in neat rows.
  {
    const cell = 13; // about 4.8 m
    const a0x = Math.floor(ox / cell), a1x = Math.floor((ox + N - 1) / cell);
    const a0y = Math.floor(oy / cell), a1y = Math.floor((oy + N - 1) / cell);
    for (let gy = a0y; gy <= a1y; gy++) {
      for (let gx = a0x; gx <= a1x; gx++) {
        const x = gx * cell + cell / 2 - ox, y = gy * cell + cell / 2 - oy;
        if (x < 0 || y < 0 || x >= N || y >= N || mat(x, y) !== M.ORCHARD) continue;
        const s = new Stream(hash2(gx, gy, seed ^ 0x0c4a7d));
        if (s.next() < 0.08 || !clear(x, y, 0.6 * tpm, PLANT_OK) || avoided(x, y)) continue;
        pushTree(x, y, VK.FRUIT, s.range(1.5, 2.1), s);
      }
    }
  }

  // 3. Front-garden hedges along residential streets, with gaps at garden paths.
  if (inp.sidewalks) {
    for (const l of inp.roads) {
      if (!HEDGE_ROADS.has(l.cls) || l.bridge) continue;
      const h = hashString(l.name ?? l.id) ^ seed ^ 0x4ed9e;
      const s = new Stream(h);
      if (s.next() < 0.35) continue;
      const off = (l.width * tpm) / 2 + 1.7 * tpm + 0.55 * tpm;
      const garden = s.range(5, 8) * tpm;
      const step = 0.6 * tpm;
      for (const side of [1, -1]) {
        let acc = 0;
        let run: { x: number; y: number; x1: number; y1: number; len: number } | null = null;
        const flush = () => {
          if (run && run.len >= 1.2 * tpm) {
            out.push(Math.round((ox + run.x) * ART), Math.round((oy + run.y) * ART), VK.HEDGE, Math.round(0.42 * A),
              (hash2(Math.round(run.x), Math.round(run.y), h) >>> 24) & 255,
              Math.round((run.x1 - run.x) * ART), Math.round((run.y1 - run.y) * ART));
          }
          run = null;
        };
        for (let i = 0; i + 3 < l.pts.length; i += 2) {
          const [ax, ay] = pts(l, i), [bx, by] = pts(l, i + 2);
          const len = Math.hypot(bx - ax, by - ay);
          if (len < 1e-6) continue;
          const ux = (bx - ax) / len, uy = (by - ay) / len;
          const nx = -uy * side, ny = ux * side;
          flush();
          for (let t = 0; t < len; t += step, acc += step) {
            const x = ax + ux * t + nx * off, y = ay + uy * t + ny * off;
            const gi = Math.floor(acc / garden);
            const gs = hash2(gi, side, h);
            const inGarden = acc - gi * garden;
            const want = (gs & 255) < 150 && inGarden > 1.1 * tpm && x >= 0 && y >= 0 && x < N && y < N;
            const v = mat(x, y);
            const ok = want && v >= 0 && HEDGE_OK[v] === 1 && !roofNear(x, y, 0.6 * tpm) && !avoided(x, y) &&
              HEDGE_OK[Math.max(0, mat(x + nx * 0.4 * tpm, y + ny * 0.4 * tpm))] === 1;
            if (!ok) { flush(); continue; }
            if (!run) run = { x, y, x1: x, y1: y, len: 0 };
            else { run.x1 = x; run.y1 = y; run.len += step; }
            if (run.len > 6 * tpm) flush();
          }
        }
        flush();
      }
    }
  }

  // 4. Bushes and ferns on a finer grid.
  const b0x = Math.floor(ox / BUSH_CELL), b1x = Math.floor((ox + N - 1) / BUSH_CELL);
  const b0y = Math.floor(oy / BUSH_CELL), b1y = Math.floor((oy + N - 1) / BUSH_CELL);
  const bushSalt = (seed ^ 0xb054) >>> 0;
  for (let gy = b0y; gy <= b1y; gy++) {
    for (let gx = b0x; gx <= b1x; gx++) {
      const s = new Stream(hash2(gx, gy, bushSalt));
      const wx = (gx + 0.1 + 0.8 * s.next()) * BUSH_CELL, wy = (gy + 0.1 + 0.8 * s.next()) * BUSH_CELL;
      const x = wx - ox, y = wy - oy;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const v = mat(x, y);
      if (!PLANT_OK[v]) continue;
      const u = s.next();
      if (u >= BUSH_MAX[v]) continue;
      const clump = v === M.SCRUB || v === M.GRASS ? valueNoise(wx / 30, wy / 30, seed + 41) : 0;
      let p = 0, fern = 0;
      switch (v) {
        case M.SCRUB: p = clump > 0.35 ? 0.6 : 0.15; break;
        case M.FOREST: p = 0.08; fern = 0.2; break;
        case M.PARK: {
          // bushes gather along park edges and paths
          const edge = !clear(x, y, 3 * tpm, PLANT_OK);
          p = edge ? 0.35 : 0.03;
          break;
        }
        case M.CEMETERY: p = 0.12; break;
        case M.RESIDENTIAL: p = 0.13; break;
        case M.ALLOTMENT: p = 0.15; break;
        case M.WETLAND: p = 0.12; fern = 0.1; break;
        case M.SAND: p = 0.07; break;
        case M.FARMYARD: case M.LAND: p = 0.06; break;
        case M.GRASS: p = clump > 0.65 ? 0.12 : 0.02; break;
        case M.COMMERCIAL: case M.INDUSTRIAL: case M.URBAN: p = 0.02; break;
        default: p = 0;
      }
      if (u < p) {
        const rM = s.range(0.5, 1.0);
        if (!clear(x, y, rM * 0.9 * tpm, PLANT_OK) || avoided(x, y) || roofNear(x, y, (rM + 0.4) * tpm)) continue;
        pushBush(x, y, VK.BUSH, rM, s);
      } else if (u < p + fern) {
        if (avoided(x, y) || !clear(x, y, 0.5 * tpm, PLANT_OK)) continue;
        pushBush(x, y, VK.FERN, s.range(0.35, 0.6), s);
      }
    }
  }

  // Sort by base y so standing things draw south-last.
  const n = out.length / VEG_STRIDE;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => out[a * VEG_STRIDE + 1] - out[b * VEG_STRIDE + 1] || out[a * VEG_STRIDE] - out[b * VEG_STRIDE]);
  const res = new Int32Array(n * VEG_STRIDE);
  for (let i = 0; i < n; i++) for (let k = 0; k < VEG_STRIDE; k++) res[i * VEG_STRIDE + k] = out[order[i] * VEG_STRIDE + k];
  return res;
}

const SPECKLE = new Float32Array(256 * 256);
for (let i = 0; i < SPECKLE.length; i++) SPECKLE[i] = (hash2(i & 255, i >> 8, 0x7f1) & 1023) / 1023;

/** Forest ground under the trees: the canopy is now made of objects. */
export function forestFloor(ids: Uint8Array): void {
  const forest = M.FOREST;
  for (let i = 0; i < ids.length; i++) if (ids[i] === forest) ids[i] = FOREST_FLOOR;
}

/** Trunks block movement (a 0.5 m circle); bushes and hedges are low but solid. */
export function stampVegetation(col: Uint8Array, veg: Int32Array, cx: number, cy: number, tpm: number): void {
  const ox = cx * N, oy = cy * N;
  const disk = (x: number, y: number, r: number) => {
    const ri = Math.ceil(r);
    for (let py = Math.max(0, Math.floor(y - ri)); py <= Math.min(N - 1, Math.floor(y + ri)); py++) {
      for (let px = Math.max(0, Math.floor(x - ri)); px <= Math.min(N - 1, Math.floor(x + ri)); px++) {
        const dx = px + 0.5 - x, dy = py + 0.5 - y;
        if (dx * dx + dy * dy <= r * r) col[py * N + px] = C.SOLID;
      }
    }
  };
  for (let i = 0; i < veg.length; i += VEG_STRIDE) {
    const k = veg[i + 2];
    const x = veg[i] / ART - ox, y = veg[i + 1] / ART - oy;
    if (isTree(k)) disk(x, y, Math.max(0.72, 0.25 * tpm));
    else if (k === VK.BUSH) disk(x, y, Math.max(0.72, (veg[i + 3] / ART) * 0.7));
    else if (k === VK.HEDGE) {
      const dx = veg[i + 5] / ART, dy = veg[i + 6] / ART;
      const len = Math.hypot(dx, dy);
      const r = Math.max(0.72, (veg[i + 3] / ART) * 0.85);
      for (let t = 0; t <= len; t += 0.5) disk(x + (dx * t) / (len || 1), y + (dy * t) / (len || 1), r);
    }
  }
}

/**
 * Bake what lies flat on the ground into the chunk texture: forest-floor
 * texture and soft south-east shadows of canopies, bushes and hedges.
 */
export function bakeVegetation(rgba: Uint8ClampedArray, ids: Uint8Array, veg: Int32Array, cx: number, cy: number, tpm: number): void {
  const ox = cx * N, oy = cy * N;
  // forest floor: dark earth with needles, leaf litter and moss
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (ids[i] !== FOREST_FLOOR) continue;
      const r = SPECKLE[(((oy + y) & 255) << 8) | ((ox + x) & 255)];
      if (r > 0.16) continue;
      const o = i * 4;
      if (r < 0.06) { rgba[o] = 84; rgba[o + 1] = 72; rgba[o + 2] = 46; }
      else if (r < 0.12) { rgba[o] = 62; rgba[o + 1] = 82; rgba[o + 2] = 44; }
      else { rgba[o] *= 0.85; rgba[o + 1] *= 0.85; rgba[o + 2] *= 0.85; }
    }
  }
  // shadow darkness mask (max, not sum, so overlapping shadows don't stack)
  const mask = new Uint8Array(N * N);
  const ellipse = (x: number, y: number, rx: number, ry: number, k: number) => {
    const x0 = Math.max(0, Math.floor(x - rx)), x1 = Math.min(N - 1, Math.ceil(x + rx));
    const y0 = Math.max(0, Math.floor(y - ry)), y1 = Math.min(N - 1, Math.ceil(y + ry));
    for (let py = y0; py <= y1; py++) {
      const dy = (py + 0.5 - y) / ry;
      const row = py * N;
      for (let px = x0; px <= x1; px++) {
        const dx = (px + 0.5 - x) / rx;
        const d = dx * dx + dy * dy;
        if (d >= 1) continue;
        const v = d < 0.5 ? k : (k * (1 - d)) / 0.5;
        if (v > mask[row + px]) mask[row + px] = v;
      }
    }
  };
  for (let i = 0; i < veg.length; i += VEG_STRIDE) {
    const k = veg[i + 2];
    const x = veg[i] / ART - ox, y = veg[i + 1] / ART - oy;
    const r = veg[i + 3] / ART;
    if (isTree(k)) {
      const sh = 0.35 * r + 0.6 * tpm;
      ellipse(x + sh * 0.7, y + sh * 0.25 - r * 0.15, r * 0.95, r * 0.8, k === VK.DEAD ? 120 : 255);
      ellipse(x + 0.3 * tpm, y + 0.2 * tpm, 0.5 * tpm, 0.3 * tpm, 255);
    } else if (k === VK.BUSH) ellipse(x + r * 0.35, y + r * 0.3, r * 1.05, r * 0.85, 220);
    else if (k === VK.HEDGE) {
      const dx = veg[i + 5] / ART, dy = veg[i + 6] / ART;
      const len = Math.hypot(dx, dy) || 1;
      for (let t = 0; t <= len; t += 1) ellipse(x + (dx * t) / len + r * 0.5, y + (dy * t) / len + r * 0.45, r * 1.2, r * 1.1, 220);
    }
  }
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i];
    if (!m) continue;
    const f = 1 - 0.35 * (m / 255);
    const o = i * 4;
    rgba[o] *= f; rgba[o + 1] *= f; rgba[o + 2] *= f * 1.03;
  }
}
