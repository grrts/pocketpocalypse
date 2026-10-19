// Building interiors. Every building big enough to stand in gets a floor plan
// derived from its real footprint: a front door facing the street, a hallway or
// sales floor behind it, rooms laid out on a grid aligned with the longest wall,
// doorways that connect every room, and furniture chosen by room type.
//
// The plan is built in metres in a door-relative frame (s along the front wall,
// d inwards from it) and then rasterised twice: here into a texel-sized material
// raster that feeds collision, and on the main thread at art resolution for the
// inside view (render/interiorArt.ts) from the same plan, so both always agree.

import { ringArea } from '../core/geo';
import { Rng } from '../core/rng';
import { M } from '../render/materials';
import { IdRaster, type Transform } from '../render/raster';
import type { BuildingInfo } from './spawnTypes';

export type RoomKind =
  | 'hall' | 'living' | 'kitchen' | 'bed' | 'bath' | 'toilet' | 'studio' | 'office' | 'class' | 'ward'
  | 'shop' | 'cafe' | 'store' | 'staff' | 'workshop' | 'warehouse' | 'barn' | 'garage' | 'church' | 'flat';

export type ItemKind =
  | 'bed' | 'sofa' | 'armchair' | 'tv' | 'coffeetable' | 'rug' | 'table' | 'chair' | 'kitchen' | 'fridge'
  | 'wardrobe' | 'bookshelf' | 'nightstand' | 'desk' | 'bathtub' | 'shower' | 'toilet' | 'sink' | 'plant'
  | 'shelf' | 'gondola' | 'counter' | 'rack' | 'pallet' | 'crate' | 'machine' | 'hay' | 'workbench' | 'drum'
  | 'pew' | 'altar' | 'cabinet' | 'stairs' | 'mat' | 'washer' | 'cafetable' | 'board' | 'trough' | 'car';

export interface PlanRoom {
  kind: RoomKind;
  floor: number;
  /** 4 corners in raster texel coordinates */
  poly: number[];
}

export interface PlanDoor {
  /** centre, raster texel coordinates */
  x: number;
  y: number;
  /** unit vector along the wall */
  tx: number;
  ty: number;
  /** opening width in texels */
  w: number;
  /** door leaf: 0 none, +1/-1 which side of the wall it swings to */
  leaf: number;
  front: boolean;
}

/** A piece of furniture: an oriented box with its back against (usually) a wall. */
export interface PlanItem {
  k: ItemKind;
  x: number;
  y: number;
  /** unit vector along its length */
  ax: number;
  ay: number;
  /** unit vector from its back to its front */
  bx: number;
  by: number;
  /** length and depth in texels */
  l: number;
  d: number;
  /** variant seed */
  v: number;
  solid: boolean;
}

export interface InteriorPlan {
  rooms: PlanRoom[];
  /** inner wall segments, 4 numbers each (raster texel coordinates) */
  walls: number[];
  doors: PlanDoor[];
  items: PlanItem[];
  /** windows on the outer walls: x0, y0, x1, y1, nx, ny (outward normal) each */
  windows: number[];
  /** building axis (along the longest wall) */
  ux: number;
  uy: number;
}

export interface Interior {
  /** raster origin in the same coordinates as the footprint (whole texels) */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** material per texel, 0 outside the footprint */
  ids: Uint8Array;
  /** a spot just inside the front door */
  inside: { x: number; y: number };
  plan: InteriorPlan;
}

export interface Door {
  /** point on the wall facing the street */
  x: number;
  y: number;
  /** outward normal of that wall */
  nx: number;
  ny: number;
}

/** Smallest footprint that gets an inside; sheds and kiosks stay solid. */
export const MIN_INTERIOR_M2 = 9;

type Layout = 'house' | 'corridor' | 'shop' | 'hall';

function layoutFor(cls: string, area: number): { layout: Layout; main: RoomKind } {
  switch (cls) {
    case 'apartments': return { layout: area > 160 ? 'corridor' : 'house', main: 'flat' };
    case 'office': case 'civic': case 'police': case 'military': return { layout: area > 90 ? 'corridor' : 'shop', main: 'office' };
    case 'school': return { layout: 'corridor', main: 'class' };
    case 'hospital': case 'medical': return { layout: area > 90 ? 'corridor' : 'shop', main: 'ward' };
    case 'shop': case 'retail': case 'commercial': case 'grocery': case 'supermarket': case 'pharmacy': case 'hardware':
    case 'outdoor': case 'fuel': return { layout: 'shop', main: 'shop' };
    case 'food_service': return { layout: 'shop', main: 'cafe' };
    case 'industrial': case 'warehouse': return { layout: 'hall', main: 'warehouse' };
    case 'mechanic': case 'fire_station': return { layout: 'hall', main: 'workshop' };
    case 'garage': case 'shed': return { layout: 'hall', main: 'garage' };
    case 'farm': case 'greenhouse': return { layout: 'hall', main: 'barn' };
    case 'church': return { layout: 'hall', main: 'church' };
    default: return { layout: area > 260 ? 'corridor' : 'house', main: area > 260 ? 'flat' : 'living' };
  }
}

const FLOOR: Record<RoomKind, number> = {
  hall: M.FLOOR_WOOD, living: M.FLOOR_WOOD, kitchen: M.FLOOR_TILE, bed: M.FLOOR_CARPET, bath: M.FLOOR_TILE,
  toilet: M.FLOOR_TILE, studio: M.FLOOR_WOOD, office: M.FLOOR_CARPET, class: M.FLOOR_TILE, ward: M.FLOOR_TILE,
  shop: M.FLOOR_TILE, cafe: M.FLOOR_WOOD, store: M.FLOOR_CONCRETE, staff: M.FLOOR_TILE, workshop: M.FLOOR_CONCRETE,
  warehouse: M.FLOOR_CONCRETE, barn: M.FLOOR_CONCRETE, garage: M.FLOOR_CONCRETE, church: M.FLOOR_STONE, flat: M.FLOOR_WOOD,
};

/** Unit vector along the longest edge of a ring. */
export function longestAxis(ring: ArrayLike<number>): [number, number] {
  let best = 0, ang = 0;
  for (let i = 0; i + 3 < ring.length; i += 2) {
    const dx = ring[i + 2] - ring[i], dy = ring[i + 3] - ring[i + 1];
    const l = dx * dx + dy * dy;
    if (l > best) { best = l; ang = Math.atan2(dy, dx); }
  }
  return [Math.cos(ang), Math.sin(ang)];
}

// ---------------------------------------------------------------- layout in metres

interface Rect { s0: number; s1: number; d0: number; d1: number; kind: RoomKind }
/** a doorway in a wall; along = 0: the wall runs along s (constant d), 1: along d */
interface SDoor { s: number; d: number; along: 0 | 1; w: number; front?: boolean }

class Plan {
  rooms: Rect[] = [];
  walls: number[] = [];
  doors: SDoor[] = [];
  constructor(readonly W: number, readonly D: number, readonly rng: Rng) {}
  room(s0: number, s1: number, d0: number, d1: number, kind: RoomKind): Rect {
    const r = { s0, s1, d0, d1, kind };
    this.rooms.push(r);
    return r;
  }
  /** wall at depth d from s=a to s=b */
  wallS(d: number, a: number, b: number) { if (d > 0.3 && d < this.D - 0.3 && b - a > 0.3) this.walls.push(a, d, b, d); }
  /** wall at s from d=a to d=b */
  wallD(s: number, a: number, b: number) { if (s > 0.3 && s < this.W - 0.3 && b - a > 0.3) this.walls.push(s, a, s, b); }
  /** doorway on the wall at depth d, somewhere between s=a and s=b */
  doorS(d: number, a: number, b: number, w = 0.95) {
    const m = 0.45 + w / 2;
    if (b - a < 2 * m) { this.doors.push({ s: (a + b) / 2, d, along: 0, w: Math.min(w, Math.max(0.8, b - a - 0.4)) }); return; }
    this.doors.push({ s: a + m + this.rng.next() * (b - a - 2 * m) * 0.6 + (b - a - 2 * m) * 0.2, d, along: 0, w });
  }
  doorD(s: number, a: number, b: number, w = 0.95) {
    const m = 0.45 + w / 2;
    if (b - a < 2 * m) { this.doors.push({ s, d: (a + b) / 2, along: 1, w: Math.min(w, Math.max(0.8, b - a - 0.4)) }); return; }
    this.doors.push({ s, d: a + m + this.rng.next() * (b - a - 2 * m) * 0.6 + (b - a - 2 * m) * 0.2, along: 1, w });
  }
  /** split [a,b] into n near-equal parts with a little jitter */
  cuts(a: number, b: number, n: number): number[] {
    const out = [a];
    for (let k = 1; k < n; k++) out.push(a + ((b - a) * k) / n + (this.rng.next() - 0.5) * ((b - a) / n) * 0.25);
    out.push(b);
    return out;
  }
}

function houseLayout(P: Plan, sd: number, main: RoomKind) {
  const { W, D, rng } = P;
  if (W < 3.4 || D < 4.2 || W * D < 20) {
    P.room(0, W, 0, D, 'studio');
    return;
  }
  // entrance hall from the front door
  const hw = 1.3;
  let h0 = sd - hw / 2, h1 = sd + hw / 2;
  // a hall against an outer wall loses some width to it
  if (h0 < 2.3) { h0 = 0; h1 = Math.max(h1, hw + 0.45); }
  if (W - h1 < 2.3) { h1 = W; if (h0 > 0) h0 = Math.min(h0, W - hw - 0.45); }
  const full = h0 === 0 && h1 === W;
  let hallLen = full ? Math.min(2.0, D * 0.3) : Math.max(2.4, Math.min(D * 0.55, D - 2.8));
  if (D - hallLen < 2.4) hallLen = D;
  P.room(h0, h1, 0, hallLen, 'hall');
  P.wallD(h0, 0, hallLen);
  P.wallD(h1, 0, hallLen);
  const side: Rect[] = [];
  for (const [a, b, ws] of [[0, h0, h0], [h1, W, h1]] as const) {
    if (b - a < 1) continue;
    const n = Math.max(1, Math.round(hallLen / 3.8));
    const c = P.cuts(0, hallLen, n);
    for (let k = 0; k < n; k++) {
      side.push(P.room(a, b, c[k], c[k + 1], 'bed'));
      if (k > 0) P.wallS(c[k], a, b);
      P.doorD(ws, c[k], c[k + 1]);
    }
  }
  const back: Rect[] = [];
  if (hallLen < D) {
    P.wallS(hallLen, 0, W);
    const n = Math.max(1, Math.round(W / 4.4));
    const c = P.cuts(0, W, n);
    const hc = (h0 + h1) / 2;
    let i0 = 0;
    for (let k = 0; k < n; k++) if (hc >= c[k]) i0 = k;
    for (let k = 0; k < n; k++) {
      back.push(P.room(c[k], c[k + 1], hallLen, D, 'bed'));
      if (k > 0) P.wallD(c[k], hallLen, D);
    }
    // the back room behind the hall opens onto it; the others chain towards it
    const r0 = back[i0];
    const lo = Math.max(r0.s0, h0), hi = Math.min(r0.s1, h1);
    P.doorS(hallLen, hi - lo > 1.3 ? lo : r0.s0, hi - lo > 1.3 ? hi : r0.s1);
    for (let k = 0; k < n; k++) {
      if (k === i0) continue;
      const wallS = k < i0 ? c[k + 1] : c[k];
      P.doorD(wallS, hallLen, D);
    }
    back[i0].kind = 'kitchen';
  }
  // room types: the biggest is the living room, the smallest the bathroom
  const rest = [...side, ...back.filter((r) => r.kind !== 'kitchen')].sort((a, b) => area(b) - area(a));
  if (rest.length) rest[0].kind = main === 'flat' ? 'living' : 'living';
  const small = rest.slice(1).sort((a, b) => area(a) - area(b));
  if (small.length >= 2 && area(small[0]) < 9) small[0].kind = 'bath';
  if (small.length >= 3 && area(small[1]) < 5) small[1].kind = 'toilet';
  if (!back.length && side.length === 1) side[0].kind = 'living';
  if (!back.length && rest.length >= 2 && !P.rooms.some((r) => r.kind === 'kitchen')) {
    const k = rest.find((r) => r.kind === 'bed');
    if (k) k.kind = 'kitchen';
  }
  void rng;
}

function corridorLayout(P: Plan, sd: number, main: RoomKind) {
  const { W, D } = P;
  if (D < 9 || W < 8) return houseLayout(P, sd, main === 'flat' ? 'living' : main);
  const roomW = main === 'class' ? 7.5 : main === 'flat' ? 5 : main === 'ward' ? 4.2 : 4.6;
  const cw = 1.9;
  const c0 = Math.max(3, Math.min(D - cw - 3, D * 0.5 - cw / 2)), c1 = c0 + cw;
  let h0 = sd - 1.1, h1 = sd + 1.1;
  if (h0 < 2.6) h0 = 0;
  if (W - h1 < 2.6) h1 = W;
  P.room(h0, h1, 0, c0, 'hall');
  P.room(0, W, c0, c1, 'hall');
  P.wallD(h0, 0, c0);
  P.wallD(h1, 0, c0);
  P.wallS(c0, 0, h0);
  P.wallS(c0, h1, W);
  P.wallS(c1, 0, W);
  const kinds: RoomKind[] = main === 'flat' ? ['living', 'bed', 'kitchen', 'living', 'bath', 'bed'] : [main];
  let ki = 0;
  const band = (a: number, b: number, d0: number, d1: number, wallAt: number) => {
    if (b - a < 1.2) return;
    const n = Math.max(1, Math.round((b - a) / roomW));
    const c = P.cuts(a, b, n);
    for (let k = 0; k < n; k++) {
      let kind = kinds[ki++ % kinds.length];
      if (main !== 'flat' && c[k + 1] - c[k] < 3 && d1 - d0 < 6) kind = 'toilet';
      P.room(c[k], c[k + 1], d0, d1, kind);
      if (k > 0) P.wallD(c[k], d0, d1);
      P.doorS(wallAt, c[k], c[k + 1]);
    }
  };
  band(0, h0, 0, c0, c0);
  band(h1, W, 0, c0, c0);
  band(0, W, c1, D, c1);
}

function shopLayout(P: Plan, sd: number, main: RoomKind) {
  const { W, D, rng } = P;
  if (D > 8 && W > 4) {
    const sr = Math.max(2.5, Math.min(6, D * 0.22));
    const ds = D - sr;
    P.wallS(ds, 0, W);
    P.room(0, W, 0, ds, main);
    if (W > 9) {
      const sx = W * (0.45 + rng.next() * 0.2);
      P.wallD(sx, ds, D);
      P.room(0, sx, ds, D, 'store');
      P.room(sx, W, ds, D, main === 'office' || main === 'ward' ? 'toilet' : 'staff');
      P.doorS(ds, 0, sx);
      P.doorD(sx, ds, D);
    } else {
      P.room(0, W, ds, D, 'store');
      P.doorS(ds, sd < W / 2 ? W * 0.5 : 0, sd < W / 2 ? W : W * 0.5);
    }
  } else {
    P.room(0, W, 0, D, main);
  }
}

function hallLayout(P: Plan, sd: number, main: RoomKind) {
  const { W, D } = P;
  P.room(0, W, 0, D, main);
  if (main !== 'church' && W * D > 150 && W > 10 && D > 9) {
    // a small office in the front corner away from the door
    const ow = 4.5, od = 4;
    const left = sd > W / 2;
    const a = left ? 0 : W - ow, b = left ? ow : W;
    P.room(a, b, 0, od, 'office');
    P.wallS(od, a, b);
    P.wallD(left ? ow : W - ow, 0, od);
    P.doorS(od, a, b);
  }
}

const area = (r: Rect) => (r.s1 - r.s0) * (r.d1 - r.d0);

// ---------------------------------------------------------------- build

/** The texel box an interior raster covers (with a one-texel margin), or null if too small to enter. */
export function interiorBox(outer: ArrayLike<number>, tpm: number): { x0: number; y0: number; w: number; h: number } | null {
  if (Math.abs(ringArea(outer)) / (tpm * tpm) < MIN_INTERIOR_M2) return null;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    bx0 = Math.min(bx0, outer[i]); bx1 = Math.max(bx1, outer[i]);
    by0 = Math.min(by0, outer[i + 1]); by1 = Math.max(by1, outer[i + 1]);
  }
  const x0 = Math.floor(bx0) - 1, y0 = Math.floor(by0) - 1;
  const w = Math.ceil(bx1) + 2 - x0, h = Math.ceil(by1) + 2 - y0;
  if (w * h > 1500 * 1500) return null;
  return { x0, y0, w, h };
}

interface Draft {
  P: Plan;
  layout: Layout;
  ux: number;
  uy: number;
  es: [number, number];
  ed: [number, number];
  /** (s, d) metres -> raster texel coordinates */
  xy: (s: number, d: number) => [number, number];
  /** inner wall segments in raster coordinates */
  walls: number[];
}

/** The floor plan in metres and the frame that maps it onto the raster. Cheap: no rasterising. */
function draft(outer: number[], cls: string, door: Door, seed: number, tpm: number, x0: number, y0: number): Draft {
  const areaM2 = Math.abs(ringArea(outer)) / (tpm * tpm);
  const { layout, main } = layoutFor(cls, areaM2);
  // Frame: u along the longest wall; then pick which side the door is on
  const [ux, uy] = longestAxis(outer);
  const vx = -uy, vy = ux;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    const u = outer[i] * ux + outer[i + 1] * uy, v = outer[i] * vx + outer[i + 1] * vy;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const cu = -(door.nx * ux + door.ny * uy), cv = -(door.nx * vx + door.ny * vy);
  // es: along the front wall, ed: inwards; origin is the (s=0, d=0) corner
  let es: [number, number], ed: [number, number], ou: number, ov: number, Wt: number, Dt: number;
  if (Math.abs(cv) >= Math.abs(cu)) {
    es = [ux, uy]; ed = cv > 0 ? [vx, vy] : [-vx, -vy];
    ou = u0; ov = cv > 0 ? v0 : v1;
    Wt = u1 - u0; Dt = v1 - v0;
  } else {
    es = [vx, vy]; ed = cu > 0 ? [ux, uy] : [-ux, -uy];
    ov = v0; ou = cu > 0 ? u0 : u1;
    Wt = v1 - v0; Dt = u1 - u0;
  }
  const ox = ou * ux + ov * vx - x0, oy = ou * uy + ov * vy - y0;
  const xy = (s: number, d: number): [number, number] => [ox + (es[0] * s + ed[0] * d) * tpm, oy + (es[1] * s + ed[1] * d) * tpm];
  const W = Wt / tpm, D = Dt / tpm;
  const rx = door.x - x0 - ox, ry = door.y - y0 - oy;
  const sd = Math.max(0.6, Math.min(W - 0.6, (rx * es[0] + ry * es[1]) / tpm));
  const P = new Plan(W, D, new Rng(seed));
  if (layout === 'house') houseLayout(P, sd, main);
  else if (layout === 'corridor') corridorLayout(P, sd, main);
  else if (layout === 'shop') shopLayout(P, sd, main);
  else hallLayout(P, sd, main);
  const walls: number[] = [];
  for (let i = 0; i < P.walls.length; i += 4) {
    const a = xy(P.walls[i], P.walls[i + 1]), b = xy(P.walls[i + 2], P.walls[i + 3]);
    walls.push(a[0], a[1], b[0], b[1]);
  }
  return { P, layout, ux, uy, es, ed, xy, walls };
}

/**
 * Windows on the outer walls (x0, y0, x1, y1, nx, ny each, footprint coordinates),
 * the same ones the inside view shows. Cheap enough to run for every building.
 */
export function planWindows(rings: number[][], cls: string, door: Door, seed: number, tpm: number): number[] {
  const box = interiorBox(rings[0], tpm);
  if (!box) return [];
  const d = draft(rings[0], cls, door, seed, tpm, box.x0, box.y0);
  return placeWindows(rings[0], d.layout, tpm, door.x, door.y, d.walls, box.x0, box.y0);
}

/** The full inside: raster for collision, furniture, and the plan the inside view is drawn from. */
export function buildInterior(rings: number[][], cls: string, door: Door, seed: number, tpm: number): Interior | null {
  const outer = rings[0];
  const box = interiorBox(outer, tpm);
  if (!box) return null;
  const { x0, y0, w, h } = box;
  const R = new IdRaster(w, h, 0);
  const t: Transform = { ox: x0, oy: y0, scale: 1 };
  const { P, layout, ux, uy, es, ed, xy, walls } = draft(outer, cls, door, seed, tpm, x0, y0);
  const rng = new Rng(seed ^ 0x2545f491);

  // --- rasterise floors, walls and doorways (texel grid, for collision)
  R.fillPolygon(rings, FLOOR[P.rooms[0]?.kind ?? 'living'], t);
  const inFoot = (c: number) => c !== 0;
  const rooms: PlanRoom[] = P.rooms.map((r) => {
    const a = xy(r.s0, r.d0), b = xy(r.s1, r.d0), c = xy(r.s1, r.d1), d = xy(r.s0, r.d1);
    const poly = [a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]];
    fillQuad(R, poly, FLOOR[r.kind], inFoot);
    return { kind: r.kind, floor: FLOOR[r.kind], poly };
  });
  // wall bands just thick enough to stay 4-connected at any angle
  const wt = Math.abs(es[0]) + Math.abs(es[1]) + 0.08;
  for (let i = 0; i < walls.length; i += 4) band(R, walls[i], walls[i + 1], walls[i + 2], walls[i + 3], wt, 0.4, M.INNER_WALL, inFoot);
  // outer walls: the outline plus a texel inwards so nothing slips through diagonals
  for (const ring of rings) {
    for (let i = 0; i + 3 < ring.length; i += 2) band(R, ring[i] - x0, ring[i + 1] - y0, ring[i + 2] - x0, ring[i + 3] - y0, 2, 0, M.OUTER_WALL, inFoot);
  }
  R.strokeRings(rings, M.OUTER_WALL, t, inFoot);
  const doors: PlanDoor[] = [];
  const isWall = (c: number) => c === M.INNER_WALL;
  for (const dd of P.doors) {
    const c = xy(dd.s, dd.d);
    const tv = dd.along === 0 ? es : ed;
    const hl = (dd.w * tpm) / 2;
    band(R, c[0] - tv[0] * hl, c[1] - tv[1] * hl, c[0] + tv[0] * hl, c[1] + tv[1] * hl, wt + 1.2, 0, M.DOORWAY, isWall);
    doors.push({ x: c[0], y: c[1], tx: tv[0], ty: tv[1], w: dd.w * tpm, leaf: rng.next() < 0.75 ? (rng.next() < 0.5 ? 1 : -1) : 0, front: false });
  }
  // the front door, through the wall that faces the street
  const fdx = door.x - x0, fdy = door.y - y0;
  const ftx = -door.ny, fty = door.nx;
  const fhl = 0.55 * tpm;
  {
    const ax = fdx + door.nx * 0.8, ay = fdy + door.ny * 0.8;
    const bx = fdx - door.nx * 2.6, by = fdy - door.ny * 2.6;
    for (let o = -fhl; o <= fhl; o += 0.5) {
      R.line(ax + ftx * o, ay + fty * o, bx + ftx * o, by + fty * o, M.DOORWAY, (c) => c === M.OUTER_WALL || c === M.INNER_WALL);
    }
    doors.push({ x: fdx - door.nx * 0.4, y: fdy - door.ny * 0.4, tx: ftx, ty: fty, w: fhl * 2, leaf: rng.next() < 0.5 ? 1 : -1, front: true });
  }

  // --- furniture
  const keep = new Uint8Array(w * h);
  for (const d of doors) {
    // keep a clear space either side of every doorway
    const nx = -d.ty, ny = d.tx;
    const hw = d.w / 2 + 0.25 * tpm, reach = (d.front ? 1.6 : 1.1) * tpm;
    stampBox(keep, w, h, d.x, d.y, d.tx, d.ty, nx, ny, hw, reach);
  }
  const items: PlanItem[] = [];
  const itemCells: number[][] = [];
  const F = new Furnisher(R, keep, items, itemCells, rng, tpm, es, ed, xy, P.W, P.D);
  for (const r of P.rooms) F.furnish(r, cls);

  // --- every room must be reachable from the front door
  let inside = { x: fdx - door.nx * 1.4 * tpm, y: fdy - door.ny * 1.4 * tpm };
  let start = -1;
  for (let k = 0.3; k < 4 && start < 0; k += 0.3) {
    const px = Math.floor(fdx - door.nx * k * tpm), py = Math.floor(fdy - door.ny * k * tpm);
    if (px > 0 && py > 0 && px < w - 1 && py < h - 1 && isOpen(R.ids, w, py * w + px)) { start = py * w + px; inside = { x: px + 0.5, y: py + 0.5 }; }
  }
  if (start >= 0) repair(R, start, items, itemCells);

  // --- windows on the outer walls (raster coordinates)
  const windows = placeWindows(outer, layout, tpm, door.x, door.y, walls, x0, y0);
  for (let i = 0; i < windows.length; i += 6) { windows[i] -= x0; windows[i + 1] -= y0; windows[i + 2] -= x0; windows[i + 3] -= y0; }

  return {
    x0, y0, w, h, ids: R.ids,
    inside: { x: inside.x + x0, y: inside.y + y0 },
    plan: { rooms, walls, doors, items, windows, ux, uy },
  };
}

/** Build a building's inside if it has not been yet. Returns false when it has none. */
export function openInterior(b: BuildingInfo): boolean {
  if (b.ids) return true;
  const inner = buildInterior(b.rings, b.cls, b.door, b.seed, b.tpm);
  if (!inner) return false;
  b.x0 = inner.x0; b.y0 = inner.y0; b.w = inner.w; b.h = inner.h;
  b.ids = inner.ids;
  b.plan = inner.plan;
  return true;
}

/** Fill an oriented band around segment a-b: full width wt, extended by ext at both ends. */
function band(R: IdRaster, ax: number, ay: number, bx: number, by: number, wt: number, ext: number, id: number, mask: (c: number) => boolean) {
  const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
  const tx = dx / l, ty = dy / l, nx = -ty * (wt / 2), ny = tx * (wt / 2);
  const ex = tx * ext, ey = ty * ext;
  fillQuad(R, [ax - ex + nx, ay - ey + ny, bx + ex + nx, by + ey + ny, bx + ex - nx, by + ey - ny, ax - ex - nx, ay - ey - ny], id, mask);
}

/** Fill a convex quad (pixel centres inside), without the general scanline machinery. */
function fillQuad(R: IdRaster, q: number[], id: number, mask: (c: number) => boolean) {
  let ymin = Infinity, ymax = -Infinity;
  for (let k = 1; k < 8; k += 2) { if (q[k] < ymin) ymin = q[k]; if (q[k] > ymax) ymax = q[k]; }
  const y0 = Math.max(0, Math.floor(ymin)), y1 = Math.min(R.h - 1, Math.ceil(ymax));
  const ids = R.ids, W = R.w;
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    let xa = Infinity, xb = -Infinity;
    for (let k = 0; k < 8; k += 2) {
      const ax = q[k], ay = q[k + 1], bx = q[(k + 2) & 7], by = q[(k + 3) & 7];
      if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
        const x = ax + ((sy - ay) / (by - ay)) * (bx - ax);
        if (x < xa) xa = x;
        if (x > xb) xb = x;
      }
    }
    if (xa > xb) continue;
    const from = Math.max(0, Math.ceil(xa - 0.5)), to = Math.min(W - 1, Math.floor(xb - 0.5));
    for (let x = from, i = y * W + from; x <= to; x++, i++) if (mask(ids[i])) ids[i] = id;
  }
}

/** True when every texel centre in the oriented box is floor (not a doorway if strict) and not kept clear. */
function boxFree(ids: Uint8Array, keep: Uint8Array | null, w: number, h: number, cx: number, cy: number, ax: number, ay: number, bx: number, by: number, hl: number, hd: number, strict: boolean): boolean {
  const r = Math.abs(ax) * hl + Math.abs(bx) * hd, s = Math.abs(ay) * hl + Math.abs(by) * hd;
  const xa = Math.floor(cx - r), xb = Math.ceil(cx + r);
  const ya = Math.floor(cy - s), yb = Math.ceil(cy + s);
  if (xa < 0 || ya < 0 || xb >= w || yb >= h) return false;
  let n = 0;
  for (let y = ya; y <= yb; y++) {
    const dy = y + 0.5 - cy;
    for (let x = xa; x <= xb; x++) {
      const dx = x + 0.5 - cx;
      if (Math.abs(dx * ax + dy * ay) > hl || Math.abs(dx * bx + dy * by) > hd) continue;
      const i = y * w + x, c = ids[i];
      if (!FLOORISH[c] || (strict && c === M.DOORWAY) || (keep && keep[i])) return false;
      n++;
    }
  }
  return n > 0;
}

/** Visit the texels whose centres fall inside an oriented box. */
function eachInBox(w: number, h: number, cx: number, cy: number, ax: number, ay: number, bx: number, by: number, hl: number, hd: number, fn: (i: number) => boolean | void): boolean {
  const r = Math.abs(ax) * hl + Math.abs(bx) * hd, s = Math.abs(ay) * hl + Math.abs(by) * hd;
  const xa = Math.max(0, Math.floor(cx - r)), xb = Math.min(w - 1, Math.ceil(cx + r));
  const ya = Math.max(0, Math.floor(cy - s)), yb = Math.min(h - 1, Math.ceil(cy + s));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (Math.abs(dx * ax + dy * ay) > hl || Math.abs(dx * bx + dy * by) > hd) continue;
      if (fn(y * w + x) === false) return false;
    }
  }
  return true;
}

function stampBox(m: Uint8Array, w: number, h: number, cx: number, cy: number, ax: number, ay: number, bx: number, by: number, hl: number, hd: number) {
  eachInBox(w, h, cx, cy, ax, ay, bx, by, hl, hd, (i) => { m[i] = 1; });
}

const FLOORISH = new Uint8Array(256);
for (const id of [M.FLOOR_WOOD, M.FLOOR_TILE, M.FLOOR_CARPET, M.FLOOR_CONCRETE, M.FLOOR_STONE, M.DOORWAY]) FLOORISH[id] = 1;
const isFloorId = (c: number) => FLOORISH[c] === 1;
const isOpen = (ids: Uint8Array, w: number, i: number) => (FLOORISH[ids[i]] & (FLOORISH[ids[i - 1]] | FLOORISH[ids[i + 1]]) & (FLOORISH[ids[i - w]] | FLOORISH[ids[i + w]])) === 1;

/** Walkable with room for a body: the texel is free and so is a neighbour on each axis (a gap of 2+ texels). */
// scratch buffers reused across buildings (one worker builds one chunk at a time)
let scratchN = 0;
let LAB = new Int32Array(0), STACK = new Int32Array(0);
function scratch(n: number) {
  if (n > scratchN) {
    scratchN = Math.max(n, scratchN * 2, 4096);
    LAB = new Int32Array(scratchN); STACK = new Int32Array(scratchN);
  }
}

function openMap(ids: Uint8Array, w: number, h: number, om: Uint8Array): Uint8Array {
  om.fill(0, 0, w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
      om[i] = FLOORISH[ids[i]] & (FLOORISH[ids[i - 1]] | FLOORISH[ids[i + 1]]) & (FLOORISH[ids[i - w]] | FLOORISH[ids[i + w]]);
    }
  }
  return om;
}

/** Label the open component containing start with lab; returns its size. */
function flood(ids: Uint8Array, labels: Int32Array, w: number, start: number, lab: number, stack: Int32Array): number {
  let sp = 0, n = 0;
  stack[sp++] = start;
  labels[start] = lab;
  while (sp) {
    const i = stack[--sp];
    n++;
    // open texels never sit on the raster border, so neighbours are in range
    let j = i - 1;
    if (!labels[j] && isOpen(ids, w, j)) { labels[j] = lab; stack[sp++] = j; }
    j = i + 1;
    if (!labels[j] && isOpen(ids, w, j)) { labels[j] = lab; stack[sp++] = j; }
    j = i - w;
    if (!labels[j] && isOpen(ids, w, j)) { labels[j] = lab; stack[sp++] = j; }
    j = i + w;
    if (!labels[j] && isOpen(ids, w, j)) { labels[j] = lab; stack[sp++] = j; }
  }
  return n;
}

/** Which texels a body can reach (1) from any of the start texels, for tests. */
export function reachable(ids: Uint8Array, w: number, h: number, starts: number | number[]): Uint8Array {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  for (const s of typeof starts === 'number' ? [starts] : starts) if (!labels[s] && isOpen(ids, w, s)) flood(ids, labels, w, s, 1, stack);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = labels[i] === 1 ? 1 : 0;
  return out;
}

/** Open texels of an interior that a body can stand on, for tests. */
export function openTexels(ids: Uint8Array, w: number, h: number): Uint8Array {
  return openMap(ids, w, h, new Uint8Array(w * h));
}

/**
 * Make sure nothing is shut off: furniture that blocks a way through is taken
 * out, and a room still cut off gets a doorway through its inner wall.
 */
function repair(R: IdRaster, start: number, items: PlanItem[], cells: number[][]) {
  const { w, h, ids } = R;
  const n = w * h;
  scratch(n);
  const lab = LAB, stack = STACK;
  for (let iter = 0; iter < 12; iter++) {
    if (!isOpen(ids, w, start)) return;
    lab.fill(0, 0, n);
    flood(ids, lab, w, start, 1, stack);
    // unreached pockets big enough to stand in
    const pockets: number[] = [];
    let next = 2;
    for (let i = w + 1; i < n - w - 1; i++) {
      if (lab[i] || !FLOORISH[ids[i]] || !isOpen(ids, w, i)) continue;
      if (flood(ids, lab, w, i, next, stack) >= 12) pockets.push(next);
      next++;
    }
    if (!pockets.length) return;
    const isPocket = new Uint8Array(next + 1);
    for (const p of pockets) isPocket[p] = 1;
    // 1) furniture touching both a pocket and the reached area
    let fixed = 0;
    for (let k = items.length - 1; k >= 0; k--) {
      if (!items[k].solid) continue;
      let a = false, b = false;
      const look = (j: number) => {
        if (j < 0 || j >= n) return;
        const l = lab[j];
        if (l === 1) a = true;
        else if (isPocket[l]) b = true;
      };
      for (const i of cells[k]) {
        look(i - 1); look(i + 1); look(i - w); look(i + w);
        look(i - 2); look(i + 2); look(i - 2 * w); look(i + 2 * w);
        if (a && b) break;
      }
      if (a && b) {
        for (const i of cells[k]) ids[i] = restoreFloor(ids, w, i);
        items.splice(k, 1);
        cells.splice(k, 1);
        fixed++;
      }
    }
    if (fixed) continue;
    // 2) for each pocket, the shortest way through walls to the reached area
    //    (or, failing that, out of the building: a side door)
    let carved = 0;
    for (const pocket of pockets) if (tunnel(ids, w, h, lab, pocket)) carved++;
    if (!carved) return;
  }
}

let DIST = new Int16Array(0), PARENT = new Int32Array(0);
/** Breadth-first search from a pocket through walls and furniture; carves a door-wide way. */
function tunnel(ids: Uint8Array, w: number, h: number, lab: Int32Array, pocket: number): boolean {
  const n = w * h;
  if (DIST.length < n) { DIST = new Int16Array(Math.max(n, DIST.length * 2)); PARENT = new Int32Array(DIST.length); }
  const dist = DIST, parent = PARENT;
  dist.fill(-1, 0, n);
  const q: number[] = [];
  for (let i = 0; i < n; i++) if (lab[i] === pocket) { dist[i] = 0; parent[i] = -1; q.push(i); }
  const shell = (i: number) => {
    const x = i % w;
    return (x > 0 && ids[i - 1] === 0) || (x < w - 1 && ids[i + 1] === 0) || (i >= w && ids[i - w] === 0) || (i < n - w && ids[i + w] === 0);
  };
  let inside = -1, outside = -1;
  for (let head = 0; head < q.length && inside < 0; head++) {
    const i = q[head];
    if (dist[i] >= 9) continue;
    const x = i % w;
    for (let k = 0; k < 4; k++) {
      if ((k === 0 && x === 0) || (k === 1 && x === w - 1)) continue;
      const j = k === 0 ? i - 1 : k === 1 ? i + 1 : k === 2 ? i - w : i + w;
      if (j < 0 || j >= n || dist[j] >= 0) continue;
      if (lab[j] === 1) { parent[j] = i; inside = j; break; }
      if (ids[j] === 0) continue;
      if (lab[j] === pocket) continue;
      // the outer shell can be cut for a side door, but not walked along inside
      if (ids[j] === M.OUTER_WALL && shell(j)) { if (outside < 0) { parent[j] = i; outside = j; dist[j] = dist[i] + 1; } continue; }
      dist[j] = dist[i] + 1;
      parent[j] = i;
      q.push(j);
    }
  }
  const end = inside >= 0 ? inside : outside;
  if (end < 0) return false;
  const toOutside = inside < 0;
  // widen the path to about a door (3 texels), keeping the outer shell unless going out
  for (let i = toOutside ? end : parent[end]; i >= 0 && dist[i] > 0; i = parent[i]) {
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx, c = ids[j];
        if (c === M.INNER_WALL || c === M.FURNITURE || (c === M.OUTER_WALL && (toOutside || !shell(j)))) ids[j] = M.DOORWAY;
      }
    }
  }
  return true;
}

function restoreFloor(ids: Uint8Array, w: number, i: number): number {
  for (const j of [i - 1, i + 1, i - w, i + w, i - 2, i + 2]) if (j >= 0 && j < ids.length && isFloorId(ids[j]) && ids[j] !== M.DOORWAY) return ids[j];
  return M.FLOOR_WOOD;
}


function placeWindows(ring: number[], layout: Layout, tpm: number, fx: number, fy: number, walls: number[], x0: number, y0: number): number[] {
  const out: number[] = [];
  const shop = layout === 'shop';
  const hall = layout === 'hall';
  const period = (hall ? 6 : shop ? 2.2 : 2.7) * tpm, ww = (hall ? 2.2 : shop ? 1.6 : 1.25) * tpm;
  // signed area tells which side is outside
  const sgn = ringArea(ring) > 0 ? 1 : -1;
  for (let i = 0; i + 3 < ring.length; i += 2) {
    const ax = ring[i], ay = ring[i + 1], bx = ring[i + 2], by = ring[i + 3];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1.6 * tpm) continue;
    const tx = (bx - ax) / L, ty = (by - ay) / L;
    const nx = ty * sgn, ny = -tx * sgn;
    const n = Math.max(1, Math.floor((L - 0.6 * tpm) / period));
    const start = (L - n * period) / 2 + period / 2;
    for (let k = 0; k < n; k++) {
      const c = start + k * period;
      const cx = ax + tx * c, cy = ay + ty * c;
      if (Math.hypot(cx - fx, cy - fy) < (ww / 2 + 1.0 * tpm)) continue;
      // keep clear of inner walls meeting the outer wall here
      let clash = false;
      for (let q = 0; q < walls.length && !clash; q += 4) {
        for (const e of [0, 2]) {
          if (Math.hypot(walls[q + e] + x0 - cx, walls[q + e + 1] + y0 - cy) < ww / 2 + 0.7 * tpm) clash = true;
        }
      }
      if (clash) continue;
      out.push(cx - tx * ww / 2, cy - ty * ww / 2, cx + tx * ww / 2, cy + ty * ww / 2, nx, ny);
    }
  }
  return out;
}

// ---------------------------------------------------------------- furniture


class Furnisher {
  constructor(
    private R: IdRaster, private keep: Uint8Array, private items: PlanItem[], private cells: number[][], private rng: Rng,
    private tpm: number, private es: [number, number], private ed: [number, number],
    private xy: (s: number, d: number) => [number, number], private W: number, private D: number,
  ) {}

  /** inset from a room edge: outer walls are thicker than inner ones */
  private inset(v: number, max: number) { return v < 0.3 || v > max - 0.3 ? 0.62 : 0.34; }

  /** Try to put an item down; frame vectors are given in (s,d) space. */
  private put(k: ItemKind, s: number, d: number, as: [number, number], bs: [number, number], l: number, dp: number, solid: boolean, clear: 0 | 1 | 2 = 0): boolean {
    const { R, keep, tpm, es, ed } = this;
    const [cx, cy] = this.xy(s, d);
    const ax = es[0] * as[0] + ed[0] * as[1], ay = es[1] * as[0] + ed[1] * as[1];
    const bx = es[0] * bs[0] + ed[0] * bs[1], by = es[1] * bs[0] + ed[1] * bs[1];
    const hl = (l * tpm) / 2, hd = (dp * tpm) / 2;
    const ids = R.ids;
    // corners first: cheap, and rejects most misses (odd shapes, walls)
    for (let q = 0; q < 4; q++) {
      const fa = q === 0 || q === 3 ? -1 : 1, fb = q < 2 ? -1 : 1;
      const px = Math.floor(cx + ax * hl * fa + bx * hd * fb), py = Math.floor(cy + ay * hl * fa + by * hd * fb);
      if (!isFloorId(R.get(px, py))) return false;
    }
    if (!boxFree(ids, solid ? keep : null, R.w, R.h, cx, cy, ax, ay, bx, by, hl, hd, true)) return false;
    // room to walk: in front of pieces against a wall (1), all round free-standing ones (2)
    if (solid && clear) {
      const c = 0.75 * tpm;
      const fine = clear === 1
        ? boxFree(ids, null, R.w, R.h, cx + bx * (hd + c / 2), cy + by * (hd + c / 2), ax, ay, bx, by, hl, c / 2, false)
        : boxFree(ids, null, R.w, R.h, cx, cy, ax, ay, bx, by, hl + c, hd + c, false);
      if (!fine) return false;
    }
    const cells: number[] = [];
    if (solid) {
      eachInBox(R.w, R.h, cx, cy, ax, ay, bx, by, hl, hd, (i) => { ids[i] = M.FURNITURE; cells.push(i); });
      // a little air around solid pieces
      eachInBox(R.w, R.h, cx, cy, ax, ay, bx, by, hl + 0.12 * tpm, hd + 0.12 * tpm, (i) => { keep[i] = 1; });
    }
    this.items.push({ k, x: cx, y: cy, ax, ay, bx, by, l: l * tpm, d: dp * tpm, v: (this.rng.next() * 65536) | 0, solid });
    this.cells.push(cells);
    return true;
  }

  /** Against one of the room's walls, trying them in a random order. */
  wall(r: Rect, k: ItemKind, l: number, dp: number, solid = true, sides?: number[]): boolean {
    const order = sides ?? [0, 1, 2, 3].sort(() => this.rng.next() - 0.5);
    for (const side of order) {
      const alongS = side === 0 || side === 2;
      const len = alongS ? r.s1 - r.s0 : r.d1 - r.d0;
      if (len < l + 0.3) continue;
      const step = Math.max(0.3, (len - l) / 5);
      const steps = Math.max(1, Math.floor((len - l) / step));
      const off = Math.floor(this.rng.next() * (steps + 1));
      for (let q = 0; q <= steps; q++) {
        const p = ((off + q) % (steps + 1)) * step + l / 2 + (len - l - steps * step) / 2;
        let s: number, d: number, as: [number, number], bs: [number, number];
        if (side === 0) { as = [1, 0]; bs = [0, 1]; s = r.s0 + p; d = r.d0 + this.inset(r.d0, this.D) + dp / 2; }
        else if (side === 2) { as = [-1, 0]; bs = [0, -1]; s = r.s0 + p; d = r.d1 - this.inset(r.d1, this.D) - dp / 2; }
        else if (side === 1) { as = [0, -1]; bs = [-1, 0]; d = r.d0 + p; s = r.s1 - this.inset(r.s1, this.W) - dp / 2; }
        else { as = [0, 1]; bs = [1, 0]; d = r.d0 + p; s = r.s0 + this.inset(r.s0, this.W) + dp / 2; }
        if (this.put(k, s, d, as, bs, l, dp, solid, 1)) return true;
      }
    }
    return false;
  }

  center(r: Rect, k: ItemKind, l: number, dp: number, solid = true, jitter = 0.4): boolean {
    const longS = r.s1 - r.s0 >= r.d1 - r.d0;
    for (let tries = 0; tries < 6; tries++) {
      const s = (r.s0 + r.s1) / 2 + (this.rng.next() - 0.5) * jitter * (tries + 1);
      const d = (r.d0 + r.d1) / 2 + (this.rng.next() - 0.5) * jitter * (tries + 1);
      if (this.put(k, s, d, longS ? [1, 0] : [0, 1], longS ? [0, 1] : [-1, 0], l, dp, solid, 2)) return true;
    }
    return false;
  }

  /** Parallel rows (shop shelving, racks, pews, desks). */
  rows(r: Rect, k: ItemKind, l: number, dp: number, gap: number, margin: [number, number, number, number], alongD: boolean, face = 1) {
    const solid = true;
    const [ms0, ms1, md0, md1] = margin;
    if (alongD) {
      // rows run inwards (along d), stepping across s
      const len = Math.min(l, r.d1 - r.d0 - md0 - md1);
      if (len < 1) return;
      for (let s = r.s0 + ms0 + dp / 2; s + dp / 2 <= r.s1 - ms1; s += dp + gap) {
        this.put(k, s, r.d0 + md0 + len / 2, [0, 1], [1, 0], len, dp, solid);
      }
    } else {
      const len = Math.min(l, r.s1 - r.s0 - ms0 - ms1);
      if (len < 1) return;
      for (let d = r.d0 + md0 + dp / 2; d + dp / 2 <= r.d1 - md1; d += dp + gap) {
        this.put(k, r.s0 + ms0 + len / 2, d, [face, 0], [0, face], len, dp, solid);
      }
    }
  }

  /** A table with chairs around it (chairs are decoration). */
  dining(r: Rect, l: number, dp: number, k: ItemKind = 'table') {
    if (!this.center(r, k, l, dp)) return;
    const t = this.items[this.items.length - 1];
    const tpm = this.tpm;
    const per = Math.max(1, Math.floor(t.l / tpm / 0.6));
    for (const side of [-1, 1]) {
      for (let i = 0; i < per; i++) {
        const o = ((i + 0.5) / per - 0.5) * t.l;
        const cx = t.x + t.ax * o + t.bx * side * (t.d / 2 + 0.3 * tpm), cy = t.y + t.ay * o + t.by * side * (t.d / 2 + 0.3 * tpm);
        if (!isFloorId(this.R.get(Math.floor(cx), Math.floor(cy)))) continue;
        this.items.push({ k: 'chair', x: cx, y: cy, ax: t.ax, ay: t.ay, bx: -t.bx * side, by: -t.by * side, l: 0.45 * tpm, d: 0.45 * tpm, v: i, solid: false });
        this.cells.push([]);
      }
    }
  }

  furnish(r: Rect, cls: string) {
    const rng = this.rng;
    const w = r.s1 - r.s0, d = r.d1 - r.d0;
    if (w < 1.2 || d < 1.2) return;
    switch (r.kind) {
      case 'hall':
        if (w > 1.6 || d > 1.6) this.wall(r, 'cabinet', 0.8, 0.35);
        if (w * d > 12 && rng.next() < 0.6) this.wall(r, 'plant', 0.5, 0.5);
        if (cls === 'apartments' || (w > 4 && d > 1.8 && w * d > 14)) this.wall(r, 'stairs', 2.6, 1.0);
        break;
      case 'living': case 'studio': case 'flat': {
        if (w > 2.6 && d > 2.6) this.center(r, 'rug', Math.min(2.6, w - 1.4), Math.min(1.8, d - 1.4), false, 0.2);
        this.wall(r, 'sofa', 2.0, 0.85);
        this.wall(r, 'tv', 1.5, 0.45);
        if (w > 3.2 && d > 3.2) this.wall(r, 'armchair', 0.85, 0.85);
        this.wall(r, 'bookshelf', 1.0, 0.35);
        if (rng.next() < 0.7) this.wall(r, 'plant', 0.5, 0.5);
        if (r.kind !== 'living' || w * d > 22) {
          if (r.kind === 'studio' || r.kind === 'flat') { this.wall(r, 'kitchen', Math.min(2.8, Math.max(w, d) - 1.2), 0.6); this.wall(r, 'bed', 1.6, 2.0); }
          else this.dining(r, 1.6, 0.9);
        }
        break;
      }
      case 'kitchen':
        this.wall(r, 'kitchen', Math.max(1.2, Math.min(3.4, Math.max(w, d) - 1.2)), 0.6);
        this.wall(r, 'fridge', 0.65, 0.65);
        if (w > 2.4 && d > 2.4) this.dining(r, 1.2, 0.8);
        break;
      case 'bed':
        this.wall(r, 'bed', w > 2.8 && d > 2.8 ? 1.6 : 0.95, 2.0);
        this.wall(r, 'wardrobe', 1.2, 0.6);
        if (rng.next() < 0.5) this.wall(r, 'nightstand', 0.45, 0.4);
        if (rng.next() < 0.5) this.wall(r, 'desk', 1.1, 0.55);
        break;
      case 'bath':
        if (Math.max(w, d) > 2.2) this.wall(r, 'bathtub', 1.7, 0.75); else this.wall(r, 'shower', 0.9, 0.9);
        this.wall(r, 'toilet', 0.42, 0.65);
        this.wall(r, 'sink', 0.6, 0.45);
        if (rng.next() < 0.5) this.wall(r, 'washer', 0.6, 0.6);
        break;
      case 'toilet':
        this.wall(r, 'toilet', 0.42, 0.65);
        this.wall(r, 'sink', 0.45, 0.35);
        break;
      case 'office': {
        const desks = Math.min(14, Math.floor((w * d) / 7));
        for (let i = 0; i < desks; i++) if (!this.wall(r, 'desk', 1.4, 0.75)) break;
        if (w > 4 && d > 4) this.center(r, 'table', Math.min(2.4, w - 2.5), Math.min(1.0, d - 2.5));
        this.wall(r, 'cabinet', 0.9, 0.5);
        if (rng.next() < 0.6) this.wall(r, 'plant', 0.5, 0.5);
        break;
      }
      case 'class':
        this.wall(r, 'board', Math.min(3.5, w - 1), 0.15, false, [0]);
        this.wall(r, 'desk', 1.4, 0.7, true, [0]);
        this.rows(r, 'desk', 1.2, 0.55, 0.85, [1.2, 1.2, 2.6, 0.9], false, -1);
        this.wall(r, 'cabinet', 1.2, 0.45);
        break;
      case 'ward': {
        const n = Math.max(1, Math.floor(Math.max(w, d) / 2.4));
        for (let i = 0; i < n; i++) if (!this.wall(r, 'bed', 0.95, 2.05)) break;
        this.wall(r, 'cabinet', 0.6, 0.45);
        this.wall(r, 'sink', 0.55, 0.4);
        break;
      }
      case 'shop':
        if (cls === 'pharmacy') {
          this.wall(r, 'counter', Math.min(4, w - 1.5), 0.7, true, [2]);
          this.rows(r, 'shelf', 99, 0.45, 99, [0.6, 0.6, 1.2, 2.2], true);
        } else {
          // checkout by the door side, shelving rows behind with aisles, shelves along the walls
          this.wall(r, 'counter', 1.8, 0.75, true, [1, 3]);
          for (const side of [1, 3, 2]) for (let i = 0; i < 6; i++) if (!this.wall(r, 'shelf', 2.0, 0.5, true, [side])) break;
          if (w > 5 && d > 5.5) this.rows(r, 'gondola', d - 5.5, 0.9, 1.5, [1.6, 1.6, 3.0, 1.6], true);
        }
        break;
      case 'cafe': {
        this.wall(r, 'counter', Math.min(4, Math.max(1.6, w - 2)), 0.7, true, [2, 1, 3]);
        const n = Math.min(12, Math.floor((w * d) / 6));
        for (let i = 0; i < n; i++) {
          const s = r.s0 + 1.4 + rng.next() * Math.max(0, w - 2.8), dd = r.d0 + 2.0 + rng.next() * Math.max(0, d - 3.5);
          if (this.put('cafetable', s, dd, [1, 0], [0, 1], 0.75, 0.75, true, 2)) {
            const t = this.items[this.items.length - 1];
            for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              if (rng.next() < 0.25) continue;
              const ox = (t.ax * a + t.bx * b) * 0.7 * this.tpm, oy = (t.ay * a + t.by * b) * 0.7 * this.tpm;
              if (!isFloorId(this.R.get(Math.floor(t.x + ox), Math.floor(t.y + oy)))) continue;
              this.items.push({ k: 'chair', x: t.x + ox, y: t.y + oy, ax: t.bx * a - t.ax * b, ay: t.by * a - t.ay * b, bx: -(t.ax * a + t.bx * b), by: -(t.ay * a + t.by * b), l: 0.42 * this.tpm, d: 0.42 * this.tpm, v: a + 2 * b, solid: false });
              this.cells.push([]);
            }
          }
        }
        break;
      }
      case 'store':
        for (let i = 0; i < 6; i++) if (!this.wall(r, 'shelf', 1.8, 0.55)) break;
        for (let i = 0; i < 3; i++) this.center(r, rng.next() < 0.5 ? 'crate' : 'pallet', 1.1, 1.0, true, 1.5);
        break;
      case 'staff':
        this.wall(r, 'kitchen', Math.min(2, Math.max(w, d) - 1), 0.6);
        if (w > 2.2 && d > 2.2) this.dining(r, 1.2, 0.8);
        this.wall(r, 'cabinet', 0.9, 0.45);
        break;
      case 'warehouse': {
        const big = w * d > 300;
        if (big) this.rows(r, 'rack', d - 7, 1.1, 3.2, [2.0, 2.0, 4.0, 2.5], true);
        for (let i = 0; i < 6; i++) this.wall(r, rng.next() < 0.5 ? 'pallet' : 'crate', 1.2, 1.0);
        if (!big) for (let i = 0; i < 2; i++) this.center(r, 'machine', 2.6, 1.8, true, 3);
        this.wall(r, 'workbench', 2.0, 0.7);
        this.wall(r, 'drum', 0.6, 0.6);
        break;
      }
      case 'workshop': case 'garage':
        this.wall(r, 'workbench', Math.min(2.4, Math.max(w, d) - 1), 0.7);
        this.wall(r, 'shelf', 1.6, 0.5);
        if (w > 3.4 && d > 5.5) this.center(r, 'car', 4.3, 1.8, true, 0.6);
        this.wall(r, 'drum', 0.6, 0.6);
        if (rng.next() < 0.6) this.wall(r, 'cabinet', 0.8, 0.5);
        break;
      case 'barn':
        for (let i = 0; i < Math.min(10, (w * d) / 25); i++) this.wall(r, 'hay', 1.2, 0.8);
        if (w > 6 && d > 8) this.rows(r, 'trough', d - 6, 0.6, 3.6, [2.4, 2.4, 3.0, 3.0], true);
        this.wall(r, 'drum', 0.6, 0.6);
        break;
      case 'church':
        this.wall(r, 'altar', Math.min(2.4, w - 2), 1.0, true, [2]);
        if (w > 5) {
          const half = (w - 1.6) / 2;
          const pl = Math.min(4, half - 1.2);
          if (pl > 1.4) {
            this.rows(r, 'pew', pl, 0.55, 0.45, [0.9, w - 0.9 - pl, 2.4, 3.2], false);
            this.rows(r, 'pew', pl, 0.55, 0.45, [w - 0.9 - pl, 0.9, 2.4, 3.2], false);
          }
        }
        break;
    }
  }
}
