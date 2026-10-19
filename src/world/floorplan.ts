// Floor plans in metres, in the building's own frame: s along the front wall,
// d inwards from it, both aligned with the building's dominant wall direction.
//
// 1. The real footprint is decomposed into its largest inscribed rectangles
//    (a core and a few wings attached to it). Slivers and triangles left along
//    angled walls never become rooms of their own: the rooms next to them grow
//    out to the outer wall, so a room just gets one slanted side.
// 2. Each rectangle gets a programme for the building type (a Dutch terraced
//    ground floor, flats off a corridor, classrooms either side of a corridor,
//    a shop floor with a back store, ...), built from straight cuts. Every
//    candidate is checked against minimum room sizes; if a building is too
//    small for a programme it falls back to fewer, bigger rooms.
// 3. Walls are the boundaries between different rooms, so they are straight,
//    axis-aligned and never end in the middle of a room; each room has one
//    door to the room it is reached from, so everything connects to the front
//    door.

import { pointInPolygon } from '../core/geo';
import { Rng } from '../core/rng';

export type RoomKind =
  | 'hall' | 'lobby' | 'living' | 'kitchen' | 'bed' | 'bath' | 'toilet' | 'studio' | 'office' | 'meeting' | 'class' | 'ward'
  | 'shop' | 'cafe' | 'store' | 'staff' | 'workshop' | 'warehouse' | 'barn' | 'garage' | 'church' | 'flat' | 'gym';

export interface Box { s0: number; s1: number; d0: number; d1: number }

export interface FPRoom {
  kind: RoomKind;
  /** rectangles fully inside the footprint: the room proper (disjoint, axis-aligned) */
  parts: Box[];
  /** the same parts grown out to the outer walls over leftover slivers (may reach past the footprint) */
  ext: Box[];
  /** the room its door opens into; -1 for the room behind the front door */
  parent: number;
  doorW: number;
  /** which rectangle of the footprint decomposition it belongs to */
  block: number;
  /** a kitchen counter in the room (open-plan flats) */
  kitchenette?: boolean;
  /** the whole of a block too small for a programme: exempt from room-size rules */
  free?: boolean;
  /** where along the shared wall its door goes (0..1) */
  at?: number;
}

export interface FPDoor {
  s: number;
  d: number;
  /** 0: the wall runs along s (constant d), 1: along d */
  along: 0 | 1;
  w: number;
  a: number;
  b: number;
}

export interface FloorPlan {
  W: number;
  D: number;
  blocks: Box[];
  rooms: FPRoom[];
  /** inner wall segments s0, d0, s1, d1 each */
  walls: number[];
  doors: FPDoor[];
}

// ---------------------------------------------------------------- room rules

interface Spec { w: number; a: number; amax?: number; wmax?: number; aspect?: number }

/** Minimum width (m), minimum area (m²), and limits per room type. */
export const ROOM_SPEC: Record<RoomKind, Spec> = {
  hall: { w: 1.1, a: 1.2, wmax: 2.0, aspect: 1e9 },
  lobby: { w: 2.4, a: 6 },
  living: { w: 3.0, a: 14 },
  kitchen: { w: 2.4, a: 5 },
  bed: { w: 2.4, a: 7 },
  bath: { w: 1.5, a: 3 },
  toilet: { w: 0.85, a: 1.2, amax: 22 },
  studio: { w: 2.4, a: 9 },
  flat: { w: 2.4, a: 14 },
  office: { w: 2.4, a: 9, amax: 20 },
  meeting: { w: 2.4, a: 12, amax: 60 },
  class: { w: 4.5, a: 40, amax: 60 },
  gym: { w: 6, a: 60 },
  ward: { w: 2.4, a: 9, amax: 40 },
  shop: { w: 2.4, a: 6 },
  cafe: { w: 2.4, a: 8 },
  store: { w: 2.4, a: 3 },
  staff: { w: 2.4, a: 6, amax: 45 },
  workshop: { w: 2.4, a: 6 },
  warehouse: { w: 2.4, a: 6 },
  barn: { w: 2.4, a: 6 },
  garage: { w: 2.4, a: 6 },
  church: { w: 2.4, a: 6 },
};

const EPS = 1e-6;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const B = (s0: number, s1: number, d0: number, d1: number): Box => ({ s0, s1, d0, d1 });
export const boxW = (b: Box) => b.s1 - b.s0;
export const boxD = (b: Box) => b.d1 - b.d0;
export const boxArea = (b: Box) => (b.s1 - b.s0) * (b.d1 - b.d0);

/** The largest part of a room, the one its size rules apply to. */
export function mainPart(parts: Box[]): Box {
  let m = parts[0];
  for (const p of parts) if (boxArea(p) > boxArea(m)) m = p;
  return m;
}

/** Whether a room meets the size rules for its type. */
export function roomFits(kind: RoomKind, parts: Box[]): boolean {
  const sp = ROOM_SPEC[kind];
  let area = 0;
  for (const p of parts) {
    area += boxArea(p);
    if (Math.min(boxW(p), boxD(p)) < 0.8 - EPS) return false;
  }
  const m = mainPart(parts);
  const a = Math.min(boxW(m), boxD(m)), b = Math.max(boxW(m), boxD(m));
  if (a < sp.w - EPS || area < sp.a - EPS) return false;
  if (sp.amax !== undefined && area > sp.amax + EPS) return false;
  if (sp.wmax !== undefined && a > sp.wmax + EPS) return false;
  return b / a <= (sp.aspect ?? 4) + EPS;
}

// ---------------------------------------------------------------- geometry helpers

interface Seg { along: 0 | 1; c: number; a: number; b: number }

/** Edges two sets of rectangles share. */
export function sharedSegs(A: Box[], Bs: Box[]): Seg[] {
  const out: Seg[] = [];
  for (const p of A) {
    for (const q of Bs) {
      if (Math.abs(p.d1 - q.d0) < 1e-6 || Math.abs(p.d0 - q.d1) < 1e-6) {
        const c = Math.abs(p.d1 - q.d0) < 1e-6 ? p.d1 : p.d0;
        const a = Math.max(p.s0, q.s0), b = Math.min(p.s1, q.s1);
        if (b - a > 1e-6) out.push({ along: 0, c, a, b });
      }
      if (Math.abs(p.s1 - q.s0) < 1e-6 || Math.abs(p.s0 - q.s1) < 1e-6) {
        const c = Math.abs(p.s1 - q.s0) < 1e-6 ? p.s1 : p.s0;
        const a = Math.max(p.d0, q.d0), b = Math.min(p.d1, q.d1);
        if (b - a > 1e-6) out.push({ along: 1, c, a, b });
      }
    }
  }
  return out;
}

function longest(segs: Seg[]): Seg | null {
  let best: Seg | null = null;
  for (const s of segs) if (!best || s.b - s.a > best.b - best.a) best = s;
  return best;
}

const overlaps = (a: Box, b: Box) => Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0) > 1e-6 && Math.min(a.d1, b.d1) - Math.max(a.d0, b.d0) > 1e-6;

function crossings(rings: number[][], y: number, out: number[]) {
  out.length = 0;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = r[j * 2], ay = r[j * 2 + 1], bx = r[i * 2], by = r[i * 2 + 1];
      if ((ay <= y && by > y) || (by <= y && ay > y)) out.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
  }
  out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------- footprint -> rectangles

/**
 * Largest inscribed axis-aligned rectangles: a core, then wings that share at
 * least a doorway's worth of wall with a rectangle already chosen.
 */
export function decompose(rings: number[][], W: number, D: number): Box[] {
  const g = Math.max(0.25, Math.sqrt((W * D) / 6000));
  const nx = Math.max(1, Math.floor(W / g + 1e-9)), ny = Math.max(1, Math.floor(D / g + 1e-9));
  const cell = new Uint8Array(nx * ny);
  const xs: number[] = [];
  const row = new Uint8Array(nx), tmp = new Uint8Array(nx);
  for (let j = 0; j < ny; j++) {
    row.fill(1);
    for (const fy of [0.04, 0.5, 0.96]) {
      crossings(rings, (j + fy) * g, xs);
      tmp.fill(0);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] / g - 1e-9)), i1 = Math.min(nx, Math.floor(xs[k + 1] / g + 1e-9));
        for (let i = i0; i < i1; i++) tmp[i] = 1;
      }
      for (let i = 0; i < nx; i++) row[i] &= tmp[i];
    }
    cell.set(row, j * nx);
  }
  const h = new Int32Array(nx), st = new Int32Array(nx + 1);
  type G = [number, number, number, number]; // i0, i1, j0, j1 (exclusive ends)
  const search = (score: (i0: number, i1: number, j0: number, j1: number) => number): G | null => {
    h.fill(0);
    let best: G | null = null, bs = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) h[i] = cell[j * nx + i] === 1 ? h[i] + 1 : 0;
      let sp = 0;
      for (let i = 0; i <= nx; i++) {
        const hi = i < nx ? h[i] : 0;
        while (sp > 0 && h[st[sp - 1]] >= hi) {
          const ht = h[st[--sp]];
          const left = sp > 0 ? st[sp - 1] + 1 : 0;
          if (ht > 0) {
            const sc = score(left, i, j - ht + 1, j + 1);
            if (sc > bs) { bs = sc; best = [left, i, j - ht + 1, j + 1]; }
          }
        }
        st[sp++] = i;
      }
    }
    return best;
  };
  const minC = Math.max(1, Math.ceil(2.3 / g - 1e-9));
  let core = search((i0, i1, j0, j1) => (i1 - i0 >= minC && j1 - j0 >= minC ? (i1 - i0) * (j1 - j0) : 0));
  core ??= search((i0, i1, j0, j1) => (i1 - i0) * (j1 - j0));
  if (!core) return [];
  const grid: G[] = [core];
  const mark = (r: G) => { for (let j = r[2]; j < r[3]; j++) for (let i = r[0]; i < r[1]; i++) cell[j * nx + i] = 2; };
  mark(core);
  const coreA = (core[1] - core[0]) * (core[3] - core[2]);
  const minWingCells = Math.max(8 / (g * g), coreA * 0.04);
  const touch = Math.ceil(1.4 / g - 1e-9);
  const ov = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
  for (let k = 0; k < 6; k++) {
    const wing = search((i0, i1, j0, j1) => {
      if (i1 - i0 < minC || j1 - j0 < minC) return 0;
      const a = (i1 - i0) * (j1 - j0);
      if (a < minWingCells) return 0;
      for (const b of grid) {
        if ((j1 === b[2] || j0 === b[3]) && ov(i0, i1, b[0], b[1]) >= touch) return a;
        if ((i1 === b[0] || i0 === b[1]) && ov(j0, j1, b[2], b[3]) >= touch) return a;
      }
      return 0;
    });
    if (!wing) break;
    grid.push(wing);
    mark(wing);
  }
  // to metres, then push free sides out to the real walls (the grid lies inside them)
  const boxes = grid.map((r) => B(r[0] * g, r[1] * g, r[2] * g, r[3] * g));
  const touches = (k: number, side: number) => grid.some((o, m) => {
    if (m === k) return false;
    const r = grid[k];
    if (side === 0) return o[3] === r[2] && ov(r[0], r[1], o[0], o[1]) > 0;
    if (side === 2) return o[2] === r[3] && ov(r[0], r[1], o[0], o[1]) > 0;
    if (side === 3) return o[1] === r[0] && ov(r[2], r[3], o[2], o[3]) > 0;
    return o[0] === r[1] && ov(r[2], r[3], o[2], o[3]) > 0;
  });
  /** the strip between a rectangle side and where it would move to lies inside the footprint */
  const stripInside = (b: Box, side: number): boolean => {
    // the moved edge, sampled, and no outline corner poking into the strip
    const alongS = side === 0 || side === 2;
    const len = alongS ? boxW(b) : boxD(b);
    const n = Math.max(2, Math.ceil(len / 0.3));
    const c = side === 0 ? b.d0 + 0.005 : side === 2 ? b.d1 - 0.005 : side === 3 ? b.s0 + 0.005 : b.s1 - 0.005;
    for (let i = 0; i <= n; i++) {
      const t = 0.005 + (len - 0.01) * (i / n);
      if (alongS ? !pointInPolygon(b.s0 + t, c, rings) : !pointInPolygon(c, b.d0 + t, rings)) return false;
    }
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        if (r[i] > b.s0 + 0.01 && r[i] < b.s1 - 0.01 && r[i + 1] > b.d0 + 0.01 && r[i + 1] < b.d1 - 0.01) return false;
      }
    }
    return true;
  };
  boxes.forEach((b, k) => {
    for (const side of [0, 2, 3, 1]) {
      if (touches(k, side)) continue;
      const strip = (t: number): Box =>
        side === 0 ? B(b.s0, b.s1, b.d0 - t, b.d0) : side === 2 ? B(b.s0, b.s1, b.d1, b.d1 + t) : side === 3 ? B(b.s0 - t, b.s0, b.d0, b.d1) : B(b.s1, b.s1 + t, b.d0, b.d1);
      const room = side === 0 ? b.d0 : side === 2 ? D - b.d1 : side === 3 ? b.s0 : W - b.s1;
      let lo = 0, hi = Math.min(room, 1.6 * g);
      if (hi <= 0.01) continue;
      if (stripInside(strip(hi), side) && !boxes.some((o, m) => m !== k && overlaps(o, strip(hi)))) lo = hi;
      else {
        for (let it = 0; it < 5; it++) {
          const t = (lo + hi) / 2;
          if (stripInside(strip(t), side) && !boxes.some((o, m) => m !== k && overlaps(o, strip(t)))) lo = t; else hi = t;
        }
      }
      if (side === 0) b.d0 -= lo; else if (side === 2) b.d1 += lo; else if (side === 3) b.s0 -= lo; else b.s1 += lo;
    }
  });
  return boxes;
}

// ---------------------------------------------------------------- local frames

/**
 * A rectangle seen from one of its sides: x along that side, y inwards.
 * side 0: entered across d0, 1: across s1, 2: across d1, 3: across s0.
 */
class Frame {
  readonly W: number;
  readonly D: number;
  constructor(readonly b: Box, readonly side: number) {
    this.W = side === 0 || side === 2 ? boxW(b) : boxD(b);
    this.D = side === 0 || side === 2 ? boxD(b) : boxW(b);
  }
  out(l: Box): Box {
    const b = this.b;
    switch (this.side) {
      case 0: return B(b.s0 + l.s0, b.s0 + l.s1, b.d0 + l.d0, b.d0 + l.d1);
      case 2: return B(b.s1 - l.s1, b.s1 - l.s0, b.d1 - l.d1, b.d1 - l.d0);
      case 1: return B(b.s1 - l.d1, b.s1 - l.d0, b.d0 + l.s0, b.d0 + l.s1);
      default: return B(b.s0 + l.d0, b.s0 + l.d1, b.d1 - l.s1, b.d1 - l.s0);
    }
  }
  /** position along the entry side of an outside point */
  x(s: number, d: number): number {
    const b = this.b;
    switch (this.side) {
      case 0: return s - b.s0;
      case 2: return b.s1 - s;
      case 1: return d - b.d0;
      default: return b.d1 - d;
    }
  }
}

// ---------------------------------------------------------------- programmes

/** A room in a block's local frame (x = s along the entry side, y = d inwards). */
interface LRoom {
  kind: RoomKind;
  parts: Box[];
  /** index of the room its door opens into; -1: the way in to this block */
  parent: number;
  doorW: number;
  /** where along the shared wall the door goes (0..1), random if unset */
  at?: number;
  kitchenette?: boolean;
  free?: boolean;
}

const L = (kind: RoomKind, parts: Box[], parent: number, doorW = 0.85, at?: number): LRoom => ({ kind, parts, parent, doorW, at });

function mirror(rooms: LRoom[], W: number): LRoom[] {
  for (const r of rooms) r.parts = r.parts.map((p) => B(W - p.s1, W - p.s0, p.d0, p.d1));
  return rooms;
}

/** All rooms fit their rules, each can have a door to its parent, and exactly one is entered at x. */
function valid(rooms: LRoom[], W: number, D: number, x: number): boolean {
  let entries = 0;
  for (const r of rooms) {
    for (const p of r.parts) {
      if (p.s0 < -EPS || p.s1 > W + EPS || p.d0 < -EPS || p.d1 > D + EPS) return false;
      if (boxW(p) < 0.5 || boxD(p) < 0.5) return false;
    }
    if (!r.free && !roomFits(r.kind, r.parts)) return false;
    if (r.parent === -1) {
      entries++;
      if (!r.parts.some((p) => p.d0 < EPS && x >= p.s0 + 0.5 - EPS && x <= p.s1 - 0.5 + EPS)) return false;
    } else {
      const s = longest(sharedSegs(r.parts, rooms[r.parent].parts));
      if (!s || s.b - s.a < Math.min(r.doorW, 0.7) + 0.6 - EPS) return false;
    }
  }
  return entries === 1;
}

/** One open room, cut into a chain of rooms if the block is very long and thin. */
function single(kind: RoomKind, W: number, D: number, x: number): LRoom[] {
  const lo = Math.min(W, D), hi = Math.max(W, D);
  const n = lo > 0.5 ? Math.max(1, Math.ceil(hi / lo / 3.5 - 1e-9)) : 1;
  const open = Math.max(0.9, Math.min(3, lo - 0.8));
  if (n === 1) return [{ ...L(kind, [B(0, W, 0, D)], -1, 0.9), free: true }];
  const out: LRoom[] = [];
  if (D >= W) {
    for (let k = 0; k < n; k++) out.push({ ...L(kind, [B(0, W, (D * k) / n, (D * (k + 1)) / n)], k - 1, open), free: true });
  } else {
    const e = clamp(Math.floor(x / (W / n)), 0, n - 1);
    for (let k = 0; k < n; k++) out.push({ ...L(kind, [B((W * k) / n, (W * (k + 1)) / n, 0, D)], k === e ? -1 : k < e ? k + 1 : k - 1, open), free: true });
  }
  return out;
}

/** The first candidate layout that passes the rules, else one open room. */
function pick(W: number, D: number, x: number, fallback: RoomKind, ...cands: (() => LRoom[] | null)[]): LRoom[] {
  for (const c of cands) {
    const r = c();
    if (r && valid(r, W, D, x)) return r;
  }
  return single(fallback, W, D, x);
}

const mirrored = (W: number, x: number, f: (x: number) => LRoom[] | null) => () => {
  if (x <= W / 2) return f(x);
  const r = f(W - x);
  return r && mirror(r, W);
};

// --- houses: Dutch terraced ground floor

/** Front door -> hall with the stairs, toilet, living room in front and through to the back, kitchen at the back. */
function houseHall(W: number, D: number, x: number): LRoom[] | null {
  if (W < 4.4 || D < 5.6) return null;
  const HW = 1.4;
  let h0 = x - HW / 2, h1 = x + HW / 2;
  if (h0 < 0) { h0 = 0; h1 = HW; }
  let corner = 0;
  if (h0 > 0 && h0 < 2.4) {
    if (x + 0.5 <= 2.0) { h0 = 0; h1 = Math.max(HW, x + 0.5); }
    else if (h0 >= 0.9) corner = h0;
    else { h0 = 0; h1 = 2.0; }
  }
  if (W - h1 < 3.0) return null;
  const e = D >= 8 ? clamp(D * 0.55, 4.2, D - 2.8) : D >= 6.6 ? D - 2.6 : D;
  const rooms: LRoom[] = [];
  const hall = L('hall', [], -1);
  rooms.push(hall);
  let hl = e;
  const toiletEnd = !corner && e - 1.4 >= 2.6;
  if (toiletEnd) hl = e - 1.4;
  if (corner) {
    const tl = Math.max(1.4, 1.3 / corner);
    if (hl - tl < 1.2) return null;
    hall.parts = [B(h0, h1, 0, hl), B(0, h0, tl, hl)];
    rooms.push(L('toilet', [B(0, h0, 0, tl)], 0, 0.7));
  } else hall.parts = [B(h0, h1, 0, hl)];
  if (toiletEnd) rooms.push(L('toilet', [B(h0, h1, hl, e)], 0, 0.7));
  const liv = rooms.length;
  const living = L('living', [B(h1, W, 0, e)], 0, 0.85, 0.85);
  rooms.push(living);
  if (h0 >= 2.4 && !corner) rooms.push(L('bed', [B(0, h0, 0, e)], 0, 0.85, 0.7));
  if (e < D - EPS) {
    // the kitchen behind the hall; the rest joins the living room ("doorzon")
    const kx = h0 >= 2.4 && !corner ? h1 : clamp(W * 0.45, 2.4, W - 2.4);
    if (W - kx < 2.4 - EPS) return null;
    rooms.push(L('kitchen', [B(0, kx, e, D)], liv, 1.2));
    living.parts.push(B(kx, W, e, D));
  } else living.kitchenette = true;
  return rooms;
}

/** No hall: the door opens into the living room, kitchen (and toilet) behind or beside it. */
function houseNoHall(W: number, D: number, x: number): LRoom[] | null {
  if (W < 3.0 || D < 2.4) return null;
  if (D >= 6.0) {
    const bd = clamp(D * 0.35, 2.4, 3.6), e = D - bd;
    const rooms: LRoom[] = [L('living', [B(0, W, 0, e)], -1)];
    if (W >= 2.4 + 1.1) {
      const left = x > W / 2;
      const t = left ? B(0, 1.1, e, D) : B(W - 1.1, W, e, D);
      rooms.push(L('kitchen', [left ? B(1.1, W, e, D) : B(0, W - 1.1, e, D)], 0, 1.2));
      rooms.push(L('toilet', [t], 1, 0.7));
    } else rooms.push(L('kitchen', [B(0, W, e, D)], 0, 1.2));
    return rooms;
  }
  if (W >= 3.0 + 2.4) {
    const kw = clamp(W * 0.35, 2.4, 3.2);
    const rooms = [L('living', [B(0, W - kw, 0, D)], -1), L('kitchen', [B(W - kw, W, 0, D)], 0, 1.2)];
    return x > W / 2 ? mirror(rooms, W) : rooms;
  }
  return null;
}

/** One room and a bathroom. */
function studioBath(kind: RoomKind) {
  return (W: number, D: number, x: number): LRoom[] | null => {
    if (W < 2.4 || D < 2.4) return null;
    if (W <= 4.2 && D >= 2.4 + 1.5) {
      const b = Math.max(1.5, 3.2 / W);
      return [L(kind, [B(0, W, 0, D - b)], -1), L('bath', [B(0, W, D - b, D)], 0, 0.75)];
    }
    if (W > 4.2 && D >= 3.6) {
      const rooms = [L(kind, [B(0, W - 2.0, 0, D), B(W - 2.0, W, 0, D - 1.8)], -1), L('bath', [B(W - 2.0, W, D - 1.8, D)], 0, 0.75)];
      return x > W / 2 ? mirror(rooms, W) : rooms;
    }
    if (W >= 2.4 + 1.5) {
      const b = Math.max(1.5, 3.2 / D);
      const rooms = [L(kind, [B(0, W - b, 0, D)], -1), L('bath', [B(W - b, W, 0, D)], 0, 0.75)];
      return x > W / 2 ? mirror(rooms, W) : rooms;
    }
    return null;
  };
}

function house(W: number, D: number, x: number): LRoom[] {
  return pick(W, D, x, 'studio', mirrored(W, x, (x) => houseHall(W, D, x)), () => houseNoHall(W, D, x), () => studioBath('studio')(W, D, x));
}

// --- flats

/** Hall, bathroom and bedroom along the entrance side, an open-plan living room behind. */
function flatFull(W: number, D: number, x: number): LRoom[] | null {
  const HW = 1.4;
  let h0 = Math.max(0, x - HW / 2), h1 = h0 + HW;
  let corner = 0;
  if (h0 < 2.4) {
    if (Math.max(HW, x + 0.5) <= 2.0) { h0 = 0; h1 = Math.max(HW, x + 0.5); }
    else if (h0 >= 0.9) corner = h0;
    else return null;
  }
  const fb = clamp(D * 0.42, 2.8, 3.8);
  if (D - fb < 3.0) return null;
  const hall = L('hall', [B(h0, h1, 0, fb)], -1);
  const rooms: LRoom[] = [hall];
  const living = L('living', [B(0, W, fb, D)], 0, 0.85);
  living.kitchenette = true;
  rooms.push(living);
  const bw = clamp(4.6 / fb, 1.6, 2.2);
  if (W - h1 - bw >= 2.6) {
    rooms.push(L('bath', [B(h1, h1 + bw, 0, fb)], 0, 0.75));
    rooms.push(L('bed', [B(h1 + bw, W, 0, fb)], 1, 0.85));
  } else if (W - h1 >= 1.5) rooms.push(L('bath', [B(h1, W, 0, fb)], 0, 0.75));
  else return null;
  if (corner) {
    // a toilet by the front door, the hall wraps behind it
    const tl = Math.max(1.4, 1.3 / corner);
    if (fb - tl < 1.1) return null;
    hall.parts.push(B(0, h0, tl, fb));
    rooms.push(L('toilet', [B(0, h0, 0, tl)], 0, 0.7));
  } else if (h0 >= 2.4) rooms.push(L('bed', [B(0, h0, 0, fb)], 0, 0.85));
  return rooms;
}

/** Hall and bathroom, one room behind. */
function flatSmall(W: number, D: number, x: number): LRoom[] | null {
  const h1 = Math.max(1.4, x + 0.5);
  if (h1 > 2.0) return null;
  const fb = clamp(D * 0.4, 2.2, 3.2);
  if (D - fb < 3.0 || W - h1 < 1.5) return null;
  const rooms: LRoom[] = [L('hall', [B(0, h1, 0, fb)], -1)];
  const flat = L('flat', [B(0, W, fb, D)], 0, 0.85);
  rooms.push(flat);
  if (W - h1 > 4.2 && W - h1 - 2.2 >= 2.4) {
    rooms.push(L('bath', [B(h1, h1 + 2.2, 0, fb)], 0, 0.75));
    rooms.push(L('store', [B(h1 + 2.2, W, 0, fb)], 1, 0.8));
  } else rooms.push(L('bath', [B(h1, W, 0, fb)], 0, 0.75));
  return rooms;
}

/** A shallow, wide unit: living room | hall with the bathroom at its end | bedroom, all off the entrance side. */
function flatWide(W: number, D: number, x: number): LRoom[] | null {
  if (D < 3.6 || D > 7) return null;
  const h0 = x - 0.8, h1 = x + 0.8;
  if (h0 < 2.4 || W - h1 < 2.4) return null;
  const big = h0 >= W - h1;
  return [
    L('hall', [B(h0, h1, 0, D - 2.0)], -1),
    { ...L('living', [big ? B(0, h0, 0, D) : B(h1, W, 0, D)], 0, 0.85), kitchenette: true },
    L('bed', [big ? B(h1, W, 0, D) : B(0, h0, 0, D)], 0, 0.85),
    L('bath', [B(h0, h1, D - 2.0, D)], 0, 0.75),
  ];
}

function flatUnit(W: number, D: number, x: number): LRoom[] {
  return pick(W, D, x, 'flat', mirrored(W, x, (x) => flatFull(W, D, x)), () => flatWide(W, D, x), mirrored(W, x, (x) => flatSmall(W, D, x)), () => studioBath('flat')(W, D, x));
}

/** A flat in a corridor block, with its front door wherever the best plan fits. */
function flatCell(W: number, D: number, first: boolean): LRoom[] {
  let best: LRoom[] | null = null;
  for (const x of first ? [0.8, W - 0.8, W * 0.42] : [W - 0.8, 0.8, W * 0.58]) {
    const r = flatUnit(W, D, x);
    if (!best || r.length > best.length) best = r;
    if (r.length >= 4) break;
  }
  return best!;
}

// --- shops, cafés

/** Sales floor at the front, a row of back rooms (store, staff room, toilet) behind. */
function shopBack(main: RoomKind) {
  return (W: number, D: number, _x: number): LRoom[] | null => {
    if (W < 2.4 || D < 5.0) return null;
    let bd = clamp(D * 0.24, 2.6, 4.5);
    let sd = D - bd;
    if (sd > 4 * W) { sd = 4 * W; bd = D - sd; }
    if (sd < 2.4) return null;
    const rooms: LRoom[] = [L(main, [B(0, W, 0, sd)], -1)];
    if (bd <= 5.5) {
      // one row of back rooms, side by side
      const row: { kind: RoomKind; w: number }[] = [];
      if (main === 'cafe') {
        // kitchen and customer toilets; a store only if the kitchen would be huge
        row.push({ kind: 'toilet', w: 1.4 });
        if (W >= 2.4 + 2.8) row.push({ kind: 'toilet', w: 1.4 });
        const k = W - row.length * 1.4;
        if (k < 2.4) row.length = 0;
        if (k > 7 + 2.4) row.unshift({ kind: 'kitchen', w: 7 });
        else if (k >= 2.4) row.unshift({ kind: 'kitchen', w: k });
      } else {
        row.push({ kind: 'toilet', w: 1.4 });
        if (W >= 9) row.push({ kind: 'staff', w: 3.0 });
      }
      let used = row.reduce((a, r) => a + r.w, 0);
      while (row.length && W - used > EPS && W - used < 2.4) { used -= row.pop()!.w; }
      used = row.reduce((a, r) => a + r.w, 0);
      // the store fills the rest, in pieces no longer than 3x their depth
      const rest = W - used;
      const n = rest < EPS ? 0 : Math.max(1, Math.ceil(rest / (bd * 3.5)));
      let s = 0;
      for (let k = 0; k < n; k++) {
        rooms.push(L('store', [B(s, s + rest / n, sd, D)], 0, 1.0));
        s += rest / n;
      }
      for (const r of row) {
        const i = rooms.length;
        rooms.push(L(r.kind, [B(s, s + r.w, sd, D)], r.kind === 'toilet' && main !== 'cafe' && i > 1 ? i - 1 : 0, r.kind === 'toilet' ? 0.75 : 0.9));
        s += r.w;
      }
      return rooms;
    }
    // a long narrow building: store rooms one behind the other, the toilet at the very back
    const toiletRow = W < 3.8;
    const span = D - sd - (toiletRow ? 1.5 : 0);
    const n = Math.max(1, Math.ceil(span / Math.min(3 * W, 5)));
    let d = sd;
    for (let k = 0; k < n; k++) {
      const last = k === n - 1;
      const piece = last && !toiletRow ? [B(0, W - 1.4, d, d + span / n)] : [B(0, W, d, d + span / n)];
      rooms.push(L('store', piece, k === 0 ? 0 : rooms.length - 1, 1.0));
      if (last && !toiletRow) rooms.push(L('toilet', [B(W - 1.4, W, d, d + span / n)], rooms.length - 1, 0.75));
      d += span / n;
    }
    if (toiletRow) rooms.push(L('toilet', [B(0, W, D - 1.5, D)], rooms.length - 1, 0.75));
    return rooms;
  };
}

/** Sales floor with a toilet in a back corner. */
function shopToilet(main: RoomKind) {
  return (W: number, D: number, x: number): LRoom[] | null => {
    if (W < 2.4 + 1.4 || D < 1.6 + 2.0) return null;
    const rooms = [L(main, [B(0, W - 1.4, 0, D), B(W - 1.4, W, 0, D - 1.6)], -1), L('toilet', [B(W - 1.4, W, D - 1.6, D)], 0, 0.75)];
    return x > W / 2 ? mirror(rooms, W) : rooms;
  };
}

/** A wide, shallow shop: the back rooms at the end away from the door instead. */
function shopSide(main: RoomKind) {
  return (W: number, D: number, x: number): LRoom[] | null => {
    if (W < 2 * D) return null;
    const r = shopBack(main)(D, W, 0);
    if (!r) return null;
    for (const q of r) q.parts = q.parts.map((p) => B(p.d0, p.d1, p.s0, p.s1));
    return x > W / 2 ? mirror(r, W) : r;
  };
}

function shop(main: RoomKind) {
  return (W: number, D: number, x: number) => pick(W, D, x, main, () => shopBack(main)(W, D, x), () => shopSide(main)(W, D, x), () => shopToilet(main)(W, D, x));
}

// --- halls: warehouses, workshops, barns, churches

/** One big space with a small office and toilet in the front corner away from the door. */
function hallOffice(main: RoomKind) {
  return (W: number, D: number, x: number): LRoom[] | null => {
    if (W * D < 150 || W < 10 || D < 8) return null;
    const ow = 3.4, od = 3.4, tw = 1.5;
    const f = (x: number): LRoom[] | null => {
      if (x > W - ow - tw - 0.6) return null;
      return [
        L(main, [B(0, W - ow - tw, 0, D), B(W - ow - tw, W, od, D)], -1),
        L('office', [B(W - ow, W, 0, od)], 0, 0.9),
        L('toilet', [B(W - ow - tw, W - ow, 0, od)], 0, 0.8),
      ];
    };
    return mirrored(W, x, f)();
  };
}

function hall(main: RoomKind) {
  return (W: number, D: number, x: number) => main === 'church' ? single('church', W, D, x) : pick(W, D, x, main, () => hallOffice(main)(W, D, x));
}

// --- corridor buildings: schools, offices, care, apartment blocks

interface CorrSpec {
  main: RoomKind;
  /** corridor width */
  cw: number;
  /** depth of a row of rooms off a corridor */
  rowMax: number;
  /** target room area */
  target: number;
  /** narrowest room along the corridor */
  minCell: number;
  /** entrance lobby width (<= 2 means just the corridor) */
  lobby: number;
}

const CORR: Record<string, CorrSpec> = {
  school: { main: 'class', cw: 2.0, rowMax: 8.6, target: 50, minCell: 5, lobby: 4.2 },
  office: { main: 'office', cw: 1.6, rowMax: 6, target: 14, minCell: 2.6, lobby: 2.6 },
  care: { main: 'ward', cw: 1.8, rowMax: 6.5, target: 20, minCell: 3, lobby: 3.0 },
  flats: { main: 'flat', cw: 1.5, rowMax: 11, target: 60, minCell: 5.6, lobby: 2.6 },
};

interface Cell { box: Box; side: number }

/** Cut a row of rooms along s (alongD false) or d into cells facing the corridor on `side`. */
function cutRow(out: Cell[], row: Box, alongD: boolean, side: number, sp: CorrSpec, rng: Rng) {
  const len = alongD ? boxD(row) : boxW(row), depth = alongD ? boxW(row) : boxD(row);
  if (len < 0.5 || depth < 0.5) return;
  let n = Math.max(1, Math.round((len * depth) / sp.target));
  while (n > 1 && len / n < sp.minCell) n--;
  const ws: number[] = [];
  let tot = 0;
  for (let k = 0; k < n; k++) { const w = 1 + (rng.next() - 0.5) * 0.16; ws.push(w); tot += w; }
  let a = alongD ? row.d0 : row.s0;
  for (let k = 0; k < n; k++) {
    const b = k === n - 1 ? (alongD ? row.d1 : row.s1) : a + (len * ws[k]) / tot;
    out.push({ box: alongD ? B(row.s0, row.s1, a, b) : B(a, b, row.d0, row.d1), side });
    a = b;
  }
}

/** Corridors parallel to the entrance (N of them) joined by a spine from the door. */
function combP(W: number, D: number, x: number, sp: CorrSpec, N: number, lobby: boolean): { rooms: LRoom[]; cells: Cell[]; hall: number } | null {
  const r = (D - N * sp.cw) / (2 * N);
  if (r < 2.4 || r > sp.rowMax) return null;
  const c0: number[] = [];
  for (let k = 0; k < N; k++) c0.push(r + k * (2 * r + sp.cw));
  let sx0 = clamp(x - sp.cw / 2, 0, W - sp.cw), sx1 = sx0 + sp.cw;
  if (N > 1) {
    if (sx0 > EPS && sx0 < sp.minCell) { sx0 = 0; sx1 = sp.cw; }
    if (W - sx1 > EPS && W - sx1 < sp.minCell) { sx1 = W; sx0 = W - sp.cw; }
    if (sx0 > EPS && sx0 < sp.minCell) return null;
  }
  const lw = Math.max(lobby ? sp.lobby : 1.4, 1.4);
  let lx0 = x - lw / 2, lx1 = x + lw / 2;
  if (N > 1) { lx0 = Math.min(lx0, sx0); lx1 = Math.max(lx1, sx1); }
  lx0 = Math.max(0, lx0); lx1 = Math.min(W, lx1);
  if (lx0 < 2.4) lx0 = 0;
  if (W - lx1 < 2.4) lx1 = W;
  if (lx1 - lx0 > 2.0 && lx1 - lx0 < 2.4) { if (lx1 < W) lx1 = Math.min(W, lx0 + 2.4); else lx0 = Math.max(0, lx1 - 2.4); }
  if (lx0 > EPS && lx0 < 2.4) return null;
  if (W - lx1 > EPS && W - lx1 < 2.4) return null;
  const rooms: LRoom[] = [];
  const hallParts: Box[] = [];
  for (let k = 0; k < N; k++) {
    hallParts.push(B(0, W, c0[k], c0[k] + sp.cw));
    if (k < N - 1) hallParts.push(B(sx0, sx1, c0[k] + sp.cw, c0[k + 1]));
  }
  let hallIdx: number;
  if (lx1 - lx0 <= 2.0 + EPS) {
    hallParts.push(B(lx0, lx1, 0, c0[0]));
    rooms.push(L('hall', hallParts, -1));
    hallIdx = 0;
  } else {
    rooms.push(L('lobby', [B(lx0, lx1, 0, c0[0])], -1));
    rooms.push(L('hall', hallParts, 0, Math.min(3, lx1 - lx0 - 0.6)));
    hallIdx = 1;
  }
  const cells: Cell[] = [];
  const rng = new Rng((W * 1000 + D * 7) | 0);
  if (lx0 > EPS) cutRow(cells, B(0, lx0, 0, c0[0]), false, 2, sp, rng);
  if (lx1 < W - EPS) cutRow(cells, B(lx1, W, 0, c0[0]), false, 2, sp, rng);
  for (let k = 0; k < N - 1; k++) {
    const a = c0[k] + sp.cw, m = a + r, b = c0[k + 1];
    for (const [d0, d1, side] of [[a, m, 0], [m, b, 2]] as const) {
      if (sx0 > EPS) cutRow(cells, B(0, sx0, d0, d1), false, side, sp, rng);
      if (sx1 < W - EPS) cutRow(cells, B(sx1, W, d0, d1), false, side, sp, rng);
    }
  }
  cutRow(cells, B(0, W, c0[N - 1] + sp.cw, D), false, 0, sp, rng);
  return { rooms, cells, hall: hallIdx };
}

/** One corridor along the front wall, rooms behind it. */
function combFront(W: number, D: number, _x: number, sp: CorrSpec) {
  if (D - sp.cw < 2.4 || D - sp.cw > sp.rowMax) return null;
  const cells: Cell[] = [];
  cutRow(cells, B(0, W, sp.cw, D), false, 0, sp, new Rng((W * 1000 + D * 7) | 0));
  return { rooms: [L('hall', [B(0, W, 0, sp.cw)], -1)], cells, hall: 0 };
}

/** One corridor from the door straight in, rooms either side. */
function combQ(W: number, D: number, x: number, sp: CorrSpec) {
  let c0 = clamp(x - sp.cw / 2, 0, W - sp.cw), c1 = c0 + sp.cw;
  if (c0 > EPS && c0 < 2.4) { c0 = 0; c1 = sp.cw; }
  if (W - c1 > EPS && W - c1 < 2.4) { c1 = W; c0 = W - sp.cw; }
  if ((c0 > EPS && c0 < 2.4) || x - 0.5 < c0 - EPS || x + 0.5 > c1 + EPS) return null;
  if (c0 > sp.rowMax || W - c1 > sp.rowMax) return null;
  const cells: Cell[] = [];
  const rng = new Rng((W * 1000 + D * 7) | 0);
  if (c0 > EPS) cutRow(cells, B(0, c0, 0, D), true, 1, sp, rng);
  if (c1 < W - EPS) cutRow(cells, B(c1, W, 0, D), true, 3, sp, rng);
  return { rooms: [L('hall', [B(c0, c1, 0, D)], -1)], cells, hall: 0 };
}

/** Give each cell a use (and split cells for toilets and a staff room where needed). */
function fillCells(prog: string, sp: CorrSpec, base: { rooms: LRoom[]; cells: Cell[]; hall: number }, x: number, root: boolean, rng: Rng): LRoom[] | null {
  const rooms = base.rooms.map((r) => ({ ...r, parts: [...r.parts] }));
  const hallI = base.hall;
  const cells = [...base.cells].sort((a, b) => dist(a.box, x) - dist(b.box, x));
  const fits = (k: RoomKind, b: Box) => roomFits(k, [b]);
  const at = () => 0.15 + rng.next() * 0.7;
  if (prog === 'flats') {
    let odd = false;
    for (const c of cells) {
      if (!fits('flat', c.box) && fits('store', c.box)) { rooms.push(L('store', [c.box], hallI, 0.85, at())); continue; }
      const f = new Frame(c.box, c.side);
      odd = !odd;
      const unit = flatCell(f.W, f.D, odd);
      const off = rooms.length;
      for (const u of unit) rooms.push({ ...u, parts: u.parts.map((p) => f.out(p)), parent: u.parent < 0 ? hallI : u.parent + off });
    }
    return rooms;
  }
  let toilets = root ? 1 + Math.floor(cells.length / 12) : 0;
  let staff = root && prog !== 'office' ? 1 : 0;
  let meeting = root && prog === 'office' ? 1 : 0;
  const extras: RoomKind[] = prog === 'office' ? ['office', 'meeting', 'staff', 'store', 'toilet'] : ['office', 'staff', 'store', 'toilet'];
  const big: RoomKind = prog === 'school' ? 'gym' : prog === 'office' ? 'meeting' : 'staff';
  /** what a room that cannot hold the main use becomes */
  const other = (b: Box): RoomKind | null => {
    const a = boxArea(b);
    if (meeting && fits('meeting', b)) { meeting--; return 'meeting'; }
    if (toilets && fits('toilet', b)) { toilets--; return 'toilet'; }
    if (staff && fits('staff', b)) { staff--; return 'staff'; }
    for (const k of extras) if (fits(k, b)) return k;
    return a > 40 && fits(big, b) ? big : null;
  };
  const out: { box: Box; kind: RoomKind }[] = [];
  const split = (c: Cell, len0: number): [Box, Box] => {
    const b = c.box, alongD = c.side === 1 || c.side === 3;
    const cut = alongD ? b.d0 + len0 : b.s0 + len0;
    return alongD ? [B(b.s0, b.s1, b.d0, cut), B(b.s0, b.s1, cut, b.d1)] : [B(b.s0, cut, b.d0, b.d1), B(cut, b.s1, b.d0, b.d1)];
  };
  const dims = (c: Cell) => {
    const alongD = c.side === 1 || c.side === 3;
    return { len: alongD ? boxD(c.box) : boxW(c.box), depth: alongD ? boxW(c.box) : boxD(c.box) };
  };
  for (const c of cells) {
    const { len, depth } = dims(c);
    const main = fits(sp.main, c.box);
    if (main && meeting && fits('meeting', c.box)) { meeting--; out.push({ box: c.box, kind: 'meeting' }); continue; }
    if (main && (toilets || staff) && len >= 4.8) {
      // the first rooms by the entrance give up a slice for a toilet or the staff room
      const tw = clamp(Math.min(len * 0.45, 20 / depth), 2.4, len - 2.4);
      const [p, q] = split(c, tw);
      const k1: RoomKind = toilets ? 'toilet' : 'staff';
      const k2: RoomKind = fits(sp.main, q) ? sp.main : toilets && staff && fits('staff', q) ? 'staff' : other(q) ?? sp.main;
      if (fits(k1, p) && fits(k2, q)) {
        if (k1 === 'toilet') toilets--; else staff--;
        if (k2 === 'staff' && staff) staff--;
        out.push({ box: p, kind: k1 }, { box: q, kind: k2 });
        continue;
      }
    }
    if (main) { out.push({ box: c.box, kind: sp.main }); continue; }
    const sm = ROOM_SPEC[sp.main];
    if (sm.amax && boxArea(c.box) > sm.amax) {
      // too big: a room of the main use and a smaller one beside it
      const ml = clamp(sp.target / depth, sm.w, len - 2.4);
      if (len - ml >= 2.4) {
        const [p, q] = split(c, ml);
        if (fits(sp.main, p)) {
          const k = other(q);
          if (k) { out.push({ box: p, kind: sp.main }, { box: q, kind: k }); continue; }
        }
      }
    }
    const k = other(c.box);
    if (!k) return null;
    out.push({ box: c.box, kind: k });
  }
  for (const e of out) rooms.push(L(e.kind, [e.box], hallI, e.kind === 'toilet' ? 0.85 : e.kind === 'gym' ? 1.6 : 0.95, at()));
  return rooms;
}

const dist = (b: Box, x: number) => Math.max(0, b.s0 - x, x - b.s1) + b.d0;

function corridor(prog: string, root: boolean) {
  const sp = CORR[prog];
  return (W: number, D: number, x: number, rng: Rng): LRoom[] => {
    let best: LRoom[] | null = null, bestScore = -Infinity;
    const bases = [
      combP(W, D, x, sp, 1, root), combP(W, D, x, sp, 2, root), combP(W, D, x, sp, 3, root), combP(W, D, x, sp, 4, root),
      combFront(W, D, x, sp), combQ(W, D, x, sp),
    ];
    for (const base of bases) {
      if (!base) continue;
      const rooms = fillCells(prog, sp, base, x, root, rng);
      if (!rooms || !valid(rooms, W, D, x)) continue;
      let score = 0;
      for (const r of rooms) {
        const a = r.parts.reduce((t, p) => t + boxArea(p), 0);
        if (r.kind === 'hall' || r.kind === 'lobby') score -= 0.6 * a;
        else if (r.kind === sp.main || prog === 'flats') score += a;
        else score += 0.5 * a;
      }
      if (score > bestScore) { bestScore = score; best = rooms; }
    }
    if (best) return best;
    // too small for corridors
    if (prog === 'flats') return flatUnit(W, D, x);
    if (prog === 'office') return pick(W, D, x, 'office', () => shopToilet('office')(W, D, x));
    return shop(sp.main)(W, D, x);
  };
}

// --- which programme for which building

type Prog = 'house' | 'flat' | 'flats' | 'school' | 'office' | 'care' | 'shop' | 'hall';

export function programmeFor(cls: string, area: number): { prog: Prog; main: RoomKind } {
  switch (cls) {
    case 'apartments': return area >= 150 ? { prog: 'flats', main: 'flat' } : { prog: 'flat', main: 'flat' };
    case 'office': case 'civic': case 'police': case 'military': return area > 60 ? { prog: 'office', main: 'office' } : { prog: 'shop', main: 'office' };
    case 'school': return { prog: 'school', main: 'class' };
    case 'hospital': case 'medical': return area > 80 ? { prog: 'care', main: 'ward' } : { prog: 'shop', main: 'ward' };
    case 'shop': case 'retail': case 'commercial': case 'grocery': case 'supermarket': case 'pharmacy': case 'hardware':
    case 'outdoor': case 'fuel': return { prog: 'shop', main: 'shop' };
    case 'food_service': return { prog: 'shop', main: 'cafe' };
    case 'industrial': case 'warehouse': return { prog: 'hall', main: 'warehouse' };
    case 'mechanic': case 'fire_station': return { prog: 'hall', main: 'workshop' };
    case 'garage': case 'shed': return { prog: 'hall', main: 'garage' };
    case 'farm': case 'greenhouse': return { prog: 'hall', main: 'barn' };
    case 'church': return { prog: 'hall', main: 'church' };
    default:
      if (cls === 'other' && area < 25) return { prog: 'hall', main: 'store' };
      return area > 260 ? { prog: 'flats', main: 'flat' } : { prog: 'house', main: 'living' };
  }
}

/** A wing off the main block: one or two rooms of a use that fits the building. */
function wing(prog: Prog, main: RoomKind, W: number, D: number, x: number, rng: Rng, entry = false): LRoom[] {
  if (prog === 'school' || prog === 'office' || prog === 'care' || prog === 'flats') {
    const sp = CORR[prog];
    if (W * D >= sp.target * 2.5) return corridor(prog, entry)(W, D, x, rng);
  }
  const prefs: Record<Prog, RoomKind[]> = {
    house: ['bed', 'kitchen', 'bath', 'store'],
    flat: ['bed', 'bath', 'store'],
    flats: ['flat', 'store'],
    school: ['class', 'gym', 'staff', 'office', 'store', 'toilet'],
    office: ['office', 'meeting', 'staff', 'store', 'toilet'],
    care: ['ward', 'staff', 'store', 'toilet'],
    shop: main === 'cafe' ? ['cafe', 'kitchen', 'store'] : [main, 'store'],
    hall: [main],
  };
  const kinds = entry && prog !== 'shop' && prog !== 'hall' ? ['hall', 'lobby', ...prefs[prog]] as RoomKind[] : prefs[prog];
  for (const k of kinds) {
    const r = [L(k, [B(0, W, 0, D)], -1, k === main && (prog === 'shop' || prog === 'hall') ? Math.min(3, W - 0.8) : 0.9)];
    if (valid(r, W, D, x)) return r;
  }
  return single(prog === 'shop' || prog === 'hall' ? main : 'store', W, D, x);
}

function blockLayout(prog: Prog, main: RoomKind, W: number, D: number, x: number, rng: Rng): LRoom[] {
  switch (prog) {
    case 'house': return house(W, D, x);
    case 'flat': return flatUnit(W, D, x);
    case 'shop': return shop(main)(W, D, x);
    case 'hall': return hall(main)(W, D, x);
    default: return corridor(prog, true)(W, D, x, rng);
  }
}

// ---------------------------------------------------------------- the whole plan

export interface PlanDoorIn {
  /** front door on the outline, metres in the plan frame */
  s: number;
  d: number;
  /** its outward normal */
  ns: number;
  nd: number;
}

const CIRCULATION = new Set<RoomKind>(['hall', 'lobby', 'shop', 'cafe', 'warehouse', 'workshop', 'barn', 'garage', 'church', 'living', 'studio', 'flat']);

/**
 * Lay out a building. rings: the footprint in metres in the plan frame, inside
 * [0, W] x [0, D]; door: the front door on it.
 */
export function makeFloorPlan(rings: number[][], W: number, D: number, door: PlanDoorIn, cls: string, area: number, seed: number): FloorPlan {
  const rng = new Rng(seed);
  const { prog, main } = programmeFor(cls, area);
  let blocks = decompose(rings, W, D);
  if (!blocks.length) blocks = [B(0, W, 0, D)];
  const nb = blocks.length;

  // the block the front door opens into, and which of its sides it is on
  const sideNormal = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const sideDist = (b: Box, side: number) => {
    const s = clamp(door.s, b.s0, b.s1), d = clamp(door.d, b.d0, b.d1);
    const ps = side === 1 ? b.s1 : side === 3 ? b.s0 : s, pd = side === 0 ? b.d0 : side === 2 ? b.d1 : d;
    return Math.hypot(door.s - ps, door.d - pd);
  };
  let root = 0, rootSide = 0, bestScore = Infinity;
  blocks.forEach((b, k) => {
    for (let side = 0; side < 4; side++) {
      const dot = door.ns * sideNormal[side][0] + door.nd * sideNormal[side][1];
      const sc = sideDist(b, side) - dot * 2.5 - Math.sqrt(boxArea(b)) * 0.02;
      if (sc < bestScore) { bestScore = sc; root = k; rootSide = side; }
    }
  });

  // blocks in order of reach from the front door, each entered from one it touches
  const sideOf = new Array<number>(nb).fill(-1), parentOf = new Array<number>(nb).fill(-1);
  const order = [root];
  sideOf[root] = rootSide;
  for (let q = 0; q < order.length; q++) {
    const p = blocks[order[q]];
    for (let k = 0; k < nb; k++) {
      if (sideOf[k] >= 0) continue;
      const c = blocks[k];
      for (const sg of sharedSegs([c], [p])) {
        if (sg.b - sg.a < 1.4) continue;
        sideOf[k] = sg.along === 0 ? (Math.abs(sg.c - c.d0) < 1e-6 ? 0 : 2) : (Math.abs(sg.c - c.s0) < 1e-6 ? 3 : 1);
        parentOf[k] = order[q];
        order.push(k);
        break;
      }
    }
  }

  const rooms: FPRoom[] = [];
  for (const bi of order) {
    const f = new Frame(blocks[bi], sideOf[bi]);
    let x: number;
    let entryParent = -1;
    if (bi === root) x = clamp(f.x(door.s, door.d), Math.min(0.6, f.W / 2), Math.max(f.W - 0.6, f.W / 2));
    else {
      // where to break through: preferably from a corridor or other open space
      const seg = longest(sharedSegs([blocks[bi]], [blocks[parentOf[bi]]]))!;
      let best = -Infinity, at = (seg.a + seg.b) / 2;
      rooms.forEach((r, i) => {
        if (r.block !== parentOf[bi]) return;
        for (const s of sharedSegs(r.parts, [blocks[bi]])) {
          const a = Math.max(s.a, seg.a), b = Math.min(s.b, seg.b);
          if (b - a < 1.5) continue;
          const sc = (CIRCULATION.has(r.kind) ? 100 : 0) + (b - a);
          if (sc > best) { best = sc; entryParent = i; at = (a + b) / 2; }
        }
      });
      if (entryParent < 0) {
        rooms.forEach((r, i) => {
          if (r.block !== parentOf[bi]) return;
          for (const s of sharedSegs(r.parts, [blocks[bi]])) {
            if (s.b - s.a > best) { best = s.b - s.a; entryParent = i; at = (s.a + s.b) / 2; }
          }
        });
      }
      x = seg.along === 0 ? f.x(at, seg.c) : f.x(seg.c, at);
      x = clamp(x, Math.min(0.8, f.W / 2), Math.max(f.W - 0.8, f.W / 2));
    }
    // the biggest block holds the programme; a small block at the door is the way in
    const full = bi === 0 || (bi === root && boxArea(blocks[bi]) > 0.5 * boxArea(blocks[0]));
    const local = full ? blockLayout(prog, main, f.W, f.D, x, rng) : wing(prog, main, f.W, f.D, x, rng, bi === root);
    const off = rooms.length;
    for (const r of local) {
      rooms.push({
        kind: r.kind, parts: r.parts.map((p) => f.out(p)), ext: [], parent: r.parent >= 0 ? r.parent + off : entryParent,
        doorW: r.doorW, block: bi, kitchenette: r.kitchenette, free: r.free, at: r.at,
      });
    }
  }

  // grow parts on the block's outer sides out over the leftover slivers; earlier
  // (bigger) blocks claim first, and nothing grows into another block
  const done: Box[] = [];
  for (let bi = 0; bi < nb; bi++) {
    const bl = blocks[bi];
    const mine: Box[] = [];
    for (const r of rooms) {
      if (r.block !== bi) continue;
      r.ext = r.parts.map((p) => {
        const e = B(Math.abs(p.s0 - bl.s0) < 1e-6 ? Math.min(0, p.s0) : p.s0, Math.abs(p.s1 - bl.s1) < 1e-6 ? Math.max(W, p.s1) : p.s1,
          Math.abs(p.d0 - bl.d0) < 1e-6 ? Math.min(0, p.d0) : p.d0, Math.abs(p.d1 - bl.d1) < 1e-6 ? Math.max(D, p.d1) : p.d1);
        for (let k = 0; k < nb; k++) if (k !== bi) shrink(e, p, blocks[k]);
        for (const o of done) shrink(e, p, o);
        mine.push(e);
        return e;
      });
    }
    done.push(...mine);
  }

  return { W, D, blocks, rooms, walls: wallsOf(rooms, rings), doors: doorsOf(rooms, rng) };
}

/** Cut a grown rectangle back so it no longer overlaps o, keeping as much as possible. */
function shrink(e: Box, p: Box, o: Box) {
  if (!overlaps(e, o)) return;
  let best = -1, which = -1;
  const opts = [
    o.s0 >= p.s1 - 1e-6 ? (o.s0 - e.s0) * boxD(e) : -1,
    o.s1 <= p.s0 + 1e-6 ? (e.s1 - o.s1) * boxD(e) : -1,
    o.d0 >= p.d1 - 1e-6 ? (o.d0 - e.d0) * boxW(e) : -1,
    o.d1 <= p.d0 + 1e-6 ? (e.d1 - o.d1) * boxW(e) : -1,
  ];
  opts.forEach((v, i) => { if (v > best) { best = v; which = i; } });
  if (which === 0) e.s1 = o.s0;
  else if (which === 1) e.s0 = o.s1;
  else if (which === 2) e.d1 = o.d0;
  else if (which === 3) e.d0 = o.d1;
}

/** Walls: every edge of a room's area that is not shared with the same room, inside the footprint. */
function wallsOf(rooms: FPRoom[], rings: number[][]): number[] {
  const segs: Seg[] = [];
  const xs: number[] = [];
  rooms.forEach((r) => {
    for (const e of r.ext) {
      for (const [along, c, a, b, other] of [[0, e.d0, e.s0, e.s1, -1], [0, e.d1, e.s0, e.s1, 1], [1, e.s0, e.d0, e.d1, -1], [1, e.s1, e.d0, e.d1, 1]] as const) {
        // parts of this edge the same room continues across
        let ivs: [number, number][] = [[a, b]];
        for (const f of r.ext) {
          if (f === e) continue;
          const touch = along === 0 ? (other < 0 ? Math.abs(f.d1 - c) < 1e-6 : Math.abs(f.d0 - c) < 1e-6) : (other < 0 ? Math.abs(f.s1 - c) < 1e-6 : Math.abs(f.s0 - c) < 1e-6);
          if (!touch) continue;
          const fa = along === 0 ? f.s0 : f.d0, fb = along === 0 ? f.s1 : f.d1;
          ivs = cut(ivs, fa, fb);
        }
        for (const [ia, ib] of ivs) {
          // keep only what lies inside the footprint
          xs.length = 0;
          xs.push(ia, ib);
          for (const ring of rings) {
            const n = ring.length / 2;
            for (let i = 0, j = n - 1; i < n; j = i++) {
              const p0 = along === 0 ? ring[j * 2 + 1] : ring[j * 2], p1 = along === 0 ? ring[i * 2 + 1] : ring[i * 2];
              if ((p0 - c) * (p1 - c) >= 0 && !(p0 === c && p1 !== c)) continue;
              const t = (c - p0) / (p1 - p0);
              const q0 = along === 0 ? ring[j * 2] : ring[j * 2 + 1], q1 = along === 0 ? ring[i * 2] : ring[i * 2 + 1];
              const v = q0 + t * (q1 - q0);
              if (v > ia && v < ib) xs.push(v);
            }
          }
          xs.sort((u, v) => u - v);
          for (let k = 0; k + 1 < xs.length; k++) {
            const u = xs[k], v = xs[k + 1];
            if (v - u < 0.05) continue;
            const m = (u + v) / 2;
            if (along === 0 ? pointInPolygon(m, c, rings) : pointInPolygon(c, m, rings)) segs.push({ along, c, a: u, b: v });
          }
        }
      }
    }
  });
  // merge collinear pieces
  segs.sort((p, q) => p.along - q.along || p.c - q.c || p.a - q.a);
  const out: number[] = [];
  let cur: Seg | null = null;
  const flush = () => { if (cur && cur.b - cur.a > 0.05) out.push(...(cur.along === 0 ? [cur.a, cur.c, cur.b, cur.c] : [cur.c, cur.a, cur.c, cur.b])); };
  for (const s of segs) {
    if (cur && s.along === cur.along && Math.abs(s.c - cur.c) < 1e-4 && s.a <= cur.b + 1e-4) cur.b = Math.max(cur.b, s.b);
    else { flush(); cur = { ...s }; }
  }
  flush();
  return out;
}

function cut(ivs: [number, number][], a: number, b: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [u, v] of ivs) {
    if (b <= u || a >= v) { out.push([u, v]); continue; }
    if (a > u) out.push([u, a]);
    if (b < v) out.push([b, v]);
  }
  return out;
}

/** One door from each room into the room it is reached from, clear of the corners. */
function doorsOf(rooms: FPRoom[], rng: Rng): FPDoor[] {
  const out: FPDoor[] = [];
  rooms.forEach((r, i) => {
    if (r.parent < 0) return;
    const s = longest(sharedSegs(r.parts, rooms[r.parent].parts));
    if (!s) return;
    const len = s.b - s.a;
    const w = Math.min(r.doorW, len - 0.6);
    if (w < 0.6) return;
    const m = 0.3 + w / 2;
    const t = r.at ?? 0.3 + rng.next() * 0.4;
    const p = s.a + m + (len - 2 * m) * t;
    out.push(s.along === 0 ? { s: p, d: s.c, along: 0, w, a: i, b: r.parent } : { s: s.c, d: p, along: 1, w, a: i, b: r.parent });
  });
  return out;
}

/** The dominant wall direction: the angle (mod 90°) most of the outline's length runs along. */
export function dominantAxis(ring: ArrayLike<number>): [number, number] {
  const n = ring.length / 2;
  const ang: number[] = [], len: number[] = [], dir: number[] = [];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const dx = ring[i * 2] - ring[j * 2], dy = ring[i * 2 + 1] - ring[j * 2 + 1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    let a = Math.atan2(dy, dx) % (Math.PI / 2);
    if (a < 0) a += Math.PI / 2;
    ang.push(a); len.push(l); dir.push(Math.atan2(dy, dx));
  }
  if (!ang.length) return [1, 0];
  const tol = (4 * Math.PI) / 180, Q = Math.PI / 2;
  const near = (a: number, b: number) => { const d = Math.abs(a - b) % Q; return Math.min(d, Q - d) < tol; };
  let best = 0, bi = 0;
  for (let i = 0; i < ang.length; i++) {
    let sc = 0;
    for (let j = 0; j < ang.length; j++) if (near(ang[i], ang[j])) sc += len[j];
    if (sc > best + 1e-9) { best = sc; bi = i; }
  }
  // length-weighted mean of the group (on a 90° circle)
  let cx = 0, cy = 0;
  for (let j = 0; j < ang.length; j++) if (near(ang[bi], ang[j])) { cx += Math.cos(ang[j] * 4) * len[j]; cy += Math.sin(ang[j] * 4) * len[j]; }
  let a = Math.atan2(cy, cx) / 4;
  // of the four directions, the one closest to the longest edge in the group
  let li = -1;
  for (let j = 0; j < ang.length; j++) if (near(ang[bi], ang[j]) && (li < 0 || len[j] > len[li])) li = j;
  const dirA = dir[li];
  while (a < dirA - Math.PI / 4) a += Q;
  while (a > dirA + Math.PI / 4) a -= Q;
  return [Math.cos(a), Math.sin(a)];
}
