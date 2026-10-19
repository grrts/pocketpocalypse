// A building as an architect would draw it, built on a real footprint.
//
// The map only gives us the blueprint: an outline, a class and sometimes a
// number of storeys. We do not paint over that outline. We read it as a plan,
// square it up into clean rectangular wings in the building's own axes, and put
// a proper building on top: straight walls, a roof with a straight ridge and
// eaves, a front door facing the street and windows on a regular rhythm.
// Renderers draw this model; nothing draws the raw outline.
//
// Coordinates: world texels, the same space as BuildingInfo.rings. Lengths in
// the model's own frame are metres (multiply by tpm for texels).
//
// How a footprint becomes wings: the outline's wall lines (edges running along
// the dominant axes) become cut lines, close lines merge and are snapped to
// 25 cm, strips thinner than a room (1.5 m) are merged away or dropped, and
// each cell of the resulting coarse grid is in the building when the outline
// fills at least half of it. The in-cells are then covered by a few largest
// rectangles: the main body first, then wings. Houses that share party walls
// are put into terraces by groupRows, which redraws them in one frame so the
// party walls line up and the row gets one roof line.

import { dominantAxis, type Box } from './floorplan';
import { hashString } from '../core/rng';
import { worldToLonLat } from '../core/geo';

export type RoofKind = 'gable' | 'hip' | 'flat' | 'mansard' | 'shed';

export interface Wing {
  /** rectangle in the building frame, metres from the frame origin (s along ux, d along uy) */
  box: Box;
  roof: RoofKind;
  /** ridge runs along s (true) or along d (false); ignored for flat roofs */
  ridgeAlongS: boolean;
  /** eaves height above the ground, metres */
  wallH: number;
  /** ridge height above the eaves, metres (0 for flat) */
  roofH: number;
  /** storeys of windows in this wing's walls */
  storeys?: number;
  /** shed roofs: the side (0..3, as Opening.side) where the roof is highest */
  high?: 0 | 1 | 2 | 3;
  /** per side (0..3): the side is mostly a party wall against a neighbouring building (no windows, no eaves overhang) */
  party?: [boolean, boolean, boolean, boolean];
  /** hip roofs: whether the ridge's start (s0 or d0 end) and end are hipped; a ridge end against a party wall stays a plain gable. Missing = both */
  hipEnds?: [boolean, boolean];
  /** greenhouses: the roof is this many small parallel glass ridges along the ridge direction (roofH is each one's rise) */
  ridges?: number;
}

export interface Opening {
  /** which wing and which side of it: 0 = d0 edge (-uy), 1 = s1 edge (+ux), 2 = d1 edge (+uy), 3 = s0 edge (-ux) */
  wing: number;
  side: 0 | 1 | 2 | 3;
  /** centre along that side, metres from the side's start (s0 or d0) */
  at: number;
  /** width in metres */
  w: number;
  kind: 'door' | 'window' | 'shopfront' | 'garage';
  /** for windows: which storey (0 = ground floor) */
  storey?: number;
}

/** A stretch of a wing side that is a party wall: along the side, metres from its start. */
export interface PartySpan {
  wing: number;
  side: 0 | 1 | 2 | 3;
  a: number;
  b: number;
}

/** Coarse form the model was drawn as (BuildingType is the detailed one). */
export type BuildingKind = 'house' | 'townhouse' | 'block' | 'hall' | 'barn' | 'church' | 'shed' | 'garage' | 'greenhouse' | 'canopy';

/**
 * What the building is (docs/BUILDING_TYPES.md). The renderer styles by this:
 * materials, gable decoration, dock doors, round bodies and so on.
 */
export type BuildingType =
  // homes
  | 'terrace' | 'semi' | 'detached' | 'bungalow' | 'canal_house' | 'block_bay'
  | 'portiekflat' | 'galerijflat' | 'apartments' | 'tower' | 'houseboat' | 'chalet'
  // services
  | 'supermarket' | 'retail_box' | 'office' | 'school' | 'church' | 'hospital' | 'police' | 'fire_station'
  | 'station' | 'petrol' | 'canopy' | 'commercial'
  // work and farm
  | 'hall' | 'distribution_centre' | 'greenhouse' | 'cow_shed' | 'animal_shed' | 'stolp' | 'kop_hals_romp'
  | 'long_farm' | 'farmhouse' | 'barn'
  // small and odd
  | 'garden_shed' | 'annex' | 'garage_box' | 'tank' | 'silo' | 'windmill';

export interface BuildingModel {
  id: string;
  cls: string;
  seed: number;
  burnt: boolean;
  /** frame origin (world texels) and unit axes; the frame is the building's dominant wall direction */
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  /** texels per metre */
  tpm: number;
  /** clean wings; together they are the building's squared-up footprint */
  wings: Wing[];
  openings: Opening[];
  storeys: number;
  /** id of the terrace row this house belongs to (houses sharing party walls), or '' */
  row: string;
  /** what it was drawn as */
  kind?: BuildingKind;
  /** what the building is; style by this */
  type?: BuildingType;
  /** canal houses: the decorated front gable on the street side */
  gable?: 'step' | 'neck' | 'bell' | 'spout' | 'cornice';
  /** thatched roof (rural villas and farms) */
  thatch?: boolean;
  /** round buildings (tank, silo, windmill): radius in metres around the centre of wing 0 (the wing is the equal-area square) */
  radius?: number;
  /** open structure (canopy): a roof on posts, walk under it */
  open?: boolean;
  /** pick materials (roof tiles, brick colour) from this, not from seed: houses in one row share it */
  style?: number;
  /** party walls: stretches of wing sides against a neighbouring building */
  party?: PartySpan[];
  /** groupRows has seen it with its neighbours: `party` and the wings' `party` flags are final */
  grouped?: boolean;
  /** the input it was built from (groupRows redraws from it) */
  src?: ModelInput;
}

export interface ModelInput {
  id: string;
  /** footprint rings in world texels (outer first) */
  rings: number[][];
  cls: string;
  levels?: number;
  seed: number;
  burnt: boolean;
  tpm: number;
  /** front door on the outline (world texels) and its outward normal */
  door: { x: number; y: number; nx: number; ny: number };
  // Optional context; each one sharpens the type when the caller knows it.
  /** POI class inside the footprint (shop, food_service, grocery, ...): ground-floor use. When given, cls should be the form class */
  use?: string;
  /** raw OSM building= value (yes, house, houseboat, roof, static_caravan, ...) */
  raw?: string;
  /** raw landuse under the centroid (farmyard, greenhouse_horticulture, industrial, port, religious, education, ...) */
  lu?: string;
  /** centroid lies in water */
  inWater?: boolean;
  /** in an old town core (canal houses) */
  oldCore?: boolean;
}

/** World texel position of a point given in the model frame (metres). */
export function toWorld(m: BuildingModel, s: number, d: number): [number, number] {
  const k = m.tpm;
  return [m.ox + (m.ux * s - m.uy * d) * k, m.oy + (m.uy * s + m.ux * d) * k];
}

/** Model frame position (metres) of a world texel point. */
export function toFrame(m: BuildingModel, x: number, y: number): [number, number] {
  const dx = (x - m.ox) / m.tpm, dy = (y - m.oy) / m.tpm;
  return [dx * m.ux + dy * m.uy, -dx * m.uy + dy * m.ux];
}

/** Length of a wing side (0/2 run along s, 1/3 along d). */
export function sideLength(b: Box, side: number): number {
  return side === 0 || side === 2 ? b.s1 - b.s0 : b.d1 - b.d0;
}

/**
 * The stretches of a wing side that are outside walls: not against another
 * wing of the same building and not a party wall. [a, b] along the side,
 * metres from its start, as Opening.at.
 */
export function outerSpans(m: BuildingModel, wi: number, side: number): [number, number][] {
  const b = m.wings[wi].box;
  const L = sideLength(b, side);
  let spans: [number, number][] = [[0, L]];
  const cut = (a: number, c: number) => {
    const out: [number, number][] = [];
    for (const [p, q] of spans) {
      if (c <= p + 1e-6 || a >= q - 1e-6) { out.push([p, q]); continue; }
      if (a > p + 1e-6) out.push([p, a]);
      if (c < q - 1e-6) out.push([c, q]);
    }
    spans = out;
  };
  m.wings.forEach((w, j) => {
    if (j === wi) return;
    const o = w.box;
    const iv = touchInterval(b, side, o);
    if (iv) cut(iv[0], iv[1]);
  });
  for (const p of m.party ?? []) if (p.wing === wi && p.side === side) cut(p.a, p.b);
  return spans.filter(([p, q]) => q - p > 0.05);
}

/** Where box o lies against side `side` of box b (interval along that side), if it does. */
function touchInterval(b: Box, side: number, o: Box): [number, number] | null {
  const E = 0.02;
  if (side === 0 || side === 2) {
    const c = side === 0 ? b.d0 : b.d1;
    const oc = side === 0 ? o.d1 : o.d0;
    if (Math.abs(c - oc) > E) return null;
    const a = Math.max(b.s0, o.s0), z = Math.min(b.s1, o.s1);
    return z - a > E ? [a - b.s0, z - b.s0] : null;
  }
  const c = side === 3 ? b.s0 : b.s1;
  const oc = side === 3 ? o.s1 : o.s0;
  if (Math.abs(c - oc) > E) return null;
  const a = Math.max(b.d0, o.d0), z = Math.min(b.d1, o.d1);
  return z - a > E ? [a - b.d0, z - b.d0] : null;
}

// ---------------------------------------------------------------- footprint -> wings

const SNAP = 0.25;
const MIN_STRIP = 1.5;
const MAX_WINGS = 5;

interface Frame {
  ux: number;
  uy: number;
  /** reference point (world texels) the frame's metres are measured from */
  rx: number;
  ry: number;
  k: number;
}

interface Regular {
  /** boxes in frame metres (relative to the reference point) */
  boxes: Box[];
  /** footprint area (m²), area of footprint inside the boxes, total box area */
  area: number;
  inside: number;
  boxArea: number;
  /** the outline's extent in the frame, and its vertex count */
  ext?: Box;
  nv?: number;
}

interface Cut { c: number; w: number; forced: boolean }

/** Polygon rings (frame metres, flat xy) clipped to a box: area of the footprint inside it. */
function clippedArea(rings: number[][], b: Box): number {
  let total = 0;
  for (let r = 0; r < rings.length; r++) {
    const a = Math.abs(ringArea2(clipRing(rings[r], b.s0, b.d0, b.s1, b.d1)));
    total += r === 0 ? a : -a;
  }
  return Math.max(0, total);
}

/** A ring clipped to a box (Sutherland-Hodgman; infinite bounds skip a side). */
function clipRing(ring: number[], x0: number, y0: number, x1: number, y1: number): number[] {
  let pts = ring;
  for (let e = 0; e < 4; e++) {
    const c = e === 0 ? x0 : e === 1 ? x1 : e === 2 ? y0 : y1;
    if (!isFinite(c)) continue;
    const out: number[] = [];
    const n = pts.length >> 1;
    if (n === 0) return pts;
    const ax = e < 2 ? 0 : 1, lo = e === 0 || e === 2;
    let px = pts[(n - 1) * 2], py = pts[(n - 1) * 2 + 1];
    let pin = lo ? (ax ? py : px) >= c : (ax ? py : px) <= c;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      const v = ax ? y : x;
      const cin = lo ? v >= c : v <= c;
      if (cin !== pin) {
        if (ax === 0) { const t = (c - px) / (x - px); out.push(c, py + t * (y - py)); }
        else { const t = (c - py) / (y - py); out.push(px + t * (x - px), c); }
      }
      if (cin) out.push(x, y);
      px = x; py = y; pin = cin;
    }
    pts = out;
  }
  return pts;
}

function ringArea2(pts: number[]): number {
  let a = 0;
  const n = pts.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) a += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  return a / 2;
}

function ringsToFrame(rings: number[][], f: Frame): number[][] {
  return rings.map((r) => {
    const o: number[] = [];
    for (let i = 0; i + 1 < r.length; i += 2) {
      const x = (r[i] - f.rx) / f.k, y = (r[i + 1] - f.ry) / f.k;
      o.push(x * f.ux + y * f.uy, -x * f.uy + y * f.ux);
    }
    // drop the closing point
    const n = o.length;
    if (n >= 4 && Math.abs(o[0] - o[n - 2]) < 1e-9 && Math.abs(o[1] - o[n - 1]) < 1e-9) o.length = n - 2;
    return o;
  });
}

function polyArea(rings: number[][]): number {
  let t = 0;
  rings.forEach((r, i) => {
    let a = 0;
    const n = r.length >> 1;
    for (let p = 0, q = n - 1; p < n; q = p++) a += r[q * 2] * r[p * 2 + 1] - r[p * 2] * r[q * 2 + 1];
    t += i === 0 ? Math.abs(a / 2) : -Math.abs(a / 2);
  });
  return Math.max(0, t);
}

/** Cluster cut positions: close lines merge into the one with the most wall behind it. */
function clusterCuts(cuts: Cut[], lo: number, hi: number, minStrip: number): Cut[] {
  cuts.sort((a, b) => a.c - b.c);
  const out: Cut[] = [];
  const merge = Math.min(0.6, minStrip * 0.4);
  for (const c of cuts) {
    const last = out[out.length - 1];
    if (last && c.c - last.c < merge) {
      if (last.forced) continue;
      if (c.forced) { out[out.length - 1] = { ...c, w: last.w + c.w }; continue; }
      const w = last.w + c.w;
      last.c = w > 0 ? (last.c * last.w + c.c * c.w) / w : (last.c + c.c) / 2;
      last.w = w;
      continue;
    }
    out.push({ ...c });
  }
  // snap, and keep only lines inside the footprint's extent
  const res: Cut[] = [];
  for (const c of out) {
    const v = c.forced ? c.c : Math.round(c.c / SNAP) * SNAP;
    if (v < lo - 0.3 || v > hi + 0.3) continue;
    if (res.length && v - res[res.length - 1].c < 1e-6) { res[res.length - 1].w += c.w; res[res.length - 1].forced ||= c.forced; continue; }
    res.push({ c: v, w: c.w, forced: c.forced });
  }
  return res;
}

/** At most a dozen wall lines: the extent, party walls and the ones with the most wall behind them. */
function capCuts(L: Cut[]): Cut[] {
  const MAX = 12;
  if (L.length <= MAX) return L;
  const keep = new Set<Cut>([L[0], L[L.length - 1], ...L.filter((c) => c.forced)]);
  for (const c of L.slice(1, -1).sort((a, b) => b.w - a.w)) { if (keep.size >= MAX) break; keep.add(c); }
  return L.filter((c) => keep.has(c));
}

/**
 * Square a footprint up into a few rectangles in the given frame. Forced cuts
 * (party walls) are wall lines that stay exactly where they are.
 */
function regularise(rings: number[][], f: Frame, forcedS: number[] = [], forcedD: number[] = []): Regular | null {
  const fr = ringsToFrame(rings, f);
  const outer = fr[0];
  if (!outer || outer.length < 6) return null;
  const area = polyArea(fr);
  if (area < 2) return null;
  let s0 = Infinity, s1 = -Infinity, d0 = Infinity, d1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    s0 = Math.min(s0, outer[i]); s1 = Math.max(s1, outer[i]);
    d0 = Math.min(d0, outer[i + 1]); d1 = Math.max(d1, outer[i + 1]);
  }
  const ext = Math.min(s1 - s0, d1 - d0);
  // strips thinner than this are not a room: merge them into a neighbour or drop them
  const minStrip = Math.min(MIN_STRIP, Math.max(0.6, ext * 0.3));

  const cs: Cut[] = [], cd: Cut[] = [];
  const COS = Math.cos((12 * Math.PI) / 180);
  for (const r of fr) {
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = r[j * 2], ay = r[j * 2 + 1], bx = r[i * 2], by = r[i * 2 + 1];
      const l = Math.hypot(bx - ax, by - ay);
      if (l < 1e-6) continue;
      const cx = Math.abs(bx - ax) / l, cy = Math.abs(by - ay) / l;
      if (cx >= COS) cd.push({ c: (ay + by) / 2, w: l, forced: false });
      else if (cy >= COS) cs.push({ c: (ax + bx) / 2, w: l, forced: false });
    }
  }
  for (const c of forcedS) cs.push({ c, w: 100, forced: true });
  for (const c of forcedD) cd.push({ c, w: 100, forced: true });
  // the extent bounds the grid; a real wall line close to it wins
  cs.push({ c: s0, w: 0.01, forced: false }, { c: s1, w: 0.01, forced: false });
  cd.push({ c: d0, w: 0.01, forced: false }, { c: d1, w: 0.01, forced: false });

  const F = integral(fr, s0, s1, d0, d1);
  const tryGrid = (S: Cut[], D: Cut[]) => solveGrid(F, area, capCuts(S), capCuts(D), minStrip);
  const S = clusterCuts(cs, s0, s1, minStrip).filter((c) => c.w >= 0.9 || c.forced || c.c <= s0 + 0.3 || c.c >= s1 - 0.3);
  const D = clusterCuts(cd, d0, d1, minStrip).filter((c) => c.w >= 0.9 || c.forced || c.c <= d0 + 0.3 || c.c >= d1 - 0.3);
  let best = tryGrid(S, D);
  // outlines with few straight walls (round, slanted): add a regular grid and keep it if it fits better
  const err = (g: Regular | null) => (g ? area + g.boxArea - 2 * g.inside + area * 0.03 * (g.boxes.length - 1) : Infinity);
  if (!best || err(best) > area * 0.2) {
    const extra = (lo: number, hi: number) => {
      const n = Math.min(6, Math.max(2, Math.round((hi - lo) / 4)));
      const o: Cut[] = [];
      for (let i = 1; i < n; i++) o.push({ c: lo + ((hi - lo) * i) / n, w: 0.5, forced: false });
      return o;
    };
    const alt = tryGrid(clusterCuts([...S, ...extra(s0, s1)], s0, s1, minStrip), clusterCuts([...D, ...extra(d0, d1)], d0, d1, minStrip));
    if (err(alt) < err(best)) best = alt;
  }
  if (best) { best.ext = { s0, s1, d0, d1 }; best.nv = outer.length >> 1; }
  return best;
}

/** Footprint area inside any box, from a rasterised integral image (bilinear between lattice lines). */
interface Integral { cell(s0: number, s1: number, d0: number, d1: number): number }

let rowBuf = new Float64Array(64);
function integral(fr: number[][], s0: number, s1: number, d0: number, d1: number): Integral {
  const g = Math.max(SNAP, Math.max(s1 - s0, d1 - d0) / 28);
  const i0 = Math.floor(s0 / g), j0 = Math.floor(d0 / g);
  const nx = Math.max(1, Math.ceil(s1 / g) - i0), ny = Math.max(1, Math.ceil(d1 / g) - j0);
  const W = nx + 1;
  const P = new Float64Array(W * (ny + 1));
  if (rowBuf.length < nx) rowBuf = new Float64Array(nx * 2);
  const row = rowBuf;
  const xs: number[] = [];
  for (let j = 0; j < ny; j++) {
    row.fill(0, 0, nx);
    for (let sub = 0.25; sub < 1; sub += 0.5) {
      const y = (j0 + j + sub) * g;
      xs.length = 0;
      for (const r of fr) {
        const n = r.length >> 1;
        for (let p = 0, q = n - 1; p < n; q = p++) {
          const ay = r[q * 2 + 1], by = r[p * 2 + 1];
          if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(r[q * 2] + ((y - ay) / (by - ay)) * (r[p * 2] - r[q * 2]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const u = clamp(xs[k] / g - i0, 0, nx), v = clamp(xs[k + 1] / g - i0, 0, nx);
        const iu = Math.floor(u), iv = Math.min(nx - 1, Math.floor(v));
        if (iu >= nx) continue;
        if (iu === iv) { row[iu] += v - u; continue; }
        row[iu] += iu + 1 - u;
        for (let i = iu + 1; i < iv; i++) row[i] += 1;
        row[iv] += v - iv;
      }
    }
    const base = (j + 1) * W, prev = j * W;
    let acc = 0;
    for (let i = 0; i < nx; i++) {
      acc += row[i] * 0.5 * g * g;
      P[base + i + 1] = P[prev + i + 1] + acc;
    }
  }
  const at = (s: number, d: number) => {
    const u = clamp(s / g - i0, 0, nx), v = clamp(d / g - j0, 0, ny);
    const iu = Math.min(nx - 1, Math.floor(u)), iv = Math.min(ny - 1, Math.floor(v));
    const fu = u - iu, fv = v - iv;
    const a = P[iv * W + iu], b = P[iv * W + iu + 1], c = P[(iv + 1) * W + iu], e = P[(iv + 1) * W + iu + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + e * fu) * fv;
  };
  return { cell: (a, b, c, e) => Math.max(0, at(b, e) - at(a, e) - at(b, c) + at(a, c)) };
}

/** Indices (ascending) of the wings joined to the first along a real piece of wall, directly or through others. */
function linkedWings(boxes: Box[]): number[] {
  const linked = (a: Box, c: Box) => {
    const os = Math.min(a.s1, c.s1) - Math.max(a.s0, c.s0), od = Math.min(a.d1, c.d1) - Math.max(a.d0, c.d0);
    const need = Math.min(2.4, 0.6 * Math.min(c.s1 - c.s0, c.d1 - c.d0, a.s1 - a.s0, a.d1 - a.d0));
    return (os >= need && Math.abs(od) < 1e-6) || (od >= need && Math.abs(os) < 1e-6) || (os > 1e-6 && od > 1e-6);
  };
  const keep = [0];
  const seen = new Set([0]);
  for (let q = 0; q < keep.length; q++) {
    for (let k = 0; k < boxes.length; k++) if (!seen.has(k) && linked(boxes[keep[q]], boxes[k])) { seen.add(k); keep.push(k); }
  }
  return keep.sort((a, b) => a - b);
}

/** Cells of the cut grid, slivers removed, filled cells covered by a few rectangles. */
function solveGrid(F: Integral, area: number, S0: Cut[], D0: Cut[], minStrip: number): Regular | null {
  let S = S0.slice(), D = D0.slice();
  if (S.length < 2 || D.length < 2) return null;
  // footprint area per cell; dropping a line merges (or drops) a strip of cells
  const G: number[][] = [];
  for (let j = 0; j + 1 < D.length; j++) {
    const row: number[] = [];
    for (let i = 0; i + 1 < S.length; i++) row.push(F.cell(S[i].c, S[i + 1].c, D[j].c, D[j + 1].c));
    G.push(row);
  }
  const errCell = (f: number, a: number) => (f >= a * 0.5 ? a - f : f);
  const cellA = (i: number, j: number) => (S[i + 1].c - S[i].c) * (D[j + 1].c - D[j].c);
  // remove thin strips: drop whichever of the two lines fits the outline better
  for (let guard = 0; guard < 24; guard++) {
    let worst = -1, axis = 0, gap = Infinity;
    for (let ax = 0; ax < 2; ax++) {
      const L = ax === 0 ? S : D;
      for (let i = 0; i + 1 < L.length; i++) {
        const g = L[i + 1].c - L[i].c;
        if (g < minStrip - 1e-6 && g < gap) { gap = g; worst = i; axis = ax; }
      }
    }
    if (worst < 0) break;
    const L = axis === 0 ? S : D;
    if (L.length <= 2) break;
    const nOther = axis === 0 ? D.length - 1 : S.length - 1;
    const f = (i: number, k: number) => (axis === 0 ? G[k][i] : G[i][k]);
    const ar = (i: number, k: number) => (axis === 0 ? cellA(i, k) : cellA(k, i));
    let bestE = Infinity, bestDrop = -1;
    for (const drop of [worst, worst + 1]) {
      if (L[drop].forced && !(L[worst].forced && L[worst + 1].forced)) continue;
      let e = 0;
      const last = L.length - 1;
      for (let k = 0; k < nOther; k++) {
        if (drop === 0 || drop === last) { const i = drop === 0 ? 0 : last - 1; e += f(i, k) - errCell(f(i, k), ar(i, k)); }
        else e += errCell(f(drop - 1, k) + f(drop, k), ar(drop - 1, k) + ar(drop, k)) - errCell(f(drop - 1, k), ar(drop - 1, k)) - errCell(f(drop, k), ar(drop, k));
      }
      if (e < bestE - 1e-9) { bestE = e; bestDrop = drop; }
    }
    if (bestDrop < 0) break;
    const last = L.length - 1;
    if (axis === 0) {
      for (const row of G) {
        if (bestDrop === 0) row.shift();
        else if (bestDrop === last) row.pop();
        else { row[bestDrop - 1] += row[bestDrop]; row.splice(bestDrop, 1); }
      }
      S = S.filter((_, i) => i !== bestDrop);
    } else {
      if (bestDrop === 0) G.shift();
      else if (bestDrop === last) G.pop();
      else { const r0 = G[bestDrop - 1], r1 = G[bestDrop]; for (let i = 0; i < r0.length; i++) r0[i] += r1[i]; G.splice(bestDrop, 1); }
      D = D.filter((_, i) => i !== bestDrop);
    }
  }
  const ns = S.length - 1, nd = D.length - 1;
  const fill = new Float64Array(ns * nd);
  for (let j = 0; j < nd; j++) for (let i = 0; i < ns; i++) fill[j * ns + i] = G[j][i];
  const on = new Uint8Array(ns * nd);
  for (let j = 0; j < nd; j++) for (let i = 0; i < ns; i++) on[j * ns + i] = fill[j * ns + i] >= cellA(i, j) * 0.5 ? 1 : 0;
  // keep the largest connected piece
  const comp = new Int32Array(ns * nd).fill(-1);
  let bestC = -1, bestA = 0, nc = 0;
  for (let k = 0; k < on.length; k++) {
    if (!on[k] || comp[k] >= 0) continue;
    let a = 0;
    const st = [k];
    comp[k] = nc;
    while (st.length) {
      const q = st.pop()!;
      const i = q % ns, j = (q / ns) | 0;
      a += fill[q];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= ns || jj >= nd) continue;
        const r = jj * ns + ii;
        if (on[r] && comp[r] < 0) { comp[r] = nc; st.push(r); }
      }
    }
    if (a > bestA) { bestA = a; bestC = nc; }
    nc++;
  }
  if (bestC < 0) {
    // nothing half full: the best single cell
    let k = 0;
    for (let q = 1; q < fill.length; q++) if (fill[q] > fill[k]) k = q;
    on.fill(0); on[k] = 1; comp[k] = 0; bestC = 0;
  }
  for (let k = 0; k < on.length; k++) if (comp[k] !== bestC) on[k] = 0;
  // cover with the largest rectangles (area in m²)
  const boxes: Box[] = [];
  const gots: number[] = [];
  let inside = 0, boxArea = 0;
  for (let w = 0; w < MAX_WINGS * 2; w++) {
    // past a handful of wings only when much of the footprint is still left (courtyard rings)
    if (w >= MAX_WINGS && area - inside < area * 0.08) break;
    let best: [number, number, number, number] | null = null, bestV = 0;
    for (let j0 = 0; j0 < nd; j0++) for (let i0 = 0; i0 < ns; i0++) {
      if (on[j0 * ns + i0] !== 1) continue;
      let iMax = ns;
      for (let j1 = j0; j1 < nd; j1++) {
        let i1 = i0;
        while (i1 < iMax && on[j1 * ns + i1] === 1) i1++;
        iMax = i1;
        if (iMax === i0) break;
        const v = (S[iMax].c - S[i0].c) * (D[j1 + 1].c - D[j0].c);
        if (v > bestV + 1e-9) { bestV = v; best = [i0, iMax, j0, j1 + 1]; }
      }
    }
    if (!best) break;
    const [i0, i1, j0, j1] = best;
    const b = { s0: S[i0].c, s1: S[i1].c, d0: D[j0].c, d1: D[j1].c };
    // a wing has to be worth drawing
    if (boxes.length && (bestV < Math.max(4, boxArea * 0.04) || Math.min(b.s1 - b.s0, b.d1 - b.d0) < minStrip - 1e-6)) break;
    let got = 0;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { on[j * ns + i] = 2; got += fill[j * ns + i]; }
    inside += got;
    boxes.push(b);
    gots.push(got);
    boxArea += bestV;
  }
  if (!boxes.length) return null;
  // wings that lost their link (a dropped small wing in between, or a corner touch) go
  const keep = linkedWings(boxes);
  if (keep.length < boxes.length) {
    const nb = keep.map((k) => boxes[k]);
    inside = keep.reduce((t, k) => t + gots[k], 0);
    boxArea = nb.reduce((t, b) => t + (b.s1 - b.s0) * (b.d1 - b.d0), 0);
    return { boxes: nb, area, inside, boxArea };
  }
  return { boxes, area, inside, boxArea };
}

// ---------------------------------------------------------------- what kind of building

/** Footprint shape in the building frame (docs/BUILDING_TYPES.md 3a). */
interface Shape {
  area: number;
  /** short and long side of the outline's box, aspect L / W, rect = area / (W x L) */
  W: number;
  L: number;
  aspect: number;
  rect: number;
  nv: number;
  round: boolean;
  lon: number;
  lat: number;
}

/** What groupRows learnt about a building's surroundings. */
interface Ctx {
  /** party-wall neighbours (footprints of 25 m² or more) */
  party: number;
  /** houses in its row (1: not in a row) */
  rowN: number;
  inBlock: boolean;
  oldCore: boolean;
  rural: boolean;
  /** buildings within 45 m, and round ones within 150 m */
  cluster45: number;
  roundNear: number;
  /** buildings of 800 m² or more within 150 m (industrial estates), and big glass-like boxes */
  bigNear: number;
  glassNear: number;
  /** buildings tagged industrial, warehouse, commercial or retail within 150 m */
  indNear: number;
  /** buildings tagged house within 100 m */
  houseNear: number;
  /** the wall it shares with a bigger building (world texels x0 y0 x1 y1): lean-tos rise against it */
  lean?: number[];
}

const NO_CTX: Ctx = { party: 0, rowN: 1, inBlock: false, oldCore: false, rural: false, cluster45: 0, roundNear: 0, bigNear: 0, glassNear: 0, indNear: 0, houseNear: 0 };

/** classes chunkgen takes from a POI inside the footprint: a ground-floor use, not a form */
const POI_USE = new Set(['shop', 'food_service', 'pharmacy', 'grocery', 'hardware', 'outdoor', 'fuel', 'medical', 'mechanic']);
const SHOP_USE = new Set(['shop', 'food_service', 'pharmacy', 'grocery', 'hardware', 'outdoor', 'retail', 'supermarket', 'mechanic']);
const HOME_TYPES = new Set<BuildingType>(['terrace', 'semi', 'detached', 'bungalow', 'canal_house', 'block_bay', 'farmhouse', 'chalet']);
const ROW_TYPES = new Set<BuildingType>(['terrace', 'semi', 'detached', 'bungalow', 'canal_house', 'block_bay', 'farmhouse', 'apartments', 'commercial', 'portiekflat']);

function formAndUse(inp: ModelInput): { form: string; use: string } {
  if (inp.use !== undefined) return { form: inp.cls, use: inp.use };
  if (POI_USE.has(inp.cls)) return { form: 'other', use: inp.cls };
  if (inp.cls === 'retail' || inp.cls === 'supermarket') return { form: inp.cls, use: inp.cls === 'supermarket' ? 'grocery' : 'shop' };
  return { form: inp.cls, use: '' };
}

/** Detection rules of docs/BUILDING_TYPES.md 3b: first match wins. */
function typeOf(inp: ModelInput, sh: Shape, cx: Ctx): BuildingType {
  const { form, use } = formAndUse(inp);
  const raw = inp.raw ?? '', lu = inp.lu ?? '';
  const A = sh.area, lv = inp.levels ?? 0;
  if (sh.round) {
    if (A >= 150 && (lu === 'industrial' || lu === 'port' || cx.roundNear >= 3)) return 'tank';
    if (A >= 50 && A <= 250 && cx.cluster45 <= 2 && cx.bigNear === 0) return 'windmill';
    if (A < 150 && cx.rural) return 'silo';
  }
  if (raw === 'houseboat' || (inp.inWater && sh.aspect > 2.5 && A < 200)) return 'houseboat';
  if (raw === 'static_caravan' || raw === 'cabin') return 'chalet';
  if (form === 'greenhouse' || raw === 'greenhouse' || (A >= 1500 && sh.rect > 0.9 && (lu === 'greenhouse_horticulture' || form === 'farm'))
    || (A >= 4000 && sh.rect > 0.92 && cx.party === 0 && (cx.rural || (cx.glassNear >= 2 && cx.indNear * 3 <= cx.glassNear)))) return 'greenhouse';
  if (form === 'church' || lu === 'religious') return A < 40 ? 'garden_shed' : 'church';
  if (raw === 'roof' || (A >= 120 && A <= 700 && use === 'fuel')) return 'canopy';
  if (use === 'fuel') return 'petrol';
  if (raw === 'train_station' || raw === 'transportation') return 'station';
  if (form === 'hospital' || (use === 'medical' && A >= 3000)) return 'hospital';
  if (form === 'police') return 'police';
  if (form === 'fire_station') return 'fire_station';
  if ((form === 'school' && (A >= 300 || /school|college|university|kindergarten/.test(raw))) || (lu === 'education' && A >= 200)) return 'school';
  if ((use === 'grocery' || form === 'supermarket') && A >= 700) return 'supermarket';
  if (SHOP_USE.has(use) && A >= 1500 && !cx.inBlock) return 'retail_box';
  if (form === 'industrial' || form === 'warehouse' || (form === 'commercial' && A >= 800) || (use === 'mechanic' && A >= 300)
    || (A >= 800 && sh.rect > 0.85 && (lu === 'industrial' || lu === 'port' || lu === 'commercial'))) {
    if (A < 15) return 'garden_shed';
    if (A < 40) return 'annex';
    if (A >= 10000) return 'distribution_centre';
    if (sh.aspect > 4 && sh.W <= 20 && cx.rural) return 'animal_shed';
    return lv >= 3 && A < 1500 ? 'office' : 'hall';
  }
  if (form === 'office' || (A >= 500 && lv >= 4 && form !== 'apartments' && form !== 'residential' && form !== 'house')) return 'office';
  if (form === 'garage' || form === 'shed') {
    if (A < 15) return 'garden_shed';
    if (A < 60) return form === 'garage' ? 'garage_box' : 'annex';
    return A >= 300 ? 'hall' : 'barn';
  }
  // farmsteads: out in the country, free-standing, on a farmyard or among a handful of buildings
  if (cx.rural && cx.party === 0 && (lu === 'farmyard' || form === 'farm' || (cx.cluster45 >= 1 && cx.cluster45 <= 7))) {
    if (A >= 1000 && sh.aspect >= 1.5 && sh.aspect <= 3.5) return 'cow_shed';
    if (A >= 500 && sh.aspect >= 4 && sh.W <= 22) return 'animal_shed';
    if (A >= 200 && A <= 700 && sh.aspect < 1.25 && sh.rect > 0.85 && sh.lon < 5.3 && sh.lat > 52.45) return 'stolp';
    if (A >= 450 && A <= 1600 && sh.aspect >= 2 && sh.aspect <= 4.5 && (sh.rect < 0.9 || sh.lat > 52.85)) return 'kop_hals_romp';
    if (A >= 150 && A <= 500 && sh.aspect >= 1.8 && sh.aspect <= 3.2) return 'long_farm';
    if (A >= 40 && A <= 200) return form === 'farm' ? 'barn' : 'farmhouse';
    if (A > 200) return A >= 1000 ? 'cow_shed' : 'barn';
  }
  if (form === 'farm' && A >= 40) return A >= 1000 ? 'cow_shed' : 'barn';
  if (A < 15) return 'garden_shed';
  if (A < 40) return form === 'garage' || raw === 'garages' ? 'garage_box' : cx.party > 0 && cx.rowN >= 2 ? 'terrace' : 'annex';
  // on an industrial estate an untagged box is a business unit, not a house
  if (cx.bigNear >= 3 && cx.houseNear < 3 && form === 'other' && use === '' && A >= 80 && !cx.rural) return A >= 150 ? 'hall' : 'commercial';
  const homeTag = form === 'apartments' || form === 'residential' || form === 'house' || form === 'other';
  if (form === 'apartments' || form === 'residential' || (homeTag && A >= 200 && cx.inBlock) || (form === 'other' && use === '' && A > 200 && A < 2500 && cx.inBlock)) {
    if (sh.aspect >= 4 && sh.L >= 50) return lv >= 5 || sh.L >= 80 ? 'galerijflat' : 'portiekflat';
    if (A >= 400 && sh.aspect < 2.5 && lv >= 7) return 'tower';
    if (cx.oldCore && sh.W <= 8.5 && sh.aspect >= 1.8) return 'canal_house';
    if (cx.inBlock) return 'block_bay';
    if (A <= 200 && cx.rowN >= 3) return 'terrace';
    if (A <= 200 && cx.rowN === 2) return 'semi';
    return 'apartments';
  }
  if (A <= 260) {
    if (cx.oldCore && cx.inBlock && sh.W <= 8.5) return 'canal_house';
    if (cx.rowN >= 3 && !cx.inBlock) return 'terrace';
    if (cx.inBlock) return 'block_bay';
    if (cx.rowN === 2) return 'semi';
    if (cx.party > 0) return 'terrace';
    if (A <= 110 && (raw === 'bungalow' || lv === 1)) return 'bungalow';
    return 'detached';
  }
  if (form === 'civic') return 'office';
  return 'commercial';
}

const KIND: Record<BuildingType, BuildingKind> = {
  terrace: 'house', semi: 'house', detached: 'house', bungalow: 'house', canal_house: 'townhouse', block_bay: 'townhouse',
  portiekflat: 'block', galerijflat: 'block', apartments: 'block', tower: 'block', houseboat: 'shed', chalet: 'house',
  supermarket: 'block', retail_box: 'block', office: 'block', school: 'block', church: 'church', hospital: 'block', police: 'block',
  fire_station: 'block', station: 'block', petrol: 'block', canopy: 'canopy', commercial: 'block',
  hall: 'hall', distribution_centre: 'hall', greenhouse: 'greenhouse', cow_shed: 'barn', animal_shed: 'barn', stolp: 'barn',
  kop_hals_romp: 'barn', long_farm: 'barn', farmhouse: 'house', barn: 'barn',
  garden_shed: 'shed', annex: 'shed', garage_box: 'garage', tank: 'canopy', silo: 'canopy', windmill: 'canopy',
};

interface Spec {
  storeys: number;
  storeyH: number;
  roof: RoofKind;
  /** roof rise as a share of the span */
  rise: number;
  /** ridge along the long side, parallel to the street, or across it (gable to the street) */
  ridge: 'long' | 'street' | 'cross';
  /** window spacing along a wall (0: none) and window width */
  pitch: number;
  winW: number;
  /** windows only on the ground storey (tall single-storey spaces) */
  oneRow?: boolean;
}

function specOf(t: BuildingType, sh: Shape, inp: ModelInput, cx: Ctx, r: (n: number, salt: number) => number): Spec {
  const lv = inp.levels && inp.levels > 0 ? Math.max(1, Math.min(60, Math.round(inp.levels))) : 0;
  const pick = (a: number, b: number) => a + r(b - a + 1, 31);
  // levels from a height tag count the roof space of pitched houses as a storey
  const pitched = (def: number, max = 4) => (lv ? Math.max(1, Math.min(lv >= 3 ? lv - 1 : lv, max)) : def);
  const S = (storeys: number, storeyH: number, roof: RoofKind, rise: number, ridge: Spec['ridge'], pitch: number, winW: number, oneRow = false): Spec =>
    ({ storeys, storeyH, roof, rise, ridge, pitch, winW, oneRow });
  switch (t) {
    case 'terrace': return S(pitched(2), 3, 'gable', 0.48, 'street', 2.3, 1.1);
    case 'semi': return S(pitched(2), 3, 'hip', 0.48, 'street', 2.3, 1.1);
    case 'detached': case 'farmhouse': return S(pitched(2), 3, sh.aspect < 1.4 ? 'hip' : 'gable', 0.5, 'long', 2.4, 1.1);
    case 'bungalow': return S(1, 3, r(2, 32) ? 'hip' : 'flat', 0.3, 'long', 2.4, 1.2);
    case 'canal_house': return S(pitched(sh.L >= 14 ? pick(4, 5) : 4, 6), 3.1, 'gable', 0.8, 'cross', 2.2, 1.1);
    case 'block_bay': return S(pitched(3, 5), 3, 'gable', 0.45, 'street', 2.4, 1.1);
    case 'portiekflat': return S(lv || 4, 2.9, 'flat', 0, 'long', 3.3, 1.6);
    case 'galerijflat': return S(lv || pick(5, 10), 2.9, 'flat', 0, 'long', 3.3, 1.6);
    case 'apartments': return S(lv || pick(4, 5), 3, 'flat', 0, 'long', 2.8, 1.4);
    case 'tower': return S(lv || pick(10, 16), 3, 'flat', 0, 'long', 2.8, 1.6);
    case 'houseboat': return S(1, 2.6, 'flat', 0, 'long', 2.5, 1.0);
    case 'chalet': return S(1, 2.6, 'gable', 0.3, 'long', 2.6, 1.0);
    case 'supermarket': return S(1, 6.5, 'flat', 0, 'long', 0, 2, true);
    case 'retail_box': return S(1, 7, 'flat', 0, 'long', 0, 2, true);
    case 'office': return S(lv || pick(3, 6), 3.3, 'flat', 0, 'long', 1.8, 1.5);
    case 'school': return cx.oldCore ? S(lv || 3, 3.6, 'hip', 0.4, 'long', 2.2, 1.5) : S(lv || 2, 3.5, 'flat', 0, 'long', 1.8, 1.6);
    case 'church': return S(1, Math.max(8, Math.min(14, sh.W * 0.6)), 'gable', 0.85, 'long', 4.5, 1.4, true);
    case 'hospital': return S(lv || pick(3, 6), 3.3, 'flat', 0, 'long', 2.4, 1.4);
    case 'police': return S(lv || pick(2, 3), 3.2, 'flat', 0, 'long', 2.4, 1.4);
    case 'fire_station': return S(lv || 2, 4, 'flat', 0, 'long', 3, 1.4);
    case 'station': return S(lv || 2, 4, 'hip', 0.35, 'long', 3, 1.6);
    case 'petrol': return S(1, 3.5, 'flat', 0, 'long', 0, 2, true);
    case 'canopy': return S(1, 4.5, 'flat', 0, 'long', 0, 0, true);
    case 'commercial': return S(lv || pick(1, 2), 3.5, 'flat', 0, 'long', 3, 1.8);
    case 'hall': return S(1, sh.area < 500 ? 6 : sh.area < 2000 ? 8 : sh.area < 10000 ? 10 : 12, sh.area <= 1000 ? 'gable' : 'flat', 0.15, 'long', 7, 2.2, true);
    case 'distribution_centre': return S(1, 12, 'flat', 0, 'long', 0, 0, true);
    case 'greenhouse': return S(1, 6, 'gable', 0, 'long', 0, 0, true);
    case 'cow_shed': return S(1, 4, 'gable', 0.2, 'long', 0, 0, true);
    case 'animal_shed': return S(1, 3.5, 'gable', 0.15, 'long', 6, 0.8, true);
    case 'stolp': return S(1, 3, 'hip', 0.8, 'long', 3, 1.0, true);
    case 'kop_hals_romp': return S(1, 4, 'hip', 0.6, 'long', 4, 1.0, true);
    case 'long_farm': return S(1, 3.5, r(5, 33) < 2 ? 'hip' : 'gable', 0.55, 'long', 3.5, 1.0, true);
    case 'barn': return S(1, 5, 'gable', 0.45, 'long', 6, 1.0, true);
    case 'garden_shed': return S(1, 2.2, r(2, 34) ? 'flat' : 'shed', 0.15, 'long', 0, 0, true);
    case 'annex': return S(1, 2.8, cx.lean ? 'shed' : 'flat', 0.15, 'long', 3, 1.0, true);
    case 'garage_box': return S(1, 2.5, 'flat', 0, 'long', 0, 0, true);
    case 'tank': return S(1, Math.max(8, Math.min(25, Math.sqrt(sh.area) * 0.8)), 'flat', 0, 'long', 0, 0, true);
    case 'silo': return S(1, 18, 'flat', 0, 'long', 0, 0, true);
    case 'windmill': return S(1, 20, 'flat', 0, 'long', 0, 0, true);
  }
}

// ---------------------------------------------------------------- assembling a model

/** What groupRows decided for a member of a row. */
interface RowCtx {
  id: string;
  style: number;
  /** the main ridge runs along s */
  ridgeAlongS: boolean;
  storeys: number;
  roofH: number;
  /** roof variant shared by the row (Vinex ensembles), or null for the type's own */
  roof: RoofKind | null;
  /** the shed roof's high side faces the street */
  /** door at the start (false) or end (true) of the front, so pairs mirror */
  doorEnd: boolean | null;
}

interface Opts {
  frame?: Frame;
  forcedS?: number[];
  forcedD?: number[];
  /** shared wall segments with neighbours, world texels [x0, y0, x1, y1] */
  shared?: number[][];
  row?: RowCtx;
  ctx?: Ctx;
  /** depth alignment: snap the main wing's d0/d1 (or s0/s1) to these, frame metres */
  align?: { along: 0 | 1; lo?: number; hi?: number };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function frameOf(inp: ModelInput): Frame {
  const outer = inp.rings[0];
  const [ux, uy] = dominantAxis(outer);
  return { ux, uy, rx: outer[0], ry: outer[1], k: inp.tpm };
}

function shapeOf(reg: Regular, f: Frame): Shape {
  const e = reg.ext!;
  const a = e.s1 - e.s0, b = e.d1 - e.d0;
  const W = Math.min(a, b), L = Math.max(a, b);
  const rect = W * L > 0 ? reg.area / (W * L) : 1;
  const aspect = W > 0 ? L / W : 1;
  const ll = worldToLonLat(f.rx, f.ry);
  return { area: reg.area, W, L, aspect, rect, nv: reg.nv ?? 4, round: (reg.nv ?? 0) >= 10 && rect > 0.72 && rect < 0.83 && aspect < 1.12, lon: ll.lon, lat: ll.lat };
}

/** shapes of the models built here, so groupRows can retype them without redrawing */
const shapes = new WeakMap<BuildingModel, Shape>();

function assemble(inp: ModelInput, o: Opts = {}): BuildingModel | null {
  const outer = inp.rings[0];
  if (!outer || outer.length < 6) return null;
  const f = o.frame ?? frameOf(inp);
  const reg = regularise(inp.rings, f, o.forcedS, o.forcedD);
  if (!reg) return null;
  const sh = shapeOf(reg, f);
  let boxes = reg.boxes.map((b) => ({ ...b }));
  let radius: number | undefined;
  if (sh.round) {
    // one body: the equal-area square around the outline's centre; the renderer draws the circle
    const e = reg.ext!;
    const cs = (e.s0 + e.s1) / 2, cd = (e.d0 + e.d1) / 2, h = Math.sqrt(reg.area) / 2;
    radius = Math.sqrt(reg.area / Math.PI);
    boxes = [{ s0: cs - h, s1: cs + h, d0: cd - h, d1: cd + h }];
  }
  if (o.align) {
    alignMain(boxes, o.align);
    boxes = linkedWings(boxes).map((k) => boxes[k]);
  }
  // frame origin at the wings' min corner
  let S0 = Infinity, D0 = Infinity;
  for (const b of boxes) { S0 = Math.min(S0, b.s0); D0 = Math.min(D0, b.d0); }
  boxes = boxes.map((b) => ({ s0: b.s0 - S0, s1: b.s1 - S0, d0: b.d0 - D0, d1: b.d1 - D0 }));
  const k = f.k;
  const m: BuildingModel = {
    id: inp.id, cls: inp.cls, seed: inp.seed, burnt: inp.burnt,
    ox: f.rx + (S0 * f.ux - D0 * f.uy) * k, oy: f.ry + (S0 * f.uy + D0 * f.ux) * k, ux: f.ux, uy: f.uy, tpm: k,
    wings: boxes.map((box) => ({ box, roof: 'flat', ridgeAlongS: true, wallH: 3, roofH: 0 })),
    openings: [], storeys: 1, row: o.row?.id ?? '', style: o.row?.style ?? inp.seed, party: [], src: inp,
  };
  if (radius !== undefined) m.radius = radius;
  if (o.shared?.length) m.party = partySpans(m, o.shared);
  dress(m, inp, sh, o.ctx ?? NO_CTX, o.row);
  shapes.set(m, sh);
  return m;
}

function alignMain(boxes: Box[], al: NonNullable<Opts['align']>) {
  const m = boxes[0];
  const k0 = al.along === 0 ? 'd0' : 's0', k1 = al.along === 0 ? 'd1' : 's1';
  const tryMove = (key: 'd0' | 'd1' | 's0' | 's1', v: number) => {
    const old = m[key];
    if (Math.abs(v - old) < 1e-6) return;
    m[key] = v;
    const bad = m.s1 - m.s0 < 1.5 || m.d1 - m.d0 < 1.5 || boxes.some((b, i) => i > 0 && overlap(b, m));
    if (bad) m[key] = old;
    else {
      // wings that touched the moved side follow it
      for (let i = 1; i < boxes.length; i++) {
        const b = boxes[i];
        if (key === 'd0' && Math.abs(b.d1 - old) < 0.02) b.d1 = v;
        if (key === 'd1' && Math.abs(b.d0 - old) < 0.02) b.d0 = v;
        if (key === 's0' && Math.abs(b.s1 - old) < 0.02) b.s1 = v;
        if (key === 's1' && Math.abs(b.s0 - old) < 0.02) b.s0 = v;
        if (b.s1 - b.s0 < 1 || b.d1 - b.d0 < 1) { boxes.splice(i, 1); i--; }
      }
    }
  };
  if (al.lo !== undefined) tryMove(k0, al.lo);
  if (al.hi !== undefined) tryMove(k1, al.hi);
}

const overlap = (a: Box, b: Box) => Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0) > 1e-6 && Math.min(a.d1, b.d1) - Math.max(a.d0, b.d0) > 1e-6;

/** Wing sides that lie along shared wall segments. */
function partySpans(m: BuildingModel, shared: number[][]): PartySpan[] {
  const out: PartySpan[] = [];
  for (const seg of shared) {
    const [a0, a1] = toFrame(m, seg[0], seg[1]);
    const [b0, b1] = toFrame(m, seg[2], seg[3]);
    const alongS = Math.abs(b0 - a0) >= Math.abs(b1 - a1);
    m.wings.forEach((w, wi) => {
      const b = w.box;
      for (const side of [0, 1, 2, 3] as const) {
        if ((side === 0 || side === 2) !== alongS) continue;
        const c = side === 0 ? b.d0 : side === 1 ? b.s1 : side === 2 ? b.d1 : b.s0;
        const mid = alongS ? (a1 + b1) / 2 : (a0 + b0) / 2;
        if (Math.abs(mid - c) > 0.8) continue;
        const lo = alongS ? Math.min(a0, b0) : Math.min(a1, b1), hi = alongS ? Math.max(a0, b0) : Math.max(a1, b1);
        const base = alongS ? b.s0 : b.d0, L = sideLength(b, side);
        const p = Math.max(0, lo - base - 0.3), q = Math.min(L, hi - base + 0.3);
        if (q - p > 0.5) out.push({ wing: wi, side, a: p < 0.5 ? 0 : p, b: q > L - 0.5 ? L : q });
      }
    });
  }
  return out;
}

const OPP = [2, 3, 0, 1] as const;

/** Type, roofs, heights, door and windows. */
function dress(m: BuildingModel, inp: ModelInput, sh: Shape, cx: Ctx, row?: RowCtx) {
  const ws = m.wings;
  const main = ws[0];
  const seed = inp.seed;
  const r = (n: number, salt: number) => (((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 7) % n);
  // a row shares one look: decide its variants from the row's style
  const rr = (n: number, salt: number) => ((((row ? row.style : seed) ^ Math.imul(salt, 0x85ebca6b)) >>> 9) % n);
  const t = typeOf(inp, sh, cx);
  const sp = specOf(t, sh, inp, cx, r);
  const { use } = formAndUse(inp);
  const shop = SHOP_USE.has(use) && (HOME_TYPES.has(t) || t === 'apartments' || t === 'portiekflat' || t === 'tower' || t === 'commercial' || t === 'office' || t === 'supermarket' || t === 'retail_box' || t === 'galerijflat');
  m.type = t;
  m.kind = KIND[t];
  if (row && (HOME_TYPES.has(t) || t === 'apartments')) sp.storeys = row.storeys;
  m.storeys = sp.storeys;
  delete m.gable; delete m.thatch; delete m.open;
  if (t === 'canopy') m.open = true;
  if (t === 'canal_house') m.gable = (['step', 'neck', 'bell', 'spout', 'cornice'] as const)[r(5, 40)];

  // party sides
  for (const w of ws) { w.party = [false, false, false, false]; delete w.high; delete w.hipEnds; delete w.ridges; }
  for (const p of m.party ?? []) {
    const w = ws[p.wing];
    const L = sideLength(w.box, p.side);
    const tot = (m.party ?? []).filter((q) => q.wing === p.wing && q.side === p.side).reduce((t2, q) => t2 + q.b - q.a, 0);
    if (tot >= L * 0.5) w.party![p.side] = true;
  }

  // the street side: the outside wall nearest the door
  const [dx, dy] = toFrame(m, inp.door.x, inp.door.y);
  const dn = [inp.door.nx * m.ux + inp.door.ny * m.uy, -inp.door.nx * m.uy + inp.door.ny * m.ux];
  type Front = { wing: number; side: 0 | 1 | 2 | 3; at: number; span: [number, number] };
  let front: Front | null = null;
  let bestD = Infinity;
  ws.forEach((w, wi) => {
    for (const side of [0, 1, 2, 3] as const) {
      const b = w.box;
      const nrm = side === 0 ? [0, -1] : side === 1 ? [1, 0] : side === 2 ? [0, 1] : [-1, 0];
      for (const span of outerSpans(m, wi, side)) {
        if (span[1] - span[0] < 1.2) continue;
        const alongS = side === 0 || side === 2;
        const base = alongS ? b.s0 : b.d0;
        const at = clamp((alongS ? dx : dy) - base, span[0] + 0.6, span[1] - 0.6);
        const px = alongS ? base + at : side === 1 ? b.s1 : b.s0;
        const py = alongS ? (side === 0 ? b.d0 : b.d1) : base + at;
        // distance, plus a penalty for facing away from the street
        const dist = Math.hypot(px - dx, py - dy) + (1 - (nrm[0] * dn[0] + nrm[1] * dn[1])) * 3 + (wi === 0 ? 0 : 1);
        if (dist < bestD) { bestD = dist; front = { wing: wi, side, at, span }; }
      }
    }
  });
  const fr = front as Front | null;
  const mW = main.box.s1 - main.box.s0, mD = main.box.d1 - main.box.d0;
  const frontAlongS = fr ? fr.side === 0 || fr.side === 2 : mW >= mD;
  const longS = (w: Wing) => w.box.s1 - w.box.s0 >= w.box.d1 - w.box.d0;
  const span = (w: Wing) => (w.ridgeAlongS ? w.box.d1 - w.box.d0 : w.box.s1 - w.box.s0);

  // --- main roof
  main.wallH = sp.storeys * sp.storeyH;
  main.storeys = sp.oneRow ? 1 : sp.storeys;
  main.roof = sp.roof;
  main.ridgeAlongS = sp.ridge === 'long' ? longS(main) : sp.ridge === 'street' ? frontAlongS : !frontAlongS;
  if (row && HOME_TYPES.has(t)) main.ridgeAlongS = row.ridgeAlongS;
  else if (HOME_TYPES.has(t) && t !== 'canal_house') {
    // between party walls the ridge runs from one to the other
    const p = main.party!;
    if ((p[1] || p[3]) && !(p[0] || p[2])) main.ridgeAlongS = true;
    else if ((p[0] || p[2]) && !(p[1] || p[3])) main.ridgeAlongS = false;
  }
  if (t === 'detached' || t === 'farmhouse') {
    // a long house with its narrow end to the street turns the gable to it
    if (main.roof === 'gable' && cx.party === 0) main.ridgeAlongS = longS(main);
    if (cx.rural && sh.area >= 120 && r(4, 41) === 0) { m.thatch = true; sp.rise = 0.62; }
  }
  if (t === 'long_farm' && r(10, 42) < 3) { m.thatch = true; sp.rise = 0.62; }
  main.roofH = main.roof === 'flat' ? 0 : main.roof === 'mansard' ? 3 : clamp(span(main) * sp.rise, 1, t === 'church' ? 16 : 9);
  if (t === 'bungalow' && main.roof === 'flat') main.roofH = 0;
  if (t === 'block_bay') {
    // pre-war blocks: a steep front slope with a flat top, or a plain gable, per block
    if (rr(5, 43) < 3) { main.roof = 'mansard'; main.roofH = 3; }
  }
  if (t === 'greenhouse') {
    // Venlo greenhouse: small glass ridges about 4 m apart along the long side
    main.ridgeAlongS = longS(main);
    main.ridges = Math.max(1, Math.round(span(main) / 4));
    main.roofH = 0.9;
  }
  if (row && HOME_TYPES.has(t)) {
    main.roofH = row.roofH;
    if (row.roof) main.roof = row.roof;
    if (main.roof === 'mansard') main.roofH = 3;
    if (main.roof === 'flat') main.roofH = 0;
  }
  if (main.roof === 'shed') {
    main.roofH = clamp(span(main) * (HOME_TYPES.has(t) ? 0.3 : 0.15), 0.4, 3);
    // a lean-to rises against what it leans on; a house's mono-pitch faces the street
    let hi: 0 | 1 | 2 | 3 = fr ? fr.side : main.ridgeAlongS ? 2 : 1;
    if (cx.lean) hi = nearestSide(m, 0, cx.lean) ?? hi;
    const pw = main.party!.findIndex(Boolean);
    if (!HOME_TYPES.has(t) && pw >= 0) hi = pw as 0 | 1 | 2 | 3;
    main.high = hi;
    main.ridgeAlongS = hi === 0 || hi === 2;
  }
  // flat roofs on everything big, except where the big roof is the point
  if (sh.area > 1000 && t !== 'church' && t !== 'cow_shed' && t !== 'greenhouse' && t !== 'kop_hals_romp') { main.roof = 'flat'; main.roofH = 0; delete main.ridges; }

  // --- wings
  const mainTop = main.wallH + main.roofH;
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i];
    const b = w.box;
    // the earlier wing it hangs on, and on which of its own sides
    let parent = 0, pside: 0 | 1 | 2 | 3 = 0, plen = -1;
    for (let j = 0; j < i; j++) for (const side of [0, 1, 2, 3] as const) {
      const iv = touchInterval(b, side, ws[j].box);
      if (iv && iv[1] - iv[0] > plen) { plen = iv[1] - iv[0]; parent = j; pside = side; }
    }
    const P = ws[parent];
    const wArea = (b.s1 - b.s0) * (b.d1 - b.d0), pArea = (P.box.s1 - P.box.s0) * (P.box.d1 - P.box.d0);
    const reach = pside === 0 || pside === 2 ? b.d1 - b.d0 : b.s1 - b.s0;
    const across = pside === 0 || pside === 2 ? b.s1 - b.s0 : b.d1 - b.d0;
    const pitchedMain = main.roof === 'gable' || main.roof === 'hip' || main.roof === 'mansard';
    const toward = fr && fr.wing === i;
    w.storeys = main.storeys;
    w.wallH = main.wallH;
    w.ridgeAlongS = pside === 1 || pside === 3; // runs away from the parent
    w.roof = 'flat'; w.roofH = 0;
    const gableWing = (rise: number, cap: number) => {
      w.roof = 'gable';
      const s2 = w.ridgeAlongS ? b.d1 - b.d0 : b.s1 - b.s0;
      w.roofH = Math.min(clamp(s2 * rise, 1, cap), Math.max(0, mainTop - w.wallH - 0.4));
      if (w.roofH < 1) { w.roof = 'flat'; w.roofH = 0; }
    };
    if (HOME_TYPES.has(t)) {
      // wings under 40 m² on a house are an aanbouw: one storey, flat or a lean-to
      const ext = wArea < 40 || wArea < pArea * 0.35 || reach <= 4 || across < 3.5;
      if (ext || !pitchedMain) {
        w.storeys = ext ? 1 : w.storeys;
        w.wallH = w.storeys * sp.storeyH;
        if (ext && r(3, 10 + i) === 0 && !toward) {
          w.roof = 'shed'; w.high = pside; w.roofH = clamp(reach * 0.2, 0.4, 1.2);
          w.ridgeAlongS = pside === 0 || pside === 2;
        }
      } else gableWing(0.5, 7);
    } else if (t === 'church' || t === 'stolp' || t === 'kop_hals_romp' || t === 'long_farm' || t === 'barn' || t === 'cow_shed') {
      w.wallH = Math.min(main.wallH, t === 'church' ? main.wallH * 0.7 : 3.5);
      w.storeys = 1;
      gableWing(t === 'church' ? 0.8 : 0.5, t === 'church' ? 12 : 8);
    } else {
      if (wArea < pArea * 0.2 && wArea < 40) { w.storeys = 1; w.wallH = Math.min(main.wallH, Math.max(2.6, sp.storeyH)); }
      if (m.kind === 'hall') { w.storeys = Math.min(2, Math.max(1, Math.round(w.wallH / 3.3))); if (wArea < pArea * 0.3) { w.wallH = Math.min(main.wallH, 6.6); w.storeys = 2; } }
      if (sp.oneRow && m.kind !== 'hall') w.storeys = 1;
    }
  }
  // hips stop at party walls: that end stays a plain gable against the neighbour
  for (const w of ws) {
    if (w.roof !== 'hip') continue;
    const [a, b] = w.ridgeAlongS ? [3, 1] : [0, 2];
    w.hipEnds = [!w.party![a], !w.party![b]];
    if (!w.hipEnds[0] && !w.hipEnds[1]) { w.roof = 'gable'; delete w.hipEnds; }
  }

  // --- openings
  m.openings = openingsOf(m, t, sp, fr, shop, row, cx, r);
}

/** The side of wing wi that lies along a world segment, if any. */
function nearestSide(m: BuildingModel, wi: number, seg: number[]): 0 | 1 | 2 | 3 | null {
  const [a0, a1] = toFrame(m, (seg[0] + seg[2]) / 2, (seg[1] + seg[3]) / 2);
  const b = m.wings[wi].box;
  const dists = [Math.abs(a1 - b.d0), Math.abs(a0 - b.s1), Math.abs(a1 - b.d1), Math.abs(a0 - b.s0)];
  let best = 0;
  for (let i = 1; i < 4; i++) if (dists[i] < dists[best]) best = i;
  return dists[best] < 1.5 ? (best as 0 | 1 | 2 | 3) : null;
}

/** Doors, shopfronts, garage and dock doors, and windows on a regular rhythm. */
function openingsOf(m: BuildingModel, t: BuildingType, sp: Spec, fr: { wing: number; side: 0 | 1 | 2 | 3; at: number; span: [number, number] } | null,
  shop: boolean, row: RowCtx | undefined, cx: Ctx, r: (n: number, salt: number) => number): Opening[] {
  const ws = m.wings;
  const ops: Opening[] = [];
  const slots = (a: number, b: number, pitch: number, ww: number) => {
    const L = b - a;
    if (pitch <= 0 || L < ww + 1.2) return [];
    let n = Math.max(1, Math.round(L / pitch));
    while (n > 1 && L / n < ww + 0.7) n--;
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(a + ((i + 0.5) * L) / n);
    return out;
  };
  const add = (wing: number, side: 0 | 1 | 2 | 3, at: number, w: number, kind: Opening['kind'], storey?: number) => {
    // every opening stays on its wall
    const L = sideLength(ws[wing].box, side);
    w = Math.min(w, L - 0.2);
    if (w < 0.5) return;
    at = clamp(at, w / 2 + 0.1, L - w / 2 - 0.1);
    ops.push(storey === undefined ? { wing, side, at, w, kind } : { wing, side, at, w, kind, storey });
  };
  // the house-bay facade (terraces, semis, block bays, canal houses): door at one side,
  // one wide window beside it, two (three) windows on each floor above
  const bay = (wing: number, side: 0 | 1 | 2 | 3, a: number, b: number, door: boolean, doorEnd: boolean) => {
    const L = b - a, n = ws[wing].storeys ?? 1;
    const up = Math.min(L > 7.5 ? 3 : 2, Math.floor(L / (sp.winW + 0.5)));
    const dAt = doorEnd ? b - 0.9 : a + 0.9;
    if (door) add(wing, side, dAt, 1.0, 'door');
    if (shop) add(wing, side, door ? (doorEnd ? (a + b - 1.8) / 2 : (a + b + 1.8) / 2) : (a + b) / 2, Math.max(1.2, L - (door ? 2.6 : 1.0)), 'shopfront');
    else {
      const g0 = door ? (doorEnd ? a + 0.6 : a + 1.8) : a + 0.7, g1 = door ? (doorEnd ? b - 1.8 : b - 0.6) : b - 0.7;
      if (g1 - g0 >= 1.0) add(wing, side, (g0 + g1) / 2, Math.min(2.6, g1 - g0), 'window', 0);
    }
    for (let st = 1; st < n; st++) for (let i = 0; i < up; i++) add(wing, side, a + ((i + 0.5) * L) / up, sp.winW, 'window', st);
  };
  const done = new Set<string>();
  const homeBay = t === 'terrace' || t === 'semi' || t === 'block_bay' || t === 'canal_house' || (t === 'detached' && fr !== null && fr.span[1] - fr.span[0] <= 8);
  if (fr) {
    const [a, b] = fr.span, L = b - a;
    const near = fr.at - a < b - fr.at;
    const doorEnd = row && row.doorEnd !== null ? row.doorEnd : !near;
    if (homeBay && L <= 10) {
      bay(fr.wing, fr.side, a, b, true, doorEnd);
      done.add(`${fr.wing},${fr.side}`);
      // the back of the bay: no door, the same rhythm
      const back = OPP[fr.side];
      for (const [p, q] of outerSpans(m, fr.wing, back)) if (q - p >= 2.5 && Math.abs((q - p) - L) < 2.5) { bay(fr.wing, back, p, q, false, doorEnd); done.add(`${fr.wing},${back}`); }
    } else {
      // the door takes the window slot nearest to where the map put it
      const sl = slots(a, b, sp.pitch || 2.4, sp.winW || 1.2);
      let at = fr.at;
      if (sl.length) at = sl.reduce((p, c) => (Math.abs(c - fr.at) < Math.abs(p - fr.at) ? c : p));
      at = clamp(at, a + 0.7, b - 0.7);
      switch (t) {
        case 'garage_box': {
          const n = Math.max(1, Math.floor((L - 0.4) / 3));
          for (let i = 0; i < n; i++) add(fr.wing, fr.side, a + ((i + 0.5) * L) / n, Math.min(2.6, L / n - 0.4), 'garage');
          break;
        }
        case 'fire_station': {
          const n = clamp(Math.floor((L - 3) / 4.5), 1, 4);
          for (let i = 0; i < n; i++) add(fr.wing, fr.side, a + 0.5 + ((i + 0.5) * (L - 3)) / n, 3.5, 'garage');
          add(fr.wing, fr.side, b - 1.2, 1.0, 'door');
          break;
        }
        case 'supermarket': case 'retail_box': case 'petrol':
        {
          const sw = Math.min(L - 1, t === 'petrol' ? 3 : 6), c = L >= sw + 1 ? clamp(at, a + sw / 2 + 0.5, b - sw / 2 - 0.5) : (a + b) / 2;
          add(fr.wing, fr.side, c, sw, 'shopfront');
          add(fr.wing, fr.side, c, Math.min(2.0, sw), 'door');
        }
          break;
        case 'portiekflat': case 'galerijflat': {
          // stair doors on a regular beat (portiek) or at the ends (gallery)
          const every = t === 'portiekflat' ? 14 : 30;
          const n = Math.max(1, Math.round(L / every));
          for (let i = 0; i < n; i++) add(fr.wing, fr.side, a + ((i + 0.5) * L) / n, 1.4, 'door');
          break;
        }
        case 'canopy': case 'tank': break;
        default:
          if (shop && L >= 3) add(fr.wing, fr.side, (a + b) / 2, L - 1.0, 'shopfront');
          add(fr.wing, fr.side, at, m.kind === 'hall' || t === 'church' || t === 'school' || t === 'office' || t === 'hospital' ? 1.8 : 1.0, 'door');
          // a detached house sometimes has a garage door at the other end of its front
          if ((t === 'detached' || t === 'farmhouse') && L >= 8 && r(3, 20) === 0) {
            const g = at - a > b - at ? a + 1.8 : b - 1.8;
            if (Math.abs(g - at) > 2.6) add(fr.wing, fr.side, g, 2.5, 'garage');
          }
      }
    }
    // dock doors on a long side of halls; barn doors on the far gable of farms
    if (t === 'hall' || t === 'distribution_centre') {
      const main = ws[0].box, alongS = longS0(main);
      const cands = (alongS ? [0, 2] : [1, 3]) as (0 | 1 | 2 | 3)[];
      const side = cands.includes(fr.side) && fr.wing === 0 ? fr.side : cands[r(2, 50)];
      for (const [p, q] of outerSpans(m, 0, side)) {
        const n = Math.floor((q - p - 6) / 4);
        for (let i = 0; i < n; i++) {
          const at = p + 4 + i * 4 + ((q - p - 6) - n * 4) / 2;
          if (!(fr.wing === 0 && fr.side === side && Math.abs(at - fr.at) < 3)) add(0, side, at, 3, 'garage');
        }
      }
    }
    if (t === 'cow_shed' || t === 'barn' || t === 'long_farm' || t === 'kop_hals_romp' || t === 'stolp' || t === 'animal_shed') {
      const w0 = ws[0], b0 = w0.box;
      const ends = (w0.ridgeAlongS ? [3, 1] : [0, 2]) as (0 | 1 | 2 | 3)[];
      // the gable end farther from the door
      const [ddx, ddy] = [fr.side === 1 ? b0.s1 : fr.side === 3 ? b0.s0 : b0.s0 + fr.at, fr.side === 2 ? b0.d1 : fr.side === 0 ? b0.d0 : b0.d0 + fr.at];
      const far = ends.map((e) => (e === 1 ? Math.abs(ddx - b0.s1) : e === 3 ? Math.abs(ddx - b0.s0) : e === 0 ? Math.abs(ddy - b0.d0) : Math.abs(ddy - b0.d1)));
      const e = far[0] >= far[1] ? ends[0] : ends[1];
      if (!(fr.wing === 0 && fr.side === e)) for (const [p, q] of outerSpans(m, 0, e)) if (q - p >= 4.5) add(0, e, (p + q) / 2, Math.min(4, q - p - 1), 'garage');
    }
  }
  // windows on every outside wall
  // ground-floor windows keep clear of doors, garage doors and shopfronts
  const fixed = ops.slice();
  const blocked = (wi: number, side: number, storey: number, at: number, ww: number) => {
    if (storey > 0) return false;
    for (const o of fixed) {
      if (o.wing !== wi || o.side !== side) continue;
      if (Math.abs(o.at - at) < (o.w + ww) / 2 + (o.kind === 'shopfront' ? 0 : 0.3)) return true;
    }
    return false;
  };
  ws.forEach((w, wi) => {
    const n = sp.oneRow ? 1 : w.storeys ?? 1;
    for (const side of [0, 1, 2, 3] as const) {
      if (done.has(`${wi},${side}`)) continue;
      let pitch = sp.pitch, ww = sp.winW;
      if (!pitch) continue;
      // gable ends of houses get fewer windows; churches only on the long walls
      const gableEnd = (w.roof === 'gable' || w.roof === 'hip') && (side === 0 || side === 2) !== w.ridgeAlongS;
      if (gableEnd && HOME_TYPES.has(t)) pitch = Math.max(pitch, 3.6);
      if (gableEnd && t === 'church') continue;
      if (t === 'annex' && !(fr && fr.wing === wi && fr.side === side)) continue;
      if (w.storeys === 1 && w.wallH < 2.8 && t !== 'annex') { if (HOME_TYPES.has(t)) { pitch = 3; ww = 1.4; } }
      for (const [a, b] of outerSpans(m, wi, side)) {
        const sl = slots(a, b, pitch, ww);
        for (let st = 0; st < n; st++) for (const at of sl) {
          if (blocked(wi, side, st, at, ww)) continue;
          add(wi, side, at, ww, 'window', st);
        }
      }
    }
  });
  void cx;
  return ops;
}

const longS0 = (b: Box) => b.s1 - b.s0 >= b.d1 - b.d0;

/**
 * Square up a footprint into a building: a few clean rectangular wings in the
 * building's own axes, a roof that suits what it is, the door on the street
 * side and windows on a regular rhythm. On its own a building is typed without
 * its surroundings; call groupRows on all models of an area afterwards so
 * terraces, blocks and farmsteads are recognised and share party walls.
 */
export function buildModel(inp: ModelInput): BuildingModel | null {
  return assemble(inp);
}

// ---------------------------------------------------------------- neighbours, rows and blocks

/** Wall segments two outlines share (world texels [x0, y0, x1, y1]): within 0.7 m, parallel. */
function sharedWalls(a: number[], b: number[], tpm: number): number[][] {
  const out: number[][] = [];
  const tol = 0.7 * tpm, minLen = 0.8 * tpm;
  const na = a.length >> 1, nb = b.length >> 1;
  for (let i = 0; i + 1 < na; i++) {
    const ax = a[i * 2], ay = a[i * 2 + 1], bx = a[i * 2 + 2], by = a[i * 2 + 3];
    const l = Math.hypot(bx - ax, by - ay);
    if (l < minLen) continue;
    const ex = (bx - ax) / l, ey = (by - ay) / l;
    for (let j = 0; j + 1 < nb; j++) {
      const cx = b[j * 2], cy = b[j * 2 + 1], dx = b[j * 2 + 2], dy = b[j * 2 + 3];
      const l2 = Math.hypot(dx - cx, dy - cy);
      if (l2 < minLen) continue;
      if (Math.abs(((dx - cx) * ey - (dy - cy) * ex) / l2) > 0.12) continue;
      const dc = Math.abs((cx - ax) * ey - (cy - ay) * ex), dd = Math.abs((dx - ax) * ey - (dy - ay) * ex);
      if (dc > tol || dd > tol) continue;
      const tc = (cx - ax) * ex + (cy - ay) * ey, td = (dx - ax) * ex + (dy - ay) * ey;
      const lo = Math.max(0, Math.min(tc, td)), hi = Math.min(l, Math.max(tc, td));
      if (hi - lo < minLen) continue;
      out.push([ax + ex * lo, ay + ey * lo, ax + ex * hi, ay + ey * hi]);
    }
  }
  return out;
}

function bboxOf(r: number[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]);
    y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
  }
  return [x0, y0, x1, y1];
}

const median = (v: number[]) => {
  const s = v.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

function ringAreaW(r: number[]): number {
  let a = 0;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
  return Math.abs(a / 2);
}

function inRing(x: number, y: number, r: number[]): boolean {
  let c = false;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], yi = r[i * 2 + 1], xj = r[j * 2], yj = r[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const axisDiff = (a: BuildingModel, b: BuildingModel) => {
  let d = Math.abs(Math.atan2(a.uy, a.ux) - Math.atan2(b.uy, b.ux)) % (Math.PI / 2);
  return Math.min(d, Math.PI / 2 - d);
};

/**
 * Finish the buildings of an area together, in place (docs/BUILDING_TYPES.md 3a):
 * - drops duplicate footprints (one whose centre lies inside a bigger one),
 *   removing them from `models`;
 * - finds party walls (footprints of 25 m² or more sharing 2 m of wall);
 * - chains houses side by side along a street into rows (ending at corners),
 *   and marks perimeter blocks (more than 12 joined, or a closed ring);
 * - types every building with that context (terrace, semi, block bay, canal
 *   house, farmstead, ...) and redraws rows in one frame: party walls exactly
 *   on the shared walls, one ridge along the street, one eaves and ridge
 *   height, fronts and backs lined up, one style per row, doors mirrored in
 *   pairs, no windows on party walls.
 *
 * Deterministic: the result for a building depends only on its own data and
 * that of the buildings around it, never on the order of `models`. Pass every
 * building within ~60 m of the area you draw so rows crossing its edge come
 * out the same from both sides.
 */
export function groupRows(models: BuildingModel[]): void {
  if (!models.length) return;
  const sorted = models.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // one model per id
  const uniq: BuildingModel[] = [];
  for (const m of sorted) if (!uniq.length || uniq[uniq.length - 1].id !== m.id) uniq.push(m);
  let list = uniq.filter((m) => m.src);
  const tpm = list[0]?.tpm ?? 1;
  const outer = new Map(list.map((m) => [m, m.src!.rings[0]]));
  const areaW = new Map(list.map((m) => [m, ringAreaW(outer.get(m)!) / (m.tpm * m.tpm)]));
  const bb = new Map(list.map((m) => [m, bboxOf(outer.get(m)!)]));
  const cen = new Map(list.map((m) => { const b = bb.get(m)!; return [m, [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]]; }));
  // grid of bounding boxes so only near pairs are compared
  const cellT = 40 * tpm;
  const gridOf = (ms: BuildingModel[]) => {
    const g = new Map<string, BuildingModel[]>();
    for (const m of ms) {
      const b = bb.get(m)!;
      for (let gy = Math.floor(b[1] / cellT); gy <= Math.floor(b[3] / cellT); gy++)
        for (let gx = Math.floor(b[0] / cellT); gx <= Math.floor(b[2] / cellT); gx++) {
          const key = `${gx},${gy}`;
          let l = g.get(key);
          if (!l) g.set(key, (l = []));
          l.push(m);
        }
    }
    return g;
  };
  const near = (g: Map<string, BuildingModel[]>, m: BuildingModel, pad: number) => {
    const b = bb.get(m)!, out = new Set<BuildingModel>();
    for (let gy = Math.floor((b[1] - pad) / cellT); gy <= Math.floor((b[3] + pad) / cellT); gy++)
      for (let gx = Math.floor((b[0] - pad) / cellT); gx <= Math.floor((b[2] + pad) / cellT); gx++)
        for (const o of g.get(`${gx},${gy}`) ?? []) if (o !== m) out.add(o);
    return out;
  };

  // 1. duplicates: a footprint whose centre lies inside a bigger one goes
  let grid = gridOf(list);
  const drop = new Set<BuildingModel>();
  for (const m of list) {
    const [x, y] = cen.get(m)!;
    const c = outer.get(m)!;
    // the centre of the outline's box may fall outside an L; use a vertex average instead
    let sx = 0, sy = 0;
    const n = c.length >> 1;
    for (let i = 0; i < n; i++) { sx += c[i * 2]; sy += c[i * 2 + 1]; }
    const px = inRing(x, y, c) ? x : sx / n, py = inRing(x, y, c) ? y : sy / n;
    for (const o of near(grid, m, 0)) {
      const ao = areaW.get(o)!, am = areaW.get(m)!;
      if (ao < am || (ao === am && o.id > m.id)) continue;
      if (ao >= 0.5 * am && inRing(px, py, outer.get(o)!)) { drop.add(m); break; }
    }
  }
  if (drop.size) {
    list = list.filter((m) => !drop.has(m));
    for (let i = models.length - 1; i >= 0; i--) if (drop.has(models[i])) models.splice(i, 1);
    grid = gridOf(list);
  }

  // 2. walls shared with neighbours; party walls between real buildings only
  const shared = new Map<BuildingModel, number[][]>(), party = new Map<BuildingModel, BuildingModel[]>();
  const lean = new Map<BuildingModel, number[]>();
  const pairSegs = new Map<string, number[][]>();
  const key = (a: BuildingModel, b: BuildingModel) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
  for (const m of list) {
    for (const o of near(grid, m, 0.7 * tpm)) {
      if (o.id < m.id) continue;
      const b1 = bb.get(m)!, b2 = bb.get(o)!, pad = 0.7 * tpm;
      if (b2[0] > b1[2] + pad || b2[2] < b1[0] - pad || b2[1] > b1[3] + pad || b2[3] < b1[1] - pad) continue;
      const segs = sharedWalls(outer.get(m)!, outer.get(o)!, m.tpm);
      if (!segs.length) continue;
      let len = 0, best = segs[0], bl = 0;
      for (const s of segs) { const l = Math.hypot(s[2] - s[0], s[3] - s[1]); len += l; if (l > bl) { bl = l; best = s; } }
      len /= m.tpm;
      const am = areaW.get(m)!, ao = areaW.get(o)!;
      // a small building leans on a bigger one
      if (am < 40 && ao > am * 1.5 && (!lean.has(m) || bl > segLen(lean.get(m)!))) lean.set(m, best);
      if (ao < 40 && am > ao * 1.5 && (!lean.has(o) || bl > segLen(lean.get(o)!))) lean.set(o, best);
      if (am < 25 || ao < 25 || len < 2 || axisDiff(m, o) > (12 * Math.PI) / 180) continue;
      for (const [x, y] of [[m, o], [o, m]] as const) {
        if (!shared.has(x)) shared.set(x, []);
        shared.get(x)!.push(...segs);
        if (!party.has(x)) party.set(x, []);
        party.get(x)!.push(y);
      }
      pairSegs.set(key(m, o), segs);
    }
  }

  // 3. perimeter blocks: party-wall components of more than 12, or with a closed ring
  const comp = new Map<BuildingModel, number>();
  const compSize: number[] = [], compBlock: boolean[] = [];
  for (const m of list) {
    if (comp.has(m) || !party.has(m)) continue;
    const id = compSize.length;
    const st = [m];
    comp.set(m, id);
    let nodes = 0, edges = 0, quad = 0;
    while (st.length) {
      const x = st.pop()!;
      nodes++;
      // which way its front faces: a perimeter block faces every way
      const dd = x.src!.door;
      quad |= Math.abs(dd.nx) > Math.abs(dd.ny) ? (dd.nx > 0 ? 1 : 2) : dd.ny > 0 ? 4 : 8;
      for (const y of party.get(x) ?? []) {
        edges++;
        if (!comp.has(y)) { comp.set(y, id); st.push(y); }
      }
    }
    compSize.push(nodes);
    let faces = 0;
    for (let q = quad; q; q >>= 1) faces += q & 1;
    // back-to-back rows (fronts two ways) are rows, not a block
    compBlock.push(faces >= 3 && (nodes > 12 || (nodes >= 4 && edges / 2 >= nodes)));
  }

  // 4. rows: houses side by side, same depth, facing the same street; corners end them
  const pre = new Map(list.map((m) => [m, m]));
  const depthOf = (m: BuildingModel) => { const e = shapeLW(m); return e[1]; };
  const links = new Map<BuildingModel, BuildingModel[]>();
  for (const m of list) {
    for (const o of party.get(m) ?? []) {
      if (o.id < m.id) continue;
      if (!ROW_TYPES.has(pre.get(m)!.type!) || !ROW_TYPES.has(pre.get(o)!.type!)) continue;
      if (areaW.get(m)! > 450 || areaW.get(o)! > 450) continue;
      const segs = pairSegs.get(key(m, o))!;
      let best = segs[0], bl = 0;
      for (const s of segs) { const l = Math.hypot(s[2] - s[0], s[3] - s[1]); if (l > bl) { bl = l; best = s; } }
      const ex = (best[2] - best[0]) / bl, ey = (best[3] - best[1]) / bl;
      const dm = m.src!.door, d2 = o.src!.door;
      const side = (d: { nx: number; ny: number }) => Math.abs(ex * d.nx + ey * d.ny) > 0.6;
      // the shared wall runs from the street back for at least one of them, and the doors do not face apart
      // or the wall they share is the long side of both (narrow houses side by side, whatever the doors say)
      let sl = 0;
      for (const sg of segs) sl += segLen(sg);
      sl /= m.tpm;
      const longWall = sl >= 0.75 * shapeLW(m)[1] && sl >= 0.75 * shapeLW(o)[1];
      if (!(side(dm) || side(d2) || longWall) || dm.nx * d2.nx + dm.ny * d2.ny < -0.3) continue;
      const da = depthOf(m), db = depthOf(o);
      if (Math.abs(da - db) > 0.3 * Math.max(da, db)) continue;
      for (const [x, y] of [[m, o], [o, m]] as const) {
        if (!links.has(x)) links.set(x, []);
        links.get(x)!.push(y);
      }
    }
  }
  // a member joined to three or more is a corner: it ends the rows it touches
  const corner = new Set([...links].filter(([, l]) => l.length >= 3).map(([m]) => m));
  const rowOf = new Map<BuildingModel, BuildingModel[]>();
  for (const m of list) {
    if (rowOf.has(m) || corner.has(m) || !links.has(m)) continue;
    const members: BuildingModel[] = [];
    const st = [m];
    const seen = new Set([m]);
    while (st.length) {
      const x = st.pop()!;
      members.push(x);
      for (const y of links.get(x) ?? []) if (!corner.has(y) && !seen.has(y)) { seen.add(y); st.push(y); }
    }
    if (members.length < 2) continue;
    members.sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const x of members) rowOf.set(x, members);
  }

  // 5. context per building: neighbours counted on a grid of centres
  const CC = 50 * tpm;
  const cg = new Map<number, BuildingModel[]>();
  const ck = (i: number, j: number) => i * 4194304 + j;
  for (const m of list) {
    const [x, y] = cen.get(m)!, k2 = ck(Math.floor(x / CC), Math.floor(y / CC));
    let l = cg.get(k2);
    if (!l) cg.set(k2, (l = []));
    l.push(m);
  }
  // per cell: footprints >= 25 m², houses, big boxes, glass-like boxes, industrial tags, round ones
  const agg = new Map<number, number[]>();
  for (const [k2, l] of cg) {
    const a = [0, 0, 0, 0, 0, 0];
    for (const o of l) {
      const ao = areaW.get(o)!, fo = o.src!.cls, glassy = ao >= 4000 && (shapes.get(o)?.rect ?? 0) > 0.92;
      if (ao >= 25) a[0]++;
      if (fo === 'house') a[1]++;
      if (ao >= 800 && fo !== 'farm' && fo !== 'greenhouse' && !glassy) a[2]++;
      if (glassy && (fo === 'other' || fo === 'farm' || fo === 'greenhouse')) a[3]++;
      if (fo === 'industrial' || fo === 'warehouse' || fo === 'commercial' || fo === 'retail' || fo === 'supermarket') a[4]++;
      if (o.radius !== undefined) a[5]++;
    }
    agg.set(k2, a);
  }
  const ctxOf = new Map<BuildingModel, Ctx>();
  // old cores: narrow, deep (or tall) bays in perimeter blocks
  const blockOld: boolean[] = compBlock.map(() => false);
  {
    const bays = new Map<number, { w: number[]; d: number[]; lv: number[]; ang: number[]; shops: number }>();
    for (const m of list) {
      const c = comp.get(m);
      if (c === undefined || !compBlock[c]) continue;
      if (!bays.has(c)) bays.set(c, { w: [], d: [], lv: [], ang: [], shops: 0 });
      const [W, L] = shapeLW(m), e = bays.get(c)!;
      if (areaW.get(m)! < 25) continue;
      e.w.push(W); e.d.push(L); e.ang.push(Math.atan2(m.uy, m.ux));
      if (SHOP_USE.has(formAndUse(m.src!).use)) e.shops++;
      if (m.src!.levels) e.lv.push(m.src!.levels);
    }
    for (const [c, e] of bays) {
      // how irregular the block is: share of bays more than 5 degrees off the block's main direction
      let sx = 0, sy = 0;
      for (const a of e.ang) { sx += Math.cos(a * 4); sy += Math.sin(a * 4); }
      const mean = Math.atan2(sy, sx) / 4;
      let off = 0;
      for (const a of e.ang) { let d = Math.abs(a - mean) % (Math.PI / 2); d = Math.min(d, Math.PI / 2 - d); if (d > (5 * Math.PI) / 180) off++; }
      const irr = off / Math.max(1, e.ang.length);
      const tall = e.lv.length >= e.w.length * 0.3 && median(e.lv) >= 5;
      // shops and cafes under homes, many of them, mark a town centre
      const shops = e.shops / Math.max(1, e.w.length);
      blockOld[c] = (median(e.w) < 8 && (tall || shops >= 0.25 || (irr > 0.3 && shops >= 0.1))) || (median(e.w) < 11 && shops >= 0.4);
    }
  }
  for (const m of list) {
    const [x, y] = cen.get(m)!;
    let c45 = 0;
    const gx = Math.floor(x / CC), gy = Math.floor(y / CC);
    // close neighbours counted exactly, the wider area from per-cell sums (deterministic squares)
    for (let j = gy - 1; j <= gy + 1; j++) for (let i = gx - 1; i <= gx + 1; i++) {
      for (const o of cg.get(ck(i, j)) ?? []) {
        if (o === m) continue;
        const [ox, oy] = cen.get(o)!;
        if (Math.hypot(ox - x, oy - y) <= 45 * tpm) c45++;
      }
    }
    const sum = (R: number, k: number) => {
      let t = 0;
      for (let j = gy - R; j <= gy + R; j++) for (let i = gx - R; i <= gx + R; i++) { const a = agg.get(ck(i, j)); if (a) t += a[k]; }
      return t;
    };
    const big100 = sum(2, 0) - (areaW.get(m)! >= 25 ? 1 : 0), house = sum(2, 1) - (m.src!.cls === 'house' ? 1 : 0);
    const am = areaW.get(m)!, glassy = am >= 4000 && (shapes.get(m)?.rect ?? 0) > 0.92, fm = m.src!.cls;
    const big = sum(3, 2) - (am >= 800 && fm !== 'farm' && fm !== 'greenhouse' && !glassy ? 1 : 0);
    const glass = sum(3, 3) - (glassy && (fm === 'other' || fm === 'farm' || fm === 'greenhouse') ? 1 : 0), ind = sum(3, 4), round = sum(3, 5) - (m.radius !== undefined ? 1 : 0);
    const c = comp.get(m);
    const inBlock = c !== undefined && compBlock[c];
    ctxOf.set(m, {
      party: party.get(m)?.length ?? 0,
      rowN: rowOf.get(m)?.length ?? 1,
      inBlock,
      oldCore: m.src!.oldCore ?? (inBlock && blockOld[c!]),
      // the area must reach 100 m around for this to mean anything; a lone chunk edge reads as rural
      rural: big100 < 15 && big < 4,
      bigNear: big,
      glassNear: glass,
      indNear: ind,
      houseNear: house,
      cluster45: c45,
      roundNear: round,
      lean: lean.get(m),
    });
  }

  // 6. rows in one frame
  const out = new Map<BuildingModel, BuildingModel>();
  const doneRows = new Set<BuildingModel[]>();
  for (const members of rowOf.values()) {
    if (doneRows.has(members)) continue;
    doneRows.add(members);
    const first = members[0];
    // one frame: the area-weighted mean wall direction, in the first house's sense
    let sx = 0, sy = 0;
    for (const m of members) {
      const a = Math.atan2(m.uy, m.ux) * 4, w = areaW.get(m)!;
      sx += Math.cos(a) * w; sy += Math.sin(a) * w;
    }
    let ang = Math.atan2(sy, sx) / 4;
    const a0 = Math.atan2(first.uy, first.ux);
    while (ang < a0 - Math.PI / 4) ang += Math.PI / 2;
    while (ang > a0 + Math.PI / 4) ang -= Math.PI / 2;
    const fr0 = first.src!.rings[0];
    const frame: Frame = { ux: Math.cos(ang), uy: Math.sin(ang), rx: fr0[0], ry: fr0[1], k: first.tpm };
    const toF = (x: number, y: number) => {
      const X = (x - frame.rx) / frame.k, Y = (y - frame.ry) / frame.k;
      return [X * frame.ux + Y * frame.uy, -X * frame.uy + Y * frame.ux];
    };
    const forced = (m: BuildingModel) => {
      const fs: number[] = [], fd: number[] = [];
      for (const s of shared.get(m) ?? []) {
        const [p0, q0] = toF(s[0], s[1]), [p1, q1] = toF(s[2], s[3]);
        if (Math.abs(p1 - p0) >= Math.abs(q1 - q0)) fd.push(Math.round(((q0 + q1) / 2) / SNAP) * SNAP);
        else fs.push(Math.round(((p0 + p1) / 2) / SNAP) * SNAP);
      }
      return { fs, fd };
    };
    // which way the row runs: party walls between members are across it
    let wS = 0, wD = 0;
    const inRow = new Set(members);
    for (const m of members) for (const o of links.get(m) ?? []) {
      if (!inRow.has(o) || o.id < m.id) continue;
      for (const s of pairSegs.get(key(m, o))!) {
        const [p0, q0] = toF(s[0], s[1]), [p1, q1] = toF(s[2], s[3]);
        if (Math.abs(p1 - p0) >= Math.abs(q1 - q0)) wD += Math.abs(p1 - p0); else wS += Math.abs(q1 - q0);
      }
    }
    const rowAlongS = wS >= wD; // walls run along d, so the row runs along s
    // the row's ends give it its id
    const ends = members.filter((m) => (links.get(m) ?? []).filter((o) => inRow.has(o)).length <= 1).map((m) => m.id).sort();
    const rid = `r:${ends.length >= 2 ? `${ends[0]}|${ends[ends.length - 1]}` : first.id}`;
    const style = hashString(rid);
    // first look: each house's own main wing seen in the common frame, typed in context
    const ctxs = members.map((m) => ctxOf.get(m)!);
    const los: number[] = [], his: number[] = [], spans: number[] = [], pos: number[] = [], st: number[] = [], across: number[] = [];
    let canal = 0;
    members.forEach((m, k) => {
      const b = m.wings[0].box;
      let lo = Infinity, hi = -Infinity, a0 = Infinity, a1 = -Infinity;
      for (const [cs, cd] of [[b.s0, b.d0], [b.s1, b.d0], [b.s1, b.d1], [b.s0, b.d1]]) {
        const [x, y] = toWorld(m, cs, cd);
        const [fs, fd] = toF(x, y);
        const dep = rowAlongS ? fd : fs, al = rowAlongS ? fs : fd;
        lo = Math.min(lo, dep); hi = Math.max(hi, dep); a0 = Math.min(a0, al); a1 = Math.max(a1, al);
      }
      los.push(lo); his.push(hi); spans.push(hi - lo); pos.push((a0 + a1) / 2); across.push(a1 - a0);
      const ts = typeAndStoreys(m, ctxs[k]);
      if (ts.type === 'canal_house') canal++;
      st.push(ts.storeys);
    });
    const ok = los.filter((v) => !isNaN(v));
    if (!ok.length) continue;
    const mLo = median(ok), mHi = median(his.filter((v) => !isNaN(v)));
    const isCanal = canal * 2 > members.length;
    const storeys = Math.round(median(st));
    const spanM = Math.min(mHi - mLo, median(spans));
    const ridgeAlongS = isCanal ? !rowAlongS : rowAlongS;
    // Vinex ensembles vary the roof per row, never per house
    const v = (style >>> 11) % 20;
    const pair = members.length === 2;
    const variant: RoofKind | null = isCanal || pair || ctxs.some((c) => c.oldCore || c.inBlock) ? null : v < 2 ? 'flat' : v < 5 ? 'mansard' : v < 8 ? 'shed' : null;
    // order along the row, for doors mirrored in pairs
    const order = members.map((_, k) => k).sort((a, b) => pos[a] - pos[b]);
    members.forEach((m, k) => {
      const src = m.src!;
      const { fs, fd } = forced(m);
      const lo = !isNaN(los[k]) && Math.abs(los[k] - mLo) <= 0.9 ? Math.round(mLo / SNAP) * SNAP : undefined;
      const hi = !isNaN(his[k]) && Math.abs(his[k] - mHi) <= 0.9 ? Math.round(mHi / SNAP) * SNAP : undefined;
      const own = his[k] - los[k];
      const canalSpan = across[k];
      const idx = order.indexOf(k);
      // pairs and terraces: doors at the outer ends of a pair, mirrored in twos along a row
      let doorEnd: boolean | null = idx % 2 === 0;
      if (pair) doorEnd = idx === 0 ? false : true;
      // the frame's axis may run against the row order on this house's front: leave it to the house
      if (isCanal) doorEnd = null;
      const row: RowCtx = {
        id: rid, style, ridgeAlongS, storeys: src.levels ? st[k] : storeys,
        roofH: isCanal ? clamp(canalSpan * 0.8, 2, 7) : clamp((Math.abs(own - spanM) > 2 ? own : spanM) * 0.48, 1.5, 7),
        roof: variant, doorEnd,
      };
      const mm = assemble(src, { frame, forcedS: fs, forcedD: fd, shared: shared.get(m), row, ctx: ctxs[k], align: { along: rowAlongS ? 0 : 1, lo, hi } });
      if (mm) out.set(m, mm);
    });
  }
  // 7. everything else: typed in context; against a neighbour, party walls in its own frame
  for (const m of list) {
    if (out.has(m)) continue;
    const src = m.src!, cx = ctxOf.get(m)!;
    const sh = shapes.get(m);
    if (sh && !shared.has(m)) {
      // nothing against it: same wings, typed again in context
      const mm: BuildingModel = { ...m, wings: m.wings.map((w) => ({ ...w, box: { ...w.box } })), party: [], row: '', style: src.seed };
      dress(mm, src, sh, cx);
      shapes.set(mm, sh);
      out.set(m, mm);
      continue;
    }
    const f = frameOf(src);
    const fs: number[] = [], fd: number[] = [];
    for (const s of shared.get(m) ?? []) {
      const X0 = (s[0] - f.rx) / f.k, Y0 = (s[1] - f.ry) / f.k, X1 = (s[2] - f.rx) / f.k, Y1 = (s[3] - f.ry) / f.k;
      const p0 = X0 * f.ux + Y0 * f.uy, q0 = -X0 * f.uy + Y0 * f.ux, p1 = X1 * f.ux + Y1 * f.uy, q1 = -X1 * f.uy + Y1 * f.ux;
      const l = Math.hypot(p1 - p0, q1 - q0);
      if (Math.abs(q1 - q0) < l * 0.1) fd.push((q0 + q1) / 2);
      else if (Math.abs(p1 - p0) < l * 0.1) fs.push((p0 + p1) / 2);
    }
    const mm = assemble(src, { frame: f, forcedS: fs, forcedD: fd, shared: shared.get(m), ctx: cx });
    if (mm) out.set(m, mm);
  }
  for (let i = 0; i < models.length; i++) { const r = out.get(models[i]); if (r) models[i] = r; models[i].grouped = true; }
}

/** A standalone model's type and storeys in a given context. */
function typeAndStoreys(m: BuildingModel, cx: Ctx): { type: BuildingType; storeys: number } {
  const sh = shapes.get(m);
  if (!sh || !m.src) return { type: m.type ?? 'detached', storeys: m.storeys };
  const t = typeOf(m.src, sh, cx);
  const seed = m.src.seed;
  const r = (n: number, salt: number) => (((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 7) % n);
  return { type: t, storeys: specOf(t, sh, m.src, cx, r).storeys };
}

const segLen = (s: number[]) => Math.hypot(s[2] - s[0], s[3] - s[1]);

/** Short and long side (metres) of a model's outline in its frame. */
function shapeLW(m: BuildingModel): [number, number] {
  const r = m.src!.rings[0];
  let s0 = Infinity, s1 = -Infinity, d0 = Infinity, d1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    const s = r[i] * m.ux + r[i + 1] * m.uy, d = -r[i] * m.uy + r[i + 1] * m.ux;
    s0 = Math.min(s0, s); s1 = Math.max(s1, s); d0 = Math.min(d0, d); d1 = Math.max(d1, d);
  }
  const a = (s1 - s0) / m.tpm, b = (d1 - d0) / m.tpm;
  return [Math.min(a, b), Math.max(a, b)];
}

/**
 * How closely the wings match the real footprint: the share of the footprint
 * inside the wings, and the wing area outside the footprint as a share of the
 * footprint.
 */
export function coverageOf(m: BuildingModel): { cover: number; over: number; area: number } {
  if (!m.src) return { cover: 1, over: 0, area: 0 };
  const f: Frame = { ux: m.ux, uy: m.uy, rx: m.ox, ry: m.oy, k: m.tpm };
  const fr = ringsToFrame(m.src.rings, f);
  const area = polyArea(fr);
  let inside = 0, wa = 0;
  for (const w of m.wings) { inside += clippedArea(fr, w.box); wa += (w.box.s1 - w.box.s0) * (w.box.d1 - w.box.d0); }
  return { cover: area > 0 ? inside / area : 1, over: area > 0 ? (wa - inside) / area : 0, area };
}
