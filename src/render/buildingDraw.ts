// Buildings drawn as clean geometry at screen resolution, in the arcade style
// (docs/ART_STYLE.md section 0), from the BuildingModel the chunk worker made
// (world/buildingModel.ts). Nothing here looks at the map outline.
//
// The camera is the light 3/4 cheat of old Pokémon and Project Zomboid: the
// ground is seen from straight above and anything with height rises straight
// up the screen. A wall of height h at world (x, y) covers the screen from y up
// to y - h. So south-facing walls show their facade (windows, doors,
// shopfronts), roofs sit on top with two flat cel-shaded slopes meeting at a
// straight ridge, and a building hides what stands behind it.
//
// Each building is painted once per zoom level into its own offscreen canvas
// (crisp straight edges, a dark outline of constant screen thickness) and then
// blitted every frame, y-sorted with people and trees by the renderer.

import { hash2 } from '../core/rng';
import type { BuildingModel, Wing } from '../world/buildingModel';
import { exposedParts, modelOutline, sideLine } from '../world/buildingShape';
import { PALETTE, SHADOW_ALPHA, rgbOf } from './palette';

/** On-screen height per metre of real height, as a fraction of a ground metre. */
export const HEIGHT_K = 0.8;

type RGB = [number, number, number];
const hex = rgbOf;
const css = (c: RGB, a = 1) => (a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`);
const mul = (c: RGB, k: number): RGB => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const OUTLINE = PALETTE.outline;
const OUT_RGB = hex(OUTLINE);

// ------------------------------------------------------------------ colours

// Dutch roofs: red and orange ceramic tiles, anthracite concrete tiles, a few browns
const TILE_RED = hex('#c4473b'), TILE_ORANGE = hex('#d4683c'), TILE_BROWN = hex('#a65c3b');
const TILE_ANTH = hex('#4a4d5e'), TILE_SLATE = hex('#4f6079'), TILE_TEAL = hex('#3f8f8c');
const FLAT_ROOFS = ['#a9a7a2', '#c2bcb0', '#8e8b88', '#b5bcc4'].map(hex);
const METAL_ROOFS = ['#a7b2bd', '#8fa2b4', '#b9b4a6', '#7f9a9c'].map(hex);
const GLASS = hex(PALETTE.glass);
const BURNT = hex(PALETTE.roofBurnt), EMBER = hex('#ff7a1c'), GLOW = hex('#ffc23a');
// Dutch brick: brown, red, orange-red, a darker clinker and the yellow "gele steen"
const BRICKS = ['#a4553d', '#b9553a', '#c8673f', '#8e4a38', '#c99a5e'].map(hex);
const RENDERS = ['#efe6cf', '#e6dcc4', '#f2f0ea', '#d9e3dc'].map(hex);
const CONCRETE = ['#c8c8c0', '#bcc0c4', '#d2cdc0'].map(hex);
const CLADDING = ['#5f8fa8', '#7d8c96', '#a8b0b4', '#4f7a6a', '#b8a888'].map(hex);
const STONE = hex('#c4b89c');
const FRAME = hex('#f6f3ea'), GLASS_DK = hex('#2c4770'), GLASS_HI = hex('#7fb6e6'), GLASS_BURNT = hex('#1e1416');
const SHOPGLASS = hex('#5fb4d8'), SHOPGLASS_HI = hex('#c8ecf8'), SHOP_FRAME = hex('#2e3450');
const DOORS = ['#2f8a4a', '#2b5aa8', '#c0342a', '#f0b830', '#3a3a50', '#f0ece2', '#1f7f86'].map(hex);
const SIGNS = ['#d83a32', '#2a8a4a', '#2b62b8', '#f0a020', '#8a3ab0', '#1f9a9a'].map(hex);
const BOARD = hex('#b07a40');
const SOLAR = hex('#2a4580'), SOLAR_LINE = hex('#8aa6dc');
const CHIMNEY = hex('#a8503a'), CHIMNEY_CAP = hex('#5a5560');
const AC = hex('#e4e6e8'), AC_FAN = hex('#4a4e5a'), HATCH = hex('#9aa0a8');
const STEP = hex('#bdb8ae');

const HALLS = new Set(['industrial', 'warehouse', 'garage', 'mechanic', 'farm', 'shed', 'fire_station', 'military']);
const HOMES = new Set(['house', 'residential', 'other', 'detached', 'semidetached_house', 'terrace']);

interface Look {
  wall: RGB;
  wallKind: 'brick' | 'render' | 'metal' | 'stone';
  pitched: RGB;
  flat: RGB;
  door: RGB;
  sign: RGB;
  burnt: boolean;
}

/** Colours of one building. Houses in a row (or a block) share a family and vary gently. */
export function lookOf(m: BuildingModel, cx: number, cy: number): Look {
  const s = m.seed >>> 0;
  // the group: the terrace row if the model knows it, else a ~40 m block
  const cell = 40 * m.tpm;
  const g = m.row ? hashStr(m.row) : hash2(Math.floor(cx / cell), Math.floor(cy / cell), 0x7e1);
  const vary = (c: RGB, amt = 0.05) => mul(c, 1 + (((s >>> 3) % 9) - 4) * (amt / 4));
  let pitched: RGB, wall: RGB, wallKind: Look['wallKind'] = 'brick';
  if (m.cls === 'church') {
    pitched = s % 3 ? TILE_SLATE : TILE_TEAL;
    wall = s % 2 ? STONE : BRICKS[3];
    wallKind = 'stone';
  } else if (HALLS.has(m.cls)) {
    pitched = m.cls === 'farm' || m.cls === 'shed' ? (s % 2 ? TILE_ANTH : TILE_BROWN) : METAL_ROOFS[s % METAL_ROOFS.length];
    wall = (s >>> 5) % 4 === 0 ? BRICKS[(s >>> 7) % BRICKS.length] : CLADDING[(s >>> 7) % CLADDING.length];
    wallKind = (s >>> 5) % 4 === 0 ? 'brick' : 'metal';
  } else if (HOMES.has(m.cls) || m.row) {
    const h = g % 20;
    pitched = h < 7 ? TILE_RED : h < 10 ? TILE_ORANGE : h < 16 ? TILE_ANTH : h < 18 ? TILE_BROWN : TILE_SLATE;
    // a row keeps one brick; one house in ~9 was rendered white by its owner
    wall = (s >>> 9) % 9 === 0 && !m.row ? RENDERS[(s >>> 4) % RENDERS.length] : BRICKS[(g >>> 5) % 4];
    wallKind = 'brick';
    pitched = vary(pitched, 0.06);
    wall = vary(wall, 0.07);
  } else if (m.cls === 'apartments') {
    // a block of flats is built in one go: one brick (or render) for the whole block
    pitched = (g >>> 3) % 2 ? TILE_ANTH : TILE_RED;
    const k = (g >>> 7) % 5;
    wall = k < 3 ? BRICKS[(g >>> 9) % BRICKS.length] : k === 3 ? RENDERS[(g >>> 9) % RENDERS.length] : CONCRETE[(g >>> 9) % CONCRETE.length];
    wallKind = k < 3 ? 'brick' : 'render';
    wall = vary(wall, 0.05);
  } else {
    pitched = (s >>> 2) % 2 ? TILE_ANTH : TILE_RED;
    const k = (s >>> 5) % 4;
    wall = k < 2 ? RENDERS[s % RENDERS.length] : k === 2 ? BRICKS[(s >>> 7) % BRICKS.length] : CONCRETE[s % CONCRETE.length];
    wallKind = k === 2 ? 'brick' : 'render';
  }
  const flat = m.cls === 'greenhouse' ? GLASS : HALLS.has(m.cls) ? METAL_ROOFS[(s >>> 3) % METAL_ROOFS.length] : FLAT_ROOFS[(s >>> 3) % FLAT_ROOFS.length];
  if (m.burnt) {
    wall = mix(wall, BURNT, 0.55);
    pitched = BURNT;
  }
  return { wall, wallKind, pitched, flat: m.burnt ? BURNT : flat, door: DOORS[(s >>> 11) % DOORS.length], sign: SIGNS[(s >>> 13) % SIGNS.length], burnt: m.burnt };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ------------------------------------------------------------------ records

/** A building as the renderer keeps it: the model plus what culling and sorting need. */
export interface BuildingRec {
  m: BuildingModel;
  /** footprint bounding box, world texels */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** highest point above the ground, metres */
  top: number;
  /** sort key: the southern-most point of the footprint (world texels) */
  key: number;
  /** squared-up outline, world texels */
  outline: number[][];
  look: Look;
  /** on-screen height per metre for this building (very tall ones are squashed a little) */
  hk: number;
  /** chunks holding this building */
  refs: number;
  /** drop shadow and doormat polygons (world texels), made on first use */
  shadow?: number[][];
  mats?: number[][];
}

export function makeRec(m: BuildingModel): BuildingRec {
  const outline = modelOutline(m);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of outline) for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
  }
  let top = 0;
  for (const w of m.wings) top = Math.max(top, w.wallH + (w.roof === 'flat' ? 1.2 : w.roofH) + 1);
  // towers and churches would cover half the town: above 14 m heights count for a
  // third, and nothing is drawn taller than 22 m
  const drawn = top <= 14 ? top : Math.min(22, 14 + (top - 14) * 0.35);
  return { m, x0, y0, x1, y1, top, key: y1, outline, look: lookOf(m, (x0 + x1) / 2, (y0 + y1) / 2), hk: (HEIGHT_K * drawn) / top, refs: 0 };
}

/** How far up the screen (world texels) a building's art reaches above its footprint. */
export const riseOf = (r: BuildingRec) => r.top * r.hk * r.m.tpm;

// ------------------------------------------------------------------ geometry

/** Model frame (metres, plus height) -> canvas pixels. */
interface Proj {
  m: BuildingModel;
  /** world texel at canvas (0, 0) */
  ax: number;
  ay: number;
  /** canvas pixels per world texel */
  ppt: number;
  /** canvas pixels of outline */
  o: number;
  /** on-screen height per metre */
  hk: number;
}

type P3 = [number, number, number];

function pt(P: Proj, s: number, d: number, z: number): [number, number] {
  const m = P.m, k = m.tpm;
  const x = m.ox + (m.ux * s - m.uy * d) * k, y = m.oy + (m.uy * s + m.ux * d) * k;
  return [(x - P.ax) * P.ppt, (y - P.ay - z * P.hk * k) * P.ppt];
}

function path(g: CanvasRenderingContext2D, P: Proj, pts: P3[]) {
  g.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pt(P, pts[i][0], pts[i][1], pts[i][2]);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.closePath();
}

/** World-frame normal of a polygon given in model coordinates (s, d, z): [nx, ny, nz]. */
function normalOf(m: BuildingModel, p: P3[]): [number, number, number] {
  // Newell's method in model frame (s, d, z); s and d are a rotation of world x, y
  let ns = 0, nd = 0, nz = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    ns += (a[1] - b[1]) * (a[2] + b[2]);
    nd += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(ns, nd, nz) || 1;
  ns /= l; nd /= l; nz /= l;
  // the model frame is right-handed in (s, d) like world (x, y), so z keeps its sign
  const nx = m.ux * ns - m.uy * nd, ny = m.uy * ns + m.ux * nd;
  // face the normal upwards / outwards consistently: callers pass outward-wound polygons
  return [nx, ny, nz];
}

/** Can the camera see a face with this outward normal? (view direction: south and up) */
const facesCamera = (n: [number, number, number]) => n[1] + n[2] / HEIGHT_K > 1e-3;

/** Cel tone of a roof face: 1.12 lit (facing the NW sun), 1 base, 0.8 shade. */
function roofTone(n: [number, number, number]): number {
  const lam = -0.55 * n[0] - 0.55 * n[1] + 0.63 * n[2];
  return lam > 0.62 ? 1.12 : lam > 0.36 ? 1 : 0.8;
}
/** Walls: west faces catch the light, south faces are the base, east faces sit in shade. */
function wallTone(nx: number, ny: number): number {
  const lam = -0.8 * nx - 0.25 * ny;
  return lam > 0.3 ? 1.1 : lam > -0.45 ? 1 : 0.78;
}

const EAVES = 0.35;
const VERGE = 0.15;

interface Roof {
  /** roof faces (outward-wound, model frame) */
  faces: { p: P3[]; slope: boolean }[];
  /** z of the roof at (s, d) inside the wing (for props) */
  z: (s: number, d: number) => number;
  /** wall top above a point on side `side` at position `a` along it */
  wallTop: (side: number, a: number) => number;
  /** extra breakpoints along a side where the wall top bends */
  bends: (side: number) => number[];
}

/** The roof of a wing. `ex[side]` is the overhang at each side (0 at party walls and inner joins). */
function roofOf(w: Wing, ex: number[], m: BuildingModel): Roof {
  const b = w.box, H = w.wallH;
  const sm = (b.s0 + b.s1) / 2, dm = (b.d0 + b.d1) / 2;
  const hs = (b.s1 - b.s0) / 2, hd = (b.d1 - b.d0) / 2;
  const S0 = b.s0 - ex[3], S1 = b.s1 + ex[1], D0 = b.d0 - ex[0], D1 = b.d1 + ex[2];
  const flatRoof = (): Roof => ({
    faces: [{ p: [[b.s0, b.d0, H], [b.s1, b.d0, H], [b.s1, b.d1, H], [b.s0, b.d1, H]], slope: false }],
    z: () => H, wallTop: () => H, bends: () => [],
  });
  const R = w.roofH;
  if (w.roof === 'flat' || R <= 0.2) return flatRoof();
  const T = H + R;
  if (w.roof === 'gable') {
    if (w.ridgeAlongS) {
      const k = R / hd;
      const z = (_s: number, d: number) => T - Math.abs(d - dm) * k;
      return {
        faces: [
          { p: [[S0, D0, T - (dm - D0) * k], [S1, D0, T - (dm - D0) * k], [S1, dm, T], [S0, dm, T]], slope: true },
          { p: [[S1, D1, T - (D1 - dm) * k], [S0, D1, T - (D1 - dm) * k], [S0, dm, T], [S1, dm, T]], slope: true },
        ],
        z,
        wallTop: (side, a) => (side === 1 || side === 3 ? T - Math.abs(a - dm) * k : H),
        bends: (side) => (side === 1 || side === 3 ? [dm] : []),
      };
    }
    const k = R / hs;
    const z = (s: number) => T - Math.abs(s - sm) * k;
    return {
      faces: [
        { p: [[S1, D0, T - (S1 - sm) * k], [S1, D1, T - (S1 - sm) * k], [sm, D1, T], [sm, D0, T]], slope: true },
        { p: [[S0, D1, T - (sm - S0) * k], [S0, D0, T - (sm - S0) * k], [sm, D0, T], [sm, D1, T]], slope: true },
      ],
      z: (s) => z(s),
      wallTop: (side, a) => (side === 0 || side === 2 ? T - Math.abs(a - sm) * k : H),
      bends: (side) => (side === 0 || side === 2 ? [sm] : []),
    };
  }
  if (w.roof === 'shed') {
    // one slope falling towards the camera: the high edge is the northern one
    // (d grows southwards when ux > 0, s when uy > 0)
    if (w.ridgeAlongS && m.ux < 0) {
      const k = R / (2 * hd);
      return {
        faces: [{ p: [[S1, D0, T - (b.d1 - D0) * k], [S0, D0, T - (b.d1 - D0) * k], [S0, b.d1, T], [S1, b.d1, T]], slope: true }],
        z: (_s, d) => T - (b.d1 - d) * k,
        wallTop: (side, a) => (side === 2 ? T : side === 0 ? H : T - (b.d1 - a) * k),
        bends: () => [],
      };
    }
    if (!w.ridgeAlongS && m.uy < 0) {
      const k = R / (2 * hs);
      return {
        faces: [{ p: [[S0, D1, T - (b.s1 - S0) * k], [S0, D0, T - (b.s1 - S0) * k], [b.s1, D0, T], [b.s1, D1, T]], slope: true }],
        z: (s) => T - (b.s1 - s) * k,
        wallTop: (side, a) => (side === 1 ? T : side === 3 ? H : T - (b.s1 - a) * k),
        bends: () => [],
      };
    }
    if (w.ridgeAlongS) {
      const k = R / (2 * hd);
      return {
        faces: [{ p: [[S0, D1, T - (D1 - b.d0) * k], [S1, D1, T - (D1 - b.d0) * k], [S1, b.d0, T], [S0, b.d0, T]], slope: true }],
        z: (_s, d) => T - (d - b.d0) * k,
        wallTop: (side, a) => (side === 0 ? T : side === 2 ? H : T - (a - b.d0) * k),
        bends: () => [],
      };
    }
    const k = R / (2 * hs);
    return {
      faces: [{ p: [[S1, D0, T - (S1 - b.s0) * k], [S1, D1, T - (S1 - b.s0) * k], [b.s0, D1, T], [b.s0, D0, T]], slope: true }],
      z: (s) => T - (s - b.s0) * k,
      wallTop: (side, a) => (side === 3 ? T : side === 1 ? H : T - (a - b.s0) * k),
      bends: () => [],
    };
  }
  // hip and mansard: every side slopes; the ridge runs along the longer axis
  const r = Math.min(hs, hd);
  if (w.roof === 'mansard') {
    const inset = Math.min(1.2, r * 0.45), zb = H + R * 0.85;
    const i0 = b.s0 + inset, i1 = b.s1 - inset, j0 = b.d0 + inset, j1 = b.d1 - inset;
    const zE = H - 0.1;
    return {
      faces: [
        { p: [[S0, D0, zE], [S1, D0, zE], [i1, j0, zb], [i0, j0, zb]], slope: true },
        { p: [[S1, D0, zE], [S1, D1, zE], [i1, j1, zb], [i1, j0, zb]], slope: true },
        { p: [[S1, D1, zE], [S0, D1, zE], [i0, j1, zb], [i1, j1, zb]], slope: true },
        { p: [[S0, D1, zE], [S0, D0, zE], [i0, j0, zb], [i0, j1, zb]], slope: true },
        { p: [[i0, j0, zb], [i1, j0, zb], [i1, j1, zb], [i0, j1, zb]], slope: false },
      ],
      z: () => zb, wallTop: () => H, bends: () => [],
    };
  }
  const k = R / r;
  const zE = (e: number) => H - e * k;
  const z = (s: number, d: number) => T - Math.max(Math.abs(d - dm) - (hd - r), Math.abs(s - sm) - (hs - r), 0) * k;
  if (hs >= hd) {
    const r0 = sm - (hs - r), r1 = sm + (hs - r);
    return {
      faces: [
        { p: [[S0, D0, zE(ex[0])], [S1, D0, zE(ex[0])], [r1, dm, T], [r0, dm, T]], slope: true },
        { p: [[S1, D0, zE(ex[1])], [S1, D1, zE(ex[1])], [r1, dm, T]], slope: true },
        { p: [[S1, D1, zE(ex[2])], [S0, D1, zE(ex[2])], [r0, dm, T], [r1, dm, T]], slope: true },
        { p: [[S0, D1, zE(ex[3])], [S0, D0, zE(ex[3])], [r0, dm, T]], slope: true },
      ],
      z, wallTop: () => H, bends: () => [],
    };
  }
  const r0 = dm - (hd - r), r1 = dm + (hd - r);
  return {
    faces: [
      { p: [[S0, D0, zE(ex[0])], [S1, D0, zE(ex[0])], [sm, r0, T]], slope: true },
      { p: [[S1, D0, zE(ex[1])], [S1, D1, zE(ex[1])], [sm, r1, T], [sm, r0, T]], slope: true },
      { p: [[S1, D1, zE(ex[2])], [S0, D1, zE(ex[2])], [sm, r1, T]], slope: true },
      { p: [[S0, D1, zE(ex[3])], [S0, D0, zE(ex[3])], [sm, r0, T], [sm, r1, T]], slope: true },
    ],
    z, wallTop: () => H, bends: () => [],
  };
}

/** World outward normal of a wing side. */
function sideNormal(m: BuildingModel, side: number): [number, number] {
  switch (side) {
    case 0: return [m.uy, -m.ux];
    case 1: return [m.ux, m.uy];
    case 2: return [-m.uy, m.ux];
    default: return [-m.ux, -m.uy];
  }
}

/** A point in model coordinates on side `side` of box b, `a` along it, `off` outwards. */
function onSide(b: Wing['box'], side: number, a: number, off = 0): [number, number] {
  const L = sideLine(b, side);
  const f = L.fixed + L.out * off;
  return L.alongS ? [a, f] : [f, a];
}

// ------------------------------------------------------------------ painting

export interface PaintOptions {
  /** windows, doors, tiles and roof props (off for small, far-away buildings) */
  detail: boolean;
  /** is the world point (texels) inside some other building? (party walls) */
  other?: (x: number, y: number) => boolean;
  /** quick version for far zooms: flat faces each with a thin outline, no silhouette pass */
  fast?: boolean;
}

interface Part { wing: number; side: number; a: number; c: number; n: [number, number] }

/** Outside wall pieces of every wing, with party walls (against a neighbouring building) removed. */
function outsideWalls(m: BuildingModel, other?: (x: number, y: number) => boolean): { parts: Part[]; ex: number[][] } {
  const parts: Part[] = [];
  const ex: number[][] = [];
  m.wings.forEach((w, wi) => {
    const e = [0, 0, 0, 0];
    for (let side = 0; side < 4; side++) {
      const L = sideLine(w.box, side);
      const n = sideNormal(m, side);
      let len = 0;
      for (const [a, c] of exposedParts(m, wi, side)) {
        let pieces: [number, number][] = [[a, c]];
        if (other) {
          // split at 1 m steps and drop the pieces that back onto a neighbour
          const segs = Math.max(1, Math.round((c - a) / 1));
          pieces = [];
          let run = -1;
          for (let k = 0; k <= segs; k++) {
            const at = a + ((c - a) * (k + 0.5)) / segs;
            const shared = k < segs && (() => { const [s, d] = onSide(w.box, side, at, 0.45); const k2 = m.tpm; return other(m.ox + (m.ux * s - m.uy * d) * k2, m.oy + (m.uy * s + m.ux * d) * k2); })();
            if (k < segs && !shared) { if (run < 0) run = k; }
            else if (run >= 0) { pieces.push([a + ((c - a) * run) / segs, a + ((c - a) * k) / segs]); run = -1; }
          }
        }
        for (const [p, q] of pieces) {
          parts.push({ wing: wi, side, a: p, c: q, n });
          len += q - p;
        }
      }
      // overhang only where most of the side is an outside wall
      const full = L.a1 - L.a0;
      e[side] = len > full * 0.6 ? (w.roof === 'gable' && (w.ridgeAlongS ? side % 2 === 1 : side % 2 === 0) ? VERGE : EAVES) : 0;
      if (w.roof === 'flat') e[side] = 0;
    }
    ex.push(e);
  });
  return { parts, ex };
}

/**
 * Paint one building into `g` with projection P. Draws the dark silhouette
 * first (every face stroked fat in the outline colour), then the faces back to
 * front, each followed by its details, so the outline stays a constant
 * `P.o` pixels wide all around.
 */
function paint(g: CanvasRenderingContext2D, rec: BuildingRec, P: Proj, opt: PaintOptions) {
  const m = rec.m, look = rec.look;
  const { parts, ex } = outsideWalls(m, opt.other);
  // wings back to front: the one reaching furthest south last
  const order = m.wings.map((w, i) => {
    let y = -Infinity;
    for (const [s, d] of [[w.box.s0, w.box.d0], [w.box.s1, w.box.d0], [w.box.s1, w.box.d1], [w.box.s0, w.box.d1]]) y = Math.max(y, m.uy * s + m.ux * d);
    return { i, y };
  }).sort((a, b) => a.y - b.y).map((o) => o.i);

  interface Face { pts: P3[]; fill: RGB; after?: () => void; edge?: RGB }
  const faces: Face[] = [];
  const roofs = m.wings.map((w, i) => roofOf(w, ex[i], m));
  const seed = m.seed >>> 0;
  let chimneyDone = false, solarDone = false;
  for (const wi of order) {
    const w = m.wings[wi];
    const roof = roofs[wi];
    // walls facing the camera
    for (const p of parts) {
      if (p.wing !== wi || p.n[1] <= 0.02) continue;
      const bends = roof.bends(p.side).filter((v) => v > p.a && v < p.c);
      const top: P3[] = [];
      for (const a of [p.c, ...bends.slice().reverse(), p.a]) {
        const [s, d] = onSide(w.box, p.side, a);
        top.push([s, d, roof.wallTop(p.side, a)]);
      }
      const [sa, da] = onSide(w.box, p.side, p.a), [sc, dc] = onSide(w.box, p.side, p.c);
      // wind outward: along the side's direction as seen from outside
      const pts: P3[] = [[sa, da, 0], [sc, dc, 0], ...top];
      const tone = wallTone(p.n[0], p.n[1]);
      const fill = mul(look.wall, tone);
      faces.push({
        pts, fill, edge: mul(fill, 0.72),
        after: opt.detail ? () => {
          // a darker plinth where the wall meets the ground
          path(g, P, [[sa, da, 0], [sc, dc, 0], [sc, dc, 0.35], [sa, da, 0.35]]);
          g.fillStyle = css(mul(fill, 0.74));
          g.fill();
          wallDetail(g, P, rec, w, wi, p, roof, fill);
        } : undefined,
      });
    }
    // roof faces, back-facing first
    const rf = roof.faces.map((f) => ({ f, n: normalOf(m, f.p) }));
    // make normals point up
    for (const x of rf) if (x.n[2] < 0) { x.n = [-x.n[0], -x.n[1], -x.n[2]]; }
    rf.sort((a, b) => a.n[1] - b.n[1]);
    const flatTop = w.roof === 'flat' || w.roofH <= 0.2;
    for (const { f, n } of rf) {
      if (!facesCamera(n)) continue;
      const base = flatTop || !f.slope ? (w.roof === 'mansard' ? look.pitched : look.flat) : look.pitched;
      const fill = mul(base, f.slope ? roofTone(n) : 1);
      faces.push({
        pts: f.p, fill, edge: mul(fill, 0.7),
        after: opt.detail ? () => {
          if (f.slope) {
            tileRows(g, P, f.p, fill, look.wallKind === 'metal' && HALLS.has(m.cls));
            if (!solarDone && !look.burnt && n[1] > 0.15 && HOMES.has(m.cls) && seed % 4 === 1) { solarDone = solar(g, P, f.p); }
          } else if (flatTop) flatDetail(g, P, rec, w, wi);
          if (look.burnt && f.slope) burntHoles(g, P, f.p, seed + wi);
          if (f.slope && !look.burnt) ridgeCap(g, P, f.p, look.pitched);
        } : undefined,
      });
    }
    // a chimney on the main pitched wing of a house
    if (opt.detail && !chimneyDone && !flatTop && w.roof !== 'shed' && (HOMES.has(m.cls) || m.cls === 'apartments') && seed % 3 !== 0) {
      chimneyDone = true;
      const b = w.box;
      const t = 0.25 + ((seed >>> 4) % 50) / 100;
      const along = w.ridgeAlongS || w.roof !== 'gable';
      const s = along ? b.s0 + (b.s1 - b.s0) * t : (b.s0 + b.s1) / 2 + 0.6;
      const d = along ? (b.d0 + b.d1) / 2 - 0.6 : b.d0 + (b.d1 - b.d0) * t;
      faces.push({ pts: [], fill: CHIMNEY, after: () => box3(g, P, s - 0.3, s + 0.3, d - 0.3, d + 0.3, roof.z(s, d) - 0.4, roof.z(s, d) + 0.9, CHIMNEY, CHIMNEY_CAP) });
    }
  }

  if (opt.fast) {
    g.lineJoin = 'round';
    g.strokeStyle = OUTLINE;
    g.lineWidth = P.o;
    for (const f of faces) {
      if (f.pts.length < 3) continue;
      path(g, P, f.pts);
      g.fillStyle = css(f.fill);
      g.fill();
      g.stroke();
    }
    return;
  }
  // 1. silhouette: everything stroked fat in the outline colour
  g.lineJoin = 'round';
  g.fillStyle = OUTLINE;
  g.strokeStyle = OUTLINE;
  g.lineWidth = P.o * 2;
  for (const f of faces) {
    if (f.pts.length < 3) continue;
    path(g, P, f.pts);
    g.fill();
    g.stroke();
  }
  // 2. faces, back to front, each with its details
  g.lineJoin = 'miter';
  const thin = Math.max(1, P.o * 0.5);
  for (const f of faces) {
    if (f.pts.length >= 3) {
      path(g, P, f.pts);
      g.fillStyle = css(f.fill);
      g.fill();
      if (f.edge) {
        g.strokeStyle = css(f.edge);
        g.lineWidth = thin;
        g.stroke();
      }
    }
    f.after?.();
  }
}

/** Tile rows: thin lines parallel to the eaves, about every 0.4 m up the slope. */
function tileRows(g: CanvasRenderingContext2D, P: Proj, p: P3[], fill: RGB, metal: boolean) {
  let z0 = Infinity, z1 = -Infinity;
  for (const q of p) { z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); }
  if (z1 - z0 < 0.3) return;
  const px = P.ppt * P.m.tpm;
  g.strokeStyle = css(mul(fill, metal ? 1.12 : 0.86));
  g.lineWidth = Math.max(1, P.o * 0.4);
  g.beginPath();
  if (metal) {
    // corrugated sheets: ribs running down the slope, every ~0.6 m
    const top = p.filter((q) => q[2] > z1 - 0.01), bot = p.filter((q) => q[2] < z0 + 0.01);
    if (top.length < 2 || bot.length < 2 || px < 4) return;
    const n = Math.round(Math.hypot(bot[1][0] - bot[0][0], bot[1][1] - bot[0][1]) / 0.6);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      const a = pt(P, bot[0][0] + (bot[1][0] - bot[0][0]) * f, bot[0][1] + (bot[1][1] - bot[0][1]) * f, z0);
      // nearest point on the ridge line
      const t0 = top[0], t1 = top[top.length - 1];
      const tt = Math.max(0, Math.min(1, f));
      const b = pt(P, t1[0] + (t0[0] - t1[0]) * tt, t1[1] + (t0[1] - t1[1]) * tt, z1);
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    }
    g.stroke();
    return;
  }
  // level lines: where the face crosses z = const
  const rows = Math.floor((z1 - z0) / 0.32);
  if (rows < 2 || px * (z1 - z0) / rows < 4) return;
  for (let k = 1; k < rows; k++) {
    const z = z0 + ((z1 - z0) * k) / rows;
    const hits: [number, number][] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      if ((a[2] - z) * (b[2] - z) >= 0) continue;
      const t = (z - a[2]) / (b[2] - a[2]);
      hits.push(pt(P, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z));
    }
    if (hits.length < 2) continue;
    g.moveTo(hits[0][0], hits[0][1]);
    g.lineTo(hits[1][0], hits[1][1]);
  }
  g.stroke();
}

/** The ridge (and hips) of a slope: a light cap along its top edge. */
function ridgeCap(g: CanvasRenderingContext2D, P: Proj, p: P3[], base: RGB) {
  let top = -Infinity;
  for (const q of p) top = Math.max(top, q[2]);
  g.strokeStyle = css(mul(base, 1.3));
  g.lineWidth = Math.max(1, P.o * 0.8);
  g.lineCap = 'round';
  g.beginPath();
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    if (a[2] < top - 0.01 || b[2] < top - 0.01) continue;
    const pa = pt(P, a[0], a[1], a[2]), pb = pt(P, b[0], b[1], b[2]);
    g.moveTo(pa[0], pa[1]);
    g.lineTo(pb[0], pb[1]);
  }
  g.stroke();
  g.lineCap = 'butt';
}

/** A patch of solar panels lying on a slope. Returns true when drawn. */
function solar(g: CanvasRenderingContext2D, P: Proj, p: P3[]): boolean {
  if (p.length !== 4) return false;
  // shrink the face towards its middle
  const c: P3 = [0, 0, 0];
  for (const q of p) { c[0] += q[0] / 4; c[1] += q[1] / 4; c[2] += q[2] / 4; }
  const q = p.map((v) => [c[0] + (v[0] - c[0]) * 0.55, c[1] + (v[1] - c[1]) * 0.5, c[2] + (v[2] - c[2]) * 0.5] as P3);
  path(g, P, q);
  g.fillStyle = css(SOLAR);
  g.fill();
  g.strokeStyle = css(SOLAR_LINE);
  g.lineWidth = Math.max(1, P.o * 0.4);
  g.beginPath();
  for (let k = 1; k < 4; k++) {
    const f = k / 4;
    const a = pt(P, q[0][0] + (q[1][0] - q[0][0]) * f, q[0][1] + (q[1][1] - q[0][1]) * f, q[0][2] + (q[1][2] - q[0][2]) * f);
    const b = pt(P, q[3][0] + (q[2][0] - q[3][0]) * f, q[3][1] + (q[2][1] - q[3][1]) * f, q[3][2] + (q[2][2] - q[3][2]) * f);
    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
  }
  const a = pt(P, (q[0][0] + q[3][0]) / 2, (q[0][1] + q[3][1]) / 2, (q[0][2] + q[3][2]) / 2);
  const b = pt(P, (q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2, (q[1][2] + q[2][2]) / 2);
  g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
  g.stroke();
  path(g, P, q);
  g.strokeStyle = OUTLINE;
  g.stroke();
  return true;
}

function burntHoles(g: CanvasRenderingContext2D, P: Proj, p: P3[], seed: number) {
  const c: P3 = [0, 0, 0];
  for (const q of p) { c[0] += q[0] / p.length; c[1] += q[1] / p.length; c[2] += q[2] / p.length; }
  const [x, y] = pt(P, c[0], c[1], c[2]);
  const r = 0.9 * P.m.tpm * P.ppt * (0.7 + (seed % 5) / 10);
  g.fillStyle = css(hex('#140e10'));
  g.beginPath();
  g.ellipse(x, y, r, r * 0.6, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = css(EMBER, 0.85);
  g.beginPath();
  g.ellipse(x, y + r * 0.15, r * 0.45, r * 0.25, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = css(GLOW, 0.8);
  g.fillRect(x - r * 0.15, y, r * 0.3, r * 0.12);
}

/** A small box (chimney, AC unit) from z0 to z1 over [s0, s1] x [d0, d1]. */
function box3(g: CanvasRenderingContext2D, P: Proj, s0: number, s1: number, d0: number, d1: number, z0: number, z1: number, col: RGB, top: RGB) {
  const m = P.m;
  const sides: [P3[], [number, number]][] = [
    [[[s0, d0, z0], [s1, d0, z0], [s1, d0, z1], [s0, d0, z1]], sideNormal(m, 0)],
    [[[s1, d0, z0], [s1, d1, z0], [s1, d1, z1], [s1, d0, z1]], sideNormal(m, 1)],
    [[[s1, d1, z0], [s0, d1, z0], [s0, d1, z1], [s1, d1, z1]], sideNormal(m, 2)],
    [[[s0, d1, z0], [s0, d0, z0], [s0, d0, z1], [s0, d1, z1]], sideNormal(m, 3)],
  ];
  const lid: P3[] = [[s0, d0, z1], [s1, d0, z1], [s1, d1, z1], [s0, d1, z1]];
  const vis = sides.filter(([, n]) => n[1] > 0.02);
  g.fillStyle = OUTLINE;
  g.strokeStyle = OUTLINE;
  g.lineWidth = P.o * 1.4;
  g.lineJoin = 'round';
  for (const [q] of vis) { path(g, P, q); g.fill(); g.stroke(); }
  path(g, P, lid); g.fill(); g.stroke();
  for (const [q, n] of vis) { path(g, P, q); g.fillStyle = css(mul(col, wallTone(n[0], n[1]))); g.fill(); }
  path(g, P, lid);
  g.fillStyle = css(top);
  g.fill();
}

/** Flat roof: a light parapet rim around a darker field, and a few props. */
function flatDetail(g: CanvasRenderingContext2D, P: Proj, rec: BuildingRec, w: Wing, wi: number) {
  const b = w.box, H = w.wallH, m = rec.m;
  const e = Math.min(0.35, (b.s1 - b.s0) / 6, (b.d1 - b.d0) / 6);
  const field: P3[] = [[b.s0 + e, b.d0 + e, H], [b.s1 - e, b.d0 + e, H], [b.s1 - e, b.d1 - e, H], [b.s0 + e, b.d1 - e, H]];
  const base = rec.look.flat;
  path(g, P, field);
  g.fillStyle = css(mul(base, 0.9));
  g.fill();
  g.strokeStyle = css(mul(base, 0.72));
  g.lineWidth = Math.max(1, P.o * 0.5);
  g.stroke();
  if (rec.look.burnt) { burntHoles(g, P, field, m.seed + wi); return; }
  if (m.cls === 'greenhouse') {
    g.strokeStyle = css(mul(GLASS, 1.15));
    g.beginPath();
    for (let s = b.s0 + 1.5; s < b.s1; s += 1.5) { const a = pt(P, s, b.d0, H), c = pt(P, s, b.d1, H); g.moveTo(a[0], a[1]); g.lineTo(c[0], c[1]); }
    g.stroke();
    return;
  }
  // props, placed on a seeded grid inside the parapet
  const ws = b.s1 - b.s0, wd = b.d1 - b.d0;
  if (ws < 4 || wd < 4) return;
  let h = (m.seed >>> 0) ^ (wi * 0x9e3779b9);
  const rnd = () => { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; h ^= h >>> 12; return (h >>> 0) / 4294967296; };
  const n = Math.min(4, 1 + Math.floor((ws * wd) / 60));
  for (let k = 0; k < n; k++) {
    const s = b.s0 + 1.2 + rnd() * (ws - 3.2), d = b.d0 + 1.2 + rnd() * (wd - 3.2);
    const kind = rnd();
    if (kind < 0.45) {
      box3(g, P, s, s + 1.1, d, d + 0.8, H, H + 0.7, AC, mul(AC, 1.05));
      const c = pt(P, s + 0.55, d + 0.4, H + 0.7);
      g.fillStyle = css(AC_FAN);
      g.beginPath();
      g.arc(c[0], c[1], 0.25 * m.tpm * P.ppt, 0, Math.PI * 2);
      g.fill();
    } else if (kind < 0.75) {
      // skylight
      const q: P3[] = [[s, d, H + 0.15], [s + 1.4, d, H + 0.15], [s + 1.4, d + 0.9, H + 0.15], [s, d + 0.9, H + 0.15]];
      path(g, P, q);
      g.fillStyle = css(GLASS);
      g.fill();
      g.strokeStyle = OUTLINE;
      g.lineWidth = Math.max(1, P.o * 0.6);
      g.stroke();
    } else {
      box3(g, P, s, s + 0.8, d, d + 0.8, H, H + 0.35, HATCH, mul(HATCH, 1.1));
    }
  }
}

/** Windows, doors and shopfronts on one visible wall piece. */
function wallDetail(g: CanvasRenderingContext2D, P: Proj, rec: BuildingRec, w: Wing, wi: number, part: Part, roof: Roof, wall: RGB) {
  const m = rec.m, look = rec.look;
  const L = sideLine(w.box, part.side);
  const storeys = Math.max(1, Math.round(m.storeys));
  const sh = w.wallH / storeys;
  // a wall seen at a steep angle shows no openings: they would only be slivers
  const front = part.n[1] > 0.35;
  if (!front) return;
  const quad = (a0: number, a1: number, z0: number, z1: number): P3[] => {
    const [s0, d0] = onSide(w.box, part.side, a0), [s1, d1] = onSide(w.box, part.side, a1);
    return [[s0, d0, z0], [s1, d1, z0], [s1, d1, z1], [s0, d0, z1]];
  };
  const fillQ = (q: P3[], c: RGB) => { path(g, P, q); g.fillStyle = css(c); g.fill(); };
  const lw = Math.max(1, P.o * 0.5);
  let h = (m.seed >>> 0) ^ (wi * 0x85ebca6b) ^ (part.side * 0xc2b2ae35);
  const rnd = () => { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; h ^= h >>> 12; return (h >>> 0) / 4294967296; };
  for (const op of m.openings) {
    if (op.wing !== wi || op.side !== part.side) continue;
    const at = L.a0 + op.at;
    const a0 = at - op.w / 2, a1 = at + op.w / 2;
    if (a0 < part.a - 0.01 || a1 > part.c + 0.01) continue;
    if (op.kind === 'window') {
      const st = op.storey ?? 0;
      if (st >= storeys) continue;
      const z0 = st * sh + sh * 0.3, z1 = st * sh + sh * 0.82;
      if (z1 > roof.wallTop(part.side, a0) - 0.15 || z1 > roof.wallTop(part.side, a1) - 0.15) continue;
      window_(g, P, quad, a0, a1, z0, z1, look, rnd(), lw);
    } else if (op.kind === 'door') {
      const z1 = Math.min(2.3, sh * 0.85);
      fillQ(quad(a0 - 0.12, a1 + 0.12, 0, z1 + 0.12), FRAME);
      fillQ(quad(a0, a1, 0, z1), look.burnt ? GLASS_BURNT : look.door);
      // a small window in the door and a brass knob
      fillQ(quad(a0 + op.w * 0.25, a1 - op.w * 0.25, z1 * 0.62, z1 * 0.88), look.burnt ? GLASS_BURNT : GLASS_HI);
      const k = pt(P, ...onSide(w.box, part.side, a1 - op.w * 0.18), z1 * 0.45);
      g.fillStyle = '#ffd040';
      const r = Math.max(1, 0.06 * m.tpm * P.ppt);
      g.fillRect(k[0] - r, k[1] - r, r * 2, r * 2);
      // step
      const [s0, d0] = onSide(w.box, part.side, a0 - 0.2, 0.35), [s1, d1] = onSide(w.box, part.side, a1 + 0.2, 0.35);
      const [s2, d2] = onSide(w.box, part.side, a1 + 0.2, 0), [s3, d3] = onSide(w.box, part.side, a0 - 0.2, 0);
      path(g, P, [[s0, d0, 0.15], [s1, d1, 0.15], [s2, d2, 0.15], [s3, d3, 0.15]]);
      g.fillStyle = css(STEP);
      g.fill();
      g.strokeStyle = OUTLINE;
      g.lineWidth = lw;
      g.stroke();
      path(g, P, quad(a0 - 0.12, a1 + 0.12, 0, z1 + 0.12));
      g.stroke();
    } else if (op.kind === 'garage') {
      const z1 = Math.min(2.4, sh * 0.85);
      fillQ(quad(a0 - 0.1, a1 + 0.1, 0, z1 + 0.1), FRAME);
      const q = quad(a0, a1, 0, z1);
      fillQ(q, mul(CONCRETE[1], 0.95));
      g.strokeStyle = css(mul(CONCRETE[1], 0.7));
      g.lineWidth = lw;
      g.beginPath();
      for (let k = 1; k < 6; k++) { const z = (z1 * k) / 6; const a = pt(P, ...onSide(w.box, part.side, a0), z), b = pt(P, ...onSide(w.box, part.side, a1), z); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
      g.stroke();
    } else if (op.kind === 'shopfront') {
      const z1 = Math.min(sh * 0.78, 3.2);
      fillQ(quad(a0 - 0.15, a1 + 0.15, 0, z1 + 0.15), SHOP_FRAME);
      fillQ(quad(a0, a1, 0.25, z1), look.burnt ? GLASS_BURNT : SHOPGLASS);
      if (!look.burnt) {
        // a bright reflection band and mullions
        fillQ(quad(a0 + 0.2, a0 + op.w * 0.35, z1 * 0.55, z1 * 0.9), SHOPGLASS_HI);
        g.strokeStyle = css(SHOP_FRAME);
        g.lineWidth = lw * 1.5;
        g.beginPath();
        const n = Math.max(1, Math.round(op.w / 2.2));
        for (let k = 1; k < n; k++) { const a = a0 + (op.w * k) / n; const p = pt(P, ...onSide(w.box, part.side, a), 0), q = pt(P, ...onSide(w.box, part.side, a), z1); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); }
        g.stroke();
      }
      // sign band above the window
      const zs0 = z1 + 0.25, zs1 = Math.min(sh * 0.97, z1 + 0.85);
      if (zs1 > zs0 + 0.2) {
        fillQ(quad(a0, a1, zs0, zs1), look.burnt ? mul(look.sign, 0.4) : look.sign);
        path(g, P, quad(a0, a1, zs0, zs1));
        g.strokeStyle = OUTLINE;
        g.lineWidth = lw;
        g.stroke();
        // a few white "letters"
        g.fillStyle = css(FRAME, 0.9);
        const n = Math.max(2, Math.floor(op.w / 0.7));
        for (let k = 0; k < n; k++) {
          const a = a0 + op.w * (0.2 + (0.6 * k) / n);
          const p = pt(P, ...onSide(w.box, part.side, a), (zs0 + zs1) / 2 + 0.12);
          const sz = (zs1 - zs0) * 0.4 * m.tpm * P.ppt;
          g.fillRect(p[0], p[1], Math.max(1, sz * 0.7), sz);
        }
      }
    }
  }
  // gable end: a small attic window
  if (w.roof === 'gable' && (w.ridgeAlongS ? part.side % 2 === 1 : part.side % 2 === 0) && w.roofH > 2.4) {
    const mid = w.ridgeAlongS ? (w.box.d0 + w.box.d1) / 2 : (w.box.s0 + w.box.s1) / 2;
    if (mid > part.a + 0.6 && mid < part.c - 0.6) window_(g, P, quad, mid - 0.4, mid + 0.4, w.wallH + w.roofH * 0.15, w.wallH + w.roofH * 0.45, look, rnd(), lw);
  }
  void wall;
}

function window_(g: CanvasRenderingContext2D, P: Proj, quad: (a0: number, a1: number, z0: number, z1: number) => P3[], a0: number, a1: number, z0: number, z1: number, look: Look, r: number, lw: number) {
  const fr = 0.1;
  path(g, P, quad(a0 - fr, a1 + fr, z0 - fr, z1 + fr));
  g.fillStyle = css(FRAME);
  g.fill();
  g.strokeStyle = OUTLINE;
  g.lineWidth = lw;
  g.stroke();
  if (look.burnt || r < 0.04) {
    path(g, P, quad(a0, a1, z0, z1));
    g.fillStyle = css(look.burnt ? GLASS_BURNT : BOARD);
    g.fill();
    if (!look.burnt) {
      // boarded up
      g.strokeStyle = css(mul(BOARD, 0.7));
      g.beginPath();
      for (const t of [0.33, 0.66]) { const q = quad(a0, a1, z0 + (z1 - z0) * t, z0 + (z1 - z0) * t); const a = pt(P, q[0][0], q[0][1], q[0][2]), b = pt(P, q[1][0], q[1][1], q[1][2]); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
      g.stroke();
    }
    return;
  }
  path(g, P, quad(a0, a1, z0, z1));
  g.fillStyle = css(GLASS_DK);
  g.fill();
  // a reflection in the upper corner and a mullion on wide windows
  const k = 0.45;
  path(g, P, quad(a0, a0 + (a1 - a0) * k, z0 + (z1 - z0) * 0.55, z1));
  g.fillStyle = css(GLASS_HI);
  g.fill();
  if (a1 - a0 > 1.0) {
    path(g, P, quad((a0 + a1) / 2 - 0.05, (a0 + a1) / 2 + 0.05, z0, z1));
    g.fillStyle = css(FRAME);
    g.fill();
  }
  // sill
  path(g, P, quad(a0 - fr * 1.6, a1 + fr * 1.6, z0 - fr * 1.6, z0 - fr * 0.6));
  g.fillStyle = css(FRAME);
  g.fill();
}

// ------------------------------------------------------------------ ground: shadows and doormats

/** World polygons of the building's south-east drop shadow (one per wing), made once. */
function shadowPolys(rec: BuildingRec): number[][] {
  if (rec.shadow) return rec.shadow;
  const m = rec.m, k = m.tpm;
  const out: number[][] = [];
  for (const w of m.wings) {
    const hgt = w.wallH + (w.roof === 'flat' ? 0 : w.roofH * 0.5);
    const len = Math.min(6, 0.5 * hgt) * k * 0.7071;
    const b = w.box;
    const pts: [number, number][] = [];
    for (const [s, d] of [[b.s0, b.d0], [b.s1, b.d0], [b.s1, b.d1], [b.s0, b.d1]]) {
      const x = m.ox + (m.ux * s - m.uy * d) * k, y = m.oy + (m.uy * s + m.ux * d) * k;
      pts.push([x, y], [x + len, y + len]);
    }
    out.push(convexHull(pts).flat());
  }
  return (rec.shadow = out);
}

/** Add the building's south-east drop shadow to the current path (screen coordinates via `toScreen`). */
export function shadowPath(g: CanvasRenderingContext2D, rec: BuildingRec, toScreen: (x: number, y: number) => [number, number]) {
  for (const p of shadowPolys(rec)) addPoly(g, p, toScreen);
}

function addPoly(g: CanvasRenderingContext2D, p: number[], toScreen: (x: number, y: number) => [number, number]) {
  for (let i = 0; i < p.length; i += 2) {
    const [sx, sy] = toScreen(p[i], p[i + 1]);
    if (i) g.lineTo(sx, sy);
    else g.moveTo(sx, sy);
  }
  g.closePath();
}

function convexHull(p: [number, number][]): [number, number][] {
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], hi: [number, number][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  lo.pop(); hi.pop();
  return lo.concat(hi);
}

/** Doormats on the ground outside doors the camera cannot see (north, east and west walls), added to the current path. */
export function doormats(g: CanvasRenderingContext2D, rec: BuildingRec, toScreen: (x: number, y: number) => [number, number]) {
  if (!rec.mats) {
    const m = rec.m, k = m.tpm;
    rec.mats = [];
    for (const op of m.openings) {
      if (op.kind !== 'door' && op.kind !== 'garage') continue;
      const n = sideNormal(m, op.side);
      const w = m.wings[op.wing];
      if (n[1] > 0.12 || !w) continue;
      const at = sideLine(w.box, op.side).a0 + op.at;
      rec.mats.push([[at - 0.5, 0.05], [at + 0.5, 0.05], [at + 0.5, 0.75], [at - 0.5, 0.75]].flatMap(([a, off]) => {
        const [s, d] = onSide(w.box, op.side, a, off);
        return [m.ox + (m.ux * s - m.uy * d) * k, m.oy + (m.uy * s + m.ux * d) * k];
      }));
    }
  }
  for (const p of rec.mats) addPoly(g, p, toScreen);
}

/** Doormat colour */
export const DOORMAT = '#7a5434';

/** Shadow colour and alpha for the drop-shadow pass. */
export const SHADOW_STYLE = { color: PALETTE.shadow, alpha: SHADOW_ALPHA };

// ------------------------------------------------------------------ occlusion

/**
 * Does this building hide a point at height h (metres) standing on the ground
 * at world (x, y)? In this projection the screen ray through that point runs
 * south and up, so it is hidden when the ground just south of it, within the
 * building's height, lies inside a wing.
 */
export function hides(rec: BuildingRec, x: number, y: number, h: number): boolean {
  const m = rec.m, k = m.tpm;
  if (x < rec.x0 - 1 || x > rec.x1 + 1 || y > rec.y1 || y < rec.y0 - riseOf(rec)) return false;
  for (const w of m.wings) {
    const reach = w.wallH + w.roofH * 0.7 - h;
    if (reach <= 0) continue;
    // sample the segment from (x, y) to (x, y + reach * HEIGHT_K * k)
    const len = reach * rec.hk;
    for (let t = 0.2; t <= len; t += 0.5) {
      const wx = x, wy = y + t * k;
      const dx = (wx - m.ox) / k, dy = (wy - m.oy) / k;
      const s = dx * m.ux + dy * m.uy, d = -dx * m.uy + dy * m.ux;
      const b = w.box;
      if (s > b.s0 && s < b.s1 && d > b.d0 && d < b.d1) return true;
    }
  }
  return false;
}

/** The southern-most footprint y (world texels) on the vertical line through x, or -Infinity. */
export function southEdgeAt(rec: BuildingRec, x: number): number {
  const m = rec.m, k = m.tpm;
  let best = -Infinity;
  for (const w of m.wings) {
    const b = w.box;
    const c = [[b.s0, b.d0], [b.s1, b.d0], [b.s1, b.d1], [b.s0, b.d1]].map(([s, d]) => [m.ox + (m.ux * s - m.uy * d) * k, m.oy + (m.uy * s + m.ux * d) * k]);
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = c[i], [bx, by] = c[(i + 1) & 3];
      if ((x < ax && x < bx) || (x > ax && x > bx) || ax === bx) continue;
      const y = ay + ((x - ax) / (bx - ax)) * (by - ay);
      if (y > best) best = y;
    }
  }
  return best;
}

/**
 * Is something standing at (x, y), whose art is `half` texels wide each side,
 * behind this building? It is when, in any column it shares with the
 * building's footprint, it stands north of the footprint's front edge.
 */
export function isBehind(rec: BuildingRec, x: number, y: number, half: number): boolean {
  for (const f of [-0.8, -0.4, 0, 0.4, 0.8]) {
    const sx = x + half * f;
    if (sx < rec.x0 || sx > rec.x1) continue;
    const e = southEdgeAt(rec, sx);
    if (e > -Infinity && y < e) return true;
  }
  return false;
}

// ------------------------------------------------------------------ cache

interface Entry {
  canvas: HTMLCanvasElement | null;
  /** canvas pixels per world texel it was painted at */
  ppt: number;
  detail: boolean;
  /** world texel at canvas (0, 0) */
  ax: number;
  ay: number;
  w: number;
  h: number;
  dim: HTMLCanvasElement | null;
  used: number;
}

/** A soft see-through window: world texel centre and radius, and how far it is open (0..1). */
export interface Hole { x: number; y: number; r: number; cut: number }

/** Above this many pixels a building is painted straight to the screen every frame instead. */
const MAX_CACHED_PX = 3_000_000;
/** Total cached pixels kept (about 4 bytes each). */
const BUDGET_PX = 12_000_000;

/**
 * Paints buildings into per-building offscreen canvases at the current zoom
 * and draws them. Repaints after a zoom change are spread over frames (the old
 * image is scaled meanwhile), so flying in from space never stalls.
 */
export class BuildingPainter {
  private cache = new Map<string, Entry>();
  private px = 0;
  private frame = 0;
  /** ms spent painting this frame */
  paintMs = 0;
  painted = 0;
  private tolerance = 0.004;
  private moving = false;
  /** buildings too big to cache, painted straight to the screen this frame */
  direct = 0;
  /** see-through windows drawn this frame */
  holes = 0;

  private lastPpt = 0;
  private stableSince = 0;

  beginFrame(ppt: number) {
    const now = performance.now();
    if (Math.abs(ppt / (this.lastPpt || ppt) - 1) > 1e-4) this.stableSince = now;
    this.lastPpt = ppt;
    // while the zoom moves, cached images are scaled; once it settles they are repainted crisp
    this.moving = now - this.stableSince < 150;
    this.tolerance = this.moving ? 0.2 : 0.004;
    this.frame++;
    this.paintMs = 0;
    this.painted = 0;
    this.direct = 0;
    this.holes = 0;
  }

  /** Forget cached images of these buildings (a neighbour appeared, so party walls may change). */
  invalidate(id: string) {
    const e = this.cache.get(id);
    if (!e) return;
    this.px -= e.w * e.h;
    this.cache.delete(id);
  }

  clear() {
    this.cache.clear();
    this.px = 0;
  }

  private geometry(rec: BuildingRec, ppt: number, o: number) {
    const k = rec.m.tpm;
    const pad = (EAVES + 0.6) * k + (o * 2 + 2) / ppt;
    const ax = rec.x0 - pad, ay = rec.y0 - riseOf(rec) - pad;
    const w = Math.ceil((rec.x1 + pad - ax) * ppt), h = Math.ceil((rec.y1 + pad - ay) * ppt);
    return { ax, ay, w, h };
  }

  /**
   * Draw one building. (sx, sy) maps a world texel to the screen; ppt is screen
   * pixels per texel; o the outline width in pixels; alpha its opacity; dim how
   * far it is darkened (indoor view).
   */
  draw(ctx: CanvasRenderingContext2D, rec: BuildingRec, cam: { ppt: number; worldToScreen(x: number, y: number): { x: number; y: number } }, o: number, alpha: number, dim: number, opt: PaintOptions, budgetMs: number, hole: Hole | null = null) {
    const ppt = cam.ppt;
    const detail = opt.detail;
    const geo = this.geometry(rec, ppt, o);
    let e = this.cache.get(rec.m.id);
    const stale = !e || !e.canvas || Math.abs(e.ppt / ppt - 1) > this.tolerance || e.detail !== detail;
    const canPaint = this.paintMs < budgetMs;
    // out of painting time with nothing usable cached: a quick version straight to the screen
    const fast = stale && !canPaint && (!e || Math.abs(e.ppt / ppt - 1) > 0.5);
    // while zooming, a building with nothing to show yet simply appears a few frames later
    if (fast && this.moving && geo.w * geo.h <= MAX_CACHED_PX) return;
    if (fast || geo.w * geo.h > MAX_CACHED_PX) {
      // big: straight to the screen
      const t0 = performance.now();
      this.direct++;
      const a = cam.worldToScreen(geo.ax, geo.ay);
      ctx.save();
      ctx.globalAlpha = alpha * (hole ? 1 - 0.7 * hole.cut : 1);
      ctx.translate(Math.round(a.x), Math.round(a.y));
      paint(ctx, rec, { m: rec.m, ax: geo.ax, ay: geo.ay, ppt, o, hk: rec.hk }, fast ? { detail: false, fast: true } : opt);
      ctx.restore();
      this.paintMs += performance.now() - t0;
      return;
    }
    if (stale && canPaint) {
      const t0 = performance.now();
      if (e) this.px -= e.w * e.h;
      const canvas = e?.canvas && e.canvas.width >= geo.w && e.canvas.height >= geo.h && e.canvas.width < geo.w * 1.5 && e.canvas.height < geo.h * 1.5 ? e.canvas : document.createElement('canvas');
      if (canvas.width !== geo.w || canvas.height !== geo.h) { canvas.width = geo.w; canvas.height = geo.h; }
      const g = canvas.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      paint(g, rec, { m: rec.m, ax: geo.ax, ay: geo.ay, ppt, o, hk: rec.hk }, opt);
      e = { canvas, ppt, detail, ax: geo.ax, ay: geo.ay, w: geo.w, h: geo.h, dim: null, used: this.frame };
      this.cache.set(rec.m.id, e);
      this.px += geo.w * geo.h;
      this.paintMs += performance.now() - t0;
      this.painted++;
      if (this.px > BUDGET_PX) this.evict();
    }
    e = e!;
    e.used = this.frame;
    const a = cam.worldToScreen(e.ax, e.ay);
    const f = ppt / e.ppt;
    ctx.globalAlpha = alpha;
    const x = Math.round(a.x), y = Math.round(a.y);
    if (hole && hole.cut > 0.01) {
      // see-through window around the player standing behind
      this.holes++;
      const sc = (this.scratch ??= document.createElement('canvas'));
      if (sc.width < e.w || sc.height < e.h) { sc.width = Math.max(sc.width, e.w); sc.height = Math.max(sc.height, e.h); }
      const g = sc.getContext('2d')!;
      g.globalCompositeOperation = 'copy';
      g.drawImage(e.canvas!, 0, 0);
      g.globalCompositeOperation = 'source-over';
      if (dim > 0.01) { g.globalAlpha = dim; g.drawImage(this.dimOf(e), 0, 0); g.globalAlpha = 1; }
      g.globalCompositeOperation = 'destination-out';
      const hx = (hole.x - e.ax) * e.ppt, hy = (hole.y - e.ay) * e.ppt, hr = hole.r * e.ppt;
      const grad = g.createRadialGradient(hx, hy, hr * 0.45, hx, hy, hr);
      grad.addColorStop(0, `rgba(0,0,0,${0.75 * hole.cut})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
      g.globalCompositeOperation = 'source-over';
      ctx.drawImage(sc, 0, 0, e.w, e.h, x, y, e.w * f, e.h * f);
      ctx.globalAlpha = 1;
      return;
    }
    if (Math.abs(f - 1) < 0.004) ctx.drawImage(e.canvas!, x, y);
    else {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(e.canvas!, x, y, e.w * f, e.h * f);
      ctx.imageSmoothingEnabled = false;
    }
    if (dim > 0.01) {
      const d = this.dimOf(e);
      ctx.globalAlpha = alpha * dim;
      if (Math.abs(f - 1) < 0.004) ctx.drawImage(d, x, y);
      else ctx.drawImage(d, x, y, e.w * f, e.h * f);
    } else if (e.dim) e.dim = null;
    ctx.globalAlpha = 1;
  }

  private scratch: HTMLCanvasElement | null = null;

  /** The cached image darkened like the ground around the indoor view. */
  private dimOf(e: Entry): HTMLCanvasElement {
    if (e.dim) return e.dim;
    const c = document.createElement('canvas');
    c.width = e.w; c.height = e.h;
    const g = c.getContext('2d')!;
    g.drawImage(e.canvas!, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(6,8,10,0.45)';
    g.fillRect(0, 0, e.w, e.h);
    return (e.dim = c);
  }

  private evict() {
    const list = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [id, e] of list) {
      if (this.px <= BUDGET_PX * 0.75 || e.used >= this.frame - 1) break;
      this.px -= e.w * e.h;
      this.cache.delete(id);
    }
  }
}

/**
 * Far away (zoomed out past the play view, and on the way down from space)
 * there are hundreds of buildings in view. They are painted, quickly and a few
 * at a time, into one transparent layer per chunk at 1 or 2 pixels per texel,
 * and the layers are drawn scaled.
 */
export class FarLayers {
  private layers = new Map<string, { canvas: HTMLCanvasElement; scale: number; ax: number; ay: number; recs: BuildingRec[]; next: number; used: number }>();
  private frame = 0;
  paintMs = 0;

  beginFrame() {
    this.frame++;
    this.paintMs = 0;
  }

  /**
   * Draw the buildings owned by one chunk (`recs`, any order) whose ground is
   * the world box (x0, y0) .. (x0 + size, y0 + size).
   */
  draw(ctx: CanvasRenderingContext2D, key: string, recs: BuildingRec[], x0: number, y0: number, size: number,
    cam: { ppt: number; dpr: number; worldToScreen(x: number, y: number): { x: number; y: number } }, alpha: number, budgetMs: number) {
    if (!recs.length) return;
    const scale = 1;
    let L = this.layers.get(key);
    if (L && (L.scale !== scale || L.recs.length !== recs.length) && this.paintMs < budgetMs) L = undefined;
    if (!L) {
      if (this.paintMs >= budgetMs) return;
      let rise = 0;
      for (const r of recs) rise = Math.max(rise, riseOf(r) + (y0 - r.y0));
      const pad = 8;
      const ax = x0 - pad, ay = y0 - Math.max(pad, rise + pad);
      let maxX = x0 + size, maxY = y0 + size;
      for (const r of recs) { maxX = Math.max(maxX, r.x1 + pad); maxY = Math.max(maxY, r.y1 + 12); }
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil((maxX - ax) * scale);
      canvas.height = Math.ceil((maxY - ay) * scale);
      L = { canvas, scale, ax, ay, recs: [...recs].sort((a, b) => a.key - b.key), next: 0, used: this.frame };
      this.layers.set(key, L);
      if (this.layers.size > 6) this.evict();
    }
    L.used = this.frame;
    if (L.next < L.recs.length && this.paintMs < budgetMs) {
      const t0 = performance.now();
      const g = L.canvas.getContext('2d')!;
      const o = Math.max(1, Math.round(0.6 * scale));
      while (L.next < L.recs.length && performance.now() - t0 + this.paintMs < budgetMs) {
        const r = L.recs[L.next++];
        paint(g, r, { m: r.m, ax: L.ax, ay: L.ay, ppt: scale, o, hk: r.hk }, { detail: false, fast: true });
      }
      this.paintMs += performance.now() - t0;
    }
    const a = cam.worldToScreen(L.ax, L.ay);
    const k = cam.ppt / L.scale;
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(L.canvas, Math.round(a.x), Math.round(a.y), L.canvas.width * k, L.canvas.height * k);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
  }

  private evict() {
    const list = [...this.layers.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, l] of list) {
      if (this.layers.size <= 4 || l.used >= this.frame - 1) break;
      this.layers.delete(k);
    }
  }
}

export { OUT_RGB };
