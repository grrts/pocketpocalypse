// Building exteriors in the street-level texture, in the arcade style: strong
// roof colours with a clear ridge and two cel-shaded slopes, clean light flat
// roofs with chunky props (AC units, skylights, solar panels, roof gardens),
// corrugated halls, greenhouses, burnt shells with glowing holes, a dark
// outline around every building, and along each building's southern edge a
// strip of facade (the light 3/4 cheat) with bright windows, doors and shop
// awnings. Everything stays inside the true footprint, so collision and the
// street are untouched.
//
// Chunks near the player are rendered at 2 art pixels per texel; there the
// buildings are drawn on that finer grid straight into the refined image
// (see exteriorPass), so roofs are as crisp as the ground around them.

import { hash2, valueNoise } from '../core/rng';
import { IS_ROOF, M } from './materials';
import { PALETTE, SHADOW_ALPHA, rgbOf } from './palette';
import type { IdRaster, Transform } from './raster';

export interface ExteriorJob {
  rings: number[][];
  cls: string;
  roof: number;
  burnt: boolean;
  /** building height drawn in the shadow pass (texels) */
  height: number;
  seed: number;
  /** front door on the outline and its outward normal */
  door: { x: number; y: number; nx: number; ny: number };
  /** windows on the outer walls: x0, y0, x1, y1, nx, ny each (same coordinates as rings) */
  windows: number[];
  /** building axis (along the longest wall) */
  ux: number;
  uy: number;
}

export interface ExteriorContext {
  /** chunk raster (ids + aux heights) */
  R: IdRaster;
  /** footprint coords -> chunk pixels */
  t: Transform;
  /** world texel of chunk pixel (0,0) */
  wx0: number;
  wy0: number;
  tpm: number;
  damage: number;
  overgrowth: number;
}

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const hexes = (a: string[]) => a.map(hex);

const OUT = rgbOf(PALETTE.outline);
const SHK = 1 - SHADOW_ALPHA;
/** A family of three near tones around a palette base, so neighbouring blocks differ a little. */
const fam = (h: string): RGB[] => { const c = rgbOf(h); return [c, c.map((v) => Math.min(255, v * 1.07)) as RGB, c.map((v) => v * 0.93) as RGB]; };

// roofs
const R_RED = fam(PALETTE.roofRed);
const R_BROWN = fam(PALETTE.roofBrown);
const R_SLATE = fam(PALETTE.roofSlate);
const R_TEAL = fam(PALETTE.roofTeal);
const R_DARK = fam(PALETTE.roofDark);
const FLAT = hexes(['#cdd2d8', '#d8d4ca', '#c3cbd2', '#d2d6d0', '#d8ccb0', '#7a8090', '#cdd2d8']);
const RIM = hex('#f2f3f5');
const HALL = [rgbOf(PALETTE.roofTeal), hex('#4f78ac'), rgbOf(PALETTE.roofMetal), hex('#cbb685'), hex('#b0503a'), hex('#6f925a')];
const PANE = rgbOf(PALETTE.glass), PANE_HI = hex('#d8f4fa'), PANE_FRAME = hex('#eef6f6');
const SOLAR = hex('#2a4580'), SOLAR_LINE = hex('#8aa6dc');
const GRASS = hex('#6fb04a'), BUSH = hex('#3f8f3a'), BUSH_HI = hex('#62b04a'), PLANTER = hex('#a8763e');
const BURNT = rgbOf(PALETTE.roofBurnt), CHAR = hex('#1e1416'), RAFTER = hex('#4a3428'), EMBER = hex('#ff7a1c'), GLOW = hex('#ffc23a'), EMBER_DK = hex('#7a2a16');
const RUST = hex('#b8643a');
const CHIMNEY = hex('#b8543a');
const AC = hex('#e8eaec'), AC_FAN = hex('#4a4e5a'), VENT = hex('#9aa0a8'), VENT_DK = hex('#3a3e48'), HATCH = hex('#b4b8bc');

// facades
const BRICK = hexes(['#c8603f', '#b9553a', '#d0704a', '#ad4c38']);
const RENDER = hexes(['#f0e6cc', '#e8d8b0', '#f2f0ea', '#d8e6e0', '#f0d8c8']);
const CONCRETE = hexes(['#c8c8c0', '#bcc0c4']);
const TIMBER = hexes(['#8a4e2e', '#a83a2a', '#6f5a3a']);
const STONE = hex('#c4b89c');
const FRAME = hex('#f4f1e8'), SILL = hex('#e8e4da');
const WIN = hex('#2c4770'), WIN_HI = hex('#7fb6e6'), LIT = hex('#ffd65a'), LIT_HI = hex('#fff3b0');
const BOARD = hex('#b07a40'), BOARD_DK = hex('#7a5028');
const SHOPGLASS = hex('#5fb4d8'), SHOPGLASS_HI = hex('#c8ecf8'), SHOP_FRAME = hex('#2e3450');
const STEP = hex('#bdb8ae'), KNOB = hex('#ffd040');
const DOORS = hexes(['#2f8a4a', '#2b5aa8', '#c0342a', '#f0b830', '#3a3a50', '#f0ece2', '#1f7f86']);
const SIGNS = hexes(['#d83a32', '#2a8a4a', '#2b62b8', '#f0a020', '#8a3ab0', '#1f9a9a']);
const AWN_LIGHT = hex('#f6f2ea');
const IVY = hex('#4f9a3a'), IVY_DK = hex('#2f6a2a');
const FIRE = hex('#ff8a1a');

const SHOPS = new Set(['shop', 'retail', 'commercial', 'grocery', 'supermarket', 'pharmacy', 'hardware', 'outdoor', 'food_service', 'fuel']);
const HALLS = new Set(['industrial', 'warehouse', 'garage', 'mechanic', 'farm', 'shed', 'fire_station', 'military']);
const HOMES = new Set(['house', 'residential', 'other']);
const BIG_FLAT = new Set(['apartments', 'office', 'school', 'civic', 'hospital', 'commercial', 'retail', 'supermarket', 'grocery']);

type RoofStyle = 'pitched' | 'flat' | 'metal' | 'glass';
type PropKind = 'ac' | 'hvac' | 'housing' | 'sky' | 'vent' | 'hatch' | 'chimney';
type WallKind = 'brick' | 'render' | 'metal' | 'timber' | 'stone';

function wallColor(cls: string, seed: number, hall: RGB): { c: RGB; kind: WallKind } {
  const k = (seed >>> 5) % 97;
  if (cls === 'church') return { c: STONE, kind: 'stone' };
  if (cls === 'farm') return k % 3 ? { c: TIMBER[k % TIMBER.length], kind: 'timber' } : { c: hall, kind: 'metal' };
  if (HALLS.has(cls)) return k % 4 ? { c: hall, kind: 'metal' } : { c: BRICK[k % BRICK.length], kind: 'brick' };
  if (HOMES.has(cls)) return k % 6 ? { c: BRICK[k % BRICK.length], kind: 'brick' } : { c: RENDER[k % RENDER.length], kind: 'render' };
  if (cls === 'apartments') return k % 3 === 0 ? { c: RENDER[k % RENDER.length], kind: 'render' } : k % 3 === 1 ? { c: CONCRETE[k % CONCRETE.length], kind: 'render' } : { c: BRICK[k % BRICK.length], kind: 'brick' };
  return k % 2 ? { c: RENDER[k % RENDER.length], kind: 'render' } : k % 4 === 0 ? { c: BRICK[k % BRICK.length], kind: 'brick' } : { c: CONCRETE[k % CONCRETE.length], kind: 'render' };
}

/** The colour a building's outer walls are built in (the inside view draws the wall tops in it). */
export function facadeColor(cls: string, seed: number): [number, number, number] {
  return wallColor(cls, seed, HALL[(seed >>> 6) % HALL.length]).c;
}

function roofStyle(job: ExteriorJob, short: number, tpm: number): RoofStyle {
  switch (job.roof) {
    case M.GLASS: return 'glass';
    case M.ROOF_METAL: return 'metal';
    case M.ROOF_FLAT: return 'flat';
    case M.ROOF_GRAY: return HALLS.has(job.cls) ? 'metal' : 'flat';
    case M.ROOF_BURNT: return short <= 17 * tpm || job.cls === 'church' ? 'pitched' : 'flat';
    default: return short <= 17 * tpm || job.cls === 'church' ? 'pitched' : 'flat';
  }
}

/** Pitched roof colour; houses take a colour per neighbourhood block so terraced rows match. */
function pitchedColor(job: ExteriorJob, cxw: number, cyw: number, tpm: number): RGB {
  const s = job.seed >>> 4;
  if (job.cls === 'church') return s % 3 ? R_SLATE[s % 3] : R_TEAL[s % 3];
  let fam: RGB[];
  if (HOMES.has(job.cls) && s % 7 !== 0) {
    const cell = 34 * tpm;
    const h = hash2(Math.floor(cxw / cell), Math.floor(cyw / cell), 0x7e1) % 20;
    fam = h < 8 ? R_RED : h < 12 ? R_BROWN : h < 15 ? R_SLATE : h < 18 ? R_TEAL : R_DARK;
    return fam[(h >>> 2) % fam.length];
  }
  switch (job.roof) {
    case M.ROOF_RED: fam = R_RED; break;
    case M.ROOF_BROWN: fam = R_BROWN; break;
    case M.ROOF_SLATE: case M.ROOF_GRAY: fam = R_SLATE; break;
    default: fam = s & 1 ? R_TEAL : R_DARK;
  }
  return fam[s % fam.length];
}

// scratch buffers reused for every building
let S_CAP = 0;
let S_MASK = new Uint8Array(0), S_RUN = new Uint16Array(0), S_SEG = new Uint16Array(0), S_EDGE = new Uint8Array(0);
function grow(n: number) {
  if (n <= S_CAP) return;
  S_CAP = Math.max(n, S_CAP * 2, 16384);
  S_MASK = new Uint8Array(S_CAP); S_RUN = new Uint16Array(S_CAP); S_SEG = new Uint16Array(S_CAP); S_EDGE = new Uint8Array(S_CAP);
}
const XS: number[] = [];

/** Even-odd fill of rings (offset by ox, oy) into a w x h byte mask, pixel centres inside. */
export function fillRings(m: Uint8Array, w: number, h: number, rings: ArrayLike<number>[], ox: number, oy: number, scale = 1) {
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / scale + oy;
    XS.length = 0;
    for (const r of rings) {
      const n = r.length;
      for (let i = 0; i < n; i += 2) {
        const j = i + 2 < n ? i + 2 : 0;
        const ay = r[i + 1], by = r[j + 1];
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) XS.push(r[i] + ((sy - ay) / (by - ay)) * (r[j] - r[i]));
      }
    }
    if (XS.length < 2) continue;
    XS.sort((a, b) => a - b);
    const row = y * w;
    for (let k = 0; k + 1 < XS.length; k += 2) {
      const xa = Math.max(0, Math.ceil((XS[k] - ox) * scale - 0.5)), xb = Math.min(w - 1, Math.floor((XS[k + 1] - ox) * scale - 0.5));
      for (let x = xa; x <= xb; x++) m[row + x] = 1;
    }
  }
}

/** Where art pixels go: the chunk image at S art pixels per texel. */
interface Target {
  S: number;
  /** RGBA, (N*S)^2 */
  px: Uint8ClampedArray;
  /** for S > 1: pass-1 colours before trees and decals (snap) and after (base), per texel */
  snap?: Uint32Array;
  base?: Uint32Array;
}

/**
 * Paint all buildings. At scale 1 this paints straight into the chunk RGBA.
 * At scale 2 it returns a finisher to call after refineRaster with the pass-1
 * image (base) and the refined image (out): buildings are then drawn at 2 art
 * pixels per texel on top, keeping whatever trees and decals covered the roofs.
 */
export function exteriorPass(jobs: ExteriorJob[], ctx: ExteriorContext, rgba: Uint8ClampedArray, scale: number): ((base: Uint8ClampedArray, out: Uint8ClampedArray) => void) | null {
  for (const j of jobs) doormat(j, ctx, rgba);
  if (scale <= 1) {
    const tg: Target = { S: 1, px: rgba };
    prefill(ctx.R, tg);
    for (const j of jobs) paintExterior(j, ctx, tg);
    return null;
  }
  const snap = new Uint32Array(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength));
  return (base, out) => {
    const tg: Target = { S: scale, px: out, snap, base: new Uint32Array(base.buffer, base.byteOffset, base.byteLength >> 2) };
    prefill(ctx.R, tg);
    for (const j of jobs) paintExterior(j, ctx, tg);
  };
}

/**
 * How a texel's pass-1 colour changed after trees and decals: 1 = untouched,
 * 0..1 = darkened evenly (a tree shadow), -1 = painted over (keep it).
 */
function texelShade(tg: Target, ti: number): number {
  const s = tg.snap![ti], b = tg.base![ti];
  if (((s ^ b) & 0xffffff) === 0) return 1;
  const sr = (s & 255) + 1, sg = ((s >>> 8) & 255) + 1, sb = ((s >>> 16) & 255) + 1;
  const kr = ((b & 255) + 1) / sr, kg = (((b >>> 8) & 255) + 1) / sg, kb = (((b >>> 16) & 255) + 1) / sb;
  const lo = Math.min(kr, kg, kb), hi = Math.max(kr, kg, kb);
  if (hi > 1.04 || hi - lo > 0.12) return -1;
  return (kr + kg + kb) / 3;
}

/** Roof texels start as outline: whatever no footprint claims reads as the building's edge. */
function prefill(R: IdRaster, tg: Target) {
  const N = R.w, S = tg.S, W = N * S, px = tg.px, ids = R.ids;
  for (let ty = 0; ty < N; ty++) {
    for (let tx = 0; tx < N; tx++) {
      const ti = ty * N + tx;
      if (!IS_ROOF[ids[ti]]) continue;
      if (S > 1 && texelShade(tg, ti) < 0) continue;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const o = ((ty * S + sy) * W + tx * S + sx) * 4;
          px[o] = OUT[0]; px[o + 1] = OUT[1]; px[o + 2] = OUT[2];
        }
      }
    }
  }
}

/** A door that does not face the camera: a doormat on the ground outside it (pass-1 image). */
function doormat(job: ExteriorJob, ctx: ExteriorContext, rgba: Uint8ClampedArray) {
  if (job.door.ny > 0.35) return;
  const { R, t, tpm } = ctx;
  const N = R.w, ids = R.ids;
  const dsx = job.door.x - t.ox, dsy = job.door.y - t.oy;
  const mx = Math.round(dsx + job.door.nx * 0.9 * tpm - 0.5), my = Math.round(dsy + job.door.ny * 0.9 * tpm - 0.5);
  const tx = Math.round(-job.door.ny), ty = Math.round(job.door.nx);
  for (let k = -1; k <= 1; k++) {
    const x = mx + tx * k, y = my + ty * k;
    if (x < 0 || y < 0 || x >= N || y >= N || IS_ROOF[ids[y * N + x]]) continue;
    const o = (y * N + x) * 4;
    rgba[o] = 120; rgba[o + 1] = 84; rgba[o + 2] = 52;
  }
}

/** Paint one building's roof and south facade. */
function paintExterior(job: ExteriorJob, ctx: ExteriorContext, tg: Target): void {
  const { R, t, tpm } = ctx;
  const S = tg.S, N = R.w, W = N * S, px = tg.px, ids = R.ids;
  const am = tpm * S; // art pixels per metre
  const outer = job.rings[0];
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    const x = outer[i] - t.ox, y = outer[i + 1] - t.oy;
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  if (bx1 < 0 || by1 < 0 || bx0 > N || by0 > N) return;
  // local mask over the whole footprint (not clipped to the chunk, so facades
  // and roof props come out the same in every chunk the building touches)
  let mx0 = Math.floor(bx0 * S) - 1, mx1 = Math.ceil(bx1 * S) + 1;
  let my0 = Math.floor(by0 * S) - 1, my1 = Math.ceil(by1 * S) + 1;
  if ((mx1 - mx0) * (my1 - my0) > 6e6) {
    mx0 = Math.max(mx0, -S * 64); mx1 = Math.min(mx1, W + S * 64);
    my0 = Math.max(my0, -S * 64); my1 = Math.min(my1, W + S * 64);
  }
  const mw = mx1 - mx0 + 1, mh = my1 - my0 + 1;
  grow(mw * mh);
  const m = S_MASK, run = S_RUN, seg = S_SEG, edge = S_EDGE;
  m.fill(0, 0, mw * mh);
  fillRings(m, mw, mh, job.rings, t.ox + mx0 / S, t.oy + my0 / S, S);
  // outline pixels: footprint pixels next to the outside
  for (let ly = 0; ly < mh; ly++) {
    for (let lx = 0; lx < mw; lx++) {
      const i = ly * mw + lx;
      if (!m[i]) { edge[i] = 0; continue; }
      edge[i] = lx === 0 || lx === mw - 1 || ly === 0 || ly === mh - 1 || !m[i - 1] || !m[i + 1] || !m[i - mw] || !m[i + mw] ? 1 : 0;
    }
  }

  const style = roofStyle(job, shortSide(job, outer), tpm);
  const glassRoof = style === 'glass';
  // facade strip height per column run, in art pixels
  const FH = Math.max(2, Math.round(2.4 * am));
  for (let lx = 0; lx < mw; lx++) {
    let r = -1;
    for (let ly = mh - 1; ly >= 0; ly--) {
      const i = ly * mw + lx;
      if (!m[i]) { r = -1; continue; }
      r = r < 0 ? 0 : Math.min(65535, r + 1);
      run[i] = r;
    }
  }
  // how far the run bottom of the next column sits from yb (a steep wall is not a front)
  const step = (lx: number, yb: number): number => {
    if (lx < 0 || lx >= mw) return 0;
    if (m[yb * mw + lx]) return run[yb * mw + lx];
    for (let k = 1; k <= 6 && yb - k >= 0; k++) if (m[(yb - k) * mw + lx]) return k;
    return 0;
  };
  for (let lx = 0; lx < mw; lx++) {
    let ly = 0;
    while (ly < mh) {
      if (!m[ly * mw + lx]) { ly++; continue; }
      const top = ly;
      while (ly < mh && m[ly * mw + lx]) ly++;
      let fh = glassRoof ? 0 : Math.min(FH, Math.floor((ly - top) * 0.4));
      if (fh > 0 && Math.min(step(lx - 1, ly - 1), step(lx + 1, ly - 1)) >= 2) fh = 0;
      // none where a building at least as tall abuts to the south
      const tx = Math.floor((lx + mx0) / S), ty = Math.floor((ly + my0) / S + 0.8 * tpm);
      if (fh > 0 && tx >= 0 && tx < N && ty >= 0 && ty < N) {
        const bi = ty * N + tx;
        if (IS_ROOF[ids[bi]] && R.aux[bi] >= job.height) fh = 0;
      }
      if (fh < 3) fh = 0;
      for (let k = top; k < ly; k++) seg[k * mw + lx] = fh;
    }
  }

  // roof frame (footprint coordinates)
  const ux = job.ux, uy = job.uy;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    const u = outer[i] * ux + outer[i + 1] * uy, v = -outer[i] * uy + outer[i + 1] * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2, hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
  const longU = hu >= hv;
  // Dutch rows: the ridge runs parallel to the street, i.e. along the front wall
  const dn = Math.abs(job.door.nx * ux + job.door.ny * uy) > 0.7071;
  const aspect = Math.max(hu, hv) / Math.max(1e-3, Math.min(hu, hv));
  const ridgeAlongU = aspect < 2 && (HOMES.has(job.cls) || job.cls === 'apartments') ? !dn : longU;
  const ha = ridgeAlongU ? hu : hv, hb = ridgeAlongU ? hv : hu;
  const hip = style === 'pitched' && !job.burnt && ha >= hb && ((job.seed >>> 11) & 3) === 0 && aspect < 2.2;
  const og = { x: ctx.wx0 - t.ox, y: ctx.wy0 - t.oy }; // footprint -> world
  const cxw = (bx0 + bx1) / 2 + ctx.wx0, cyw = (by0 + by1) / 2 + ctx.wy0;

  const shop = SHOPS.has(job.cls), hall = HALLS.has(job.cls), home = HOMES.has(job.cls);
  const s = job.seed;
  const hallCol = HALL[(s >>> 6) % HALL.length];
  const roofCol: RGB = style === 'pitched' ? pitchedColor(job, cxw, cyw, tpm) : style === 'metal' ? hallCol : style === 'glass' ? PANE
    : FLAT[(s >>> 9) % FLAT.length];
  const wall = wallColor(job.cls, s, hallCol);
  const sign = SIGNS[(s >>> 7) % SIGNS.length];
  const doorCol = DOORS[(s >>> 9) % DOORS.length];
  const damage = ctx.damage, burnt = job.burnt;

  // flat-roof features in the roof frame: a solar array or a roof garden
  const big = Math.min(hu, hv) > 7 * tpm;
  const solarFlat = style === 'flat' && !burnt && big && ((s >>> 17) % 10) < (BIG_FLAT.has(job.cls) || hall ? 4 : 2);
  const garden = style === 'flat' && !burnt && !solarFlat && big && (job.cls === 'apartments' || job.cls === 'office' || job.cls === 'school') && ((s >>> 19) % 10) < 3;
  const inset = 2.2 * tpm;
  const featU0 = u0 + inset + hu * 0.15, featU1 = u1 - inset - hu * 0.15, featV0 = v0 + inset + hv * 0.12, featV1 = v1 - inset - hv * 0.3;
  // solar panels on one slope of a pitched roof (the one facing south-ish)
  const panelSide = (ridgeAlongU ? ux : uy) >= 0 ? 1 : -1; // sign of b whose normal points to +y
  const solarPitched = style === 'pitched' && !burnt && home && ((s >>> 15) % 10) < 3 && hb > 2.5 * tpm;

  // south-facing windows and the door, as column ranges in art pixels
  const wins: number[] = [];
  for (let i = 0; i < job.windows.length; i += 6) {
    if (Math.abs(job.windows[i + 5]) < 0.35) continue;
    // south-facing: outside just below the window, inside just above it
    const mxw = Math.round(((job.windows[i] + job.windows[i + 2]) / 2 - t.ox) * S) - mx0;
    const myw = Math.round(((job.windows[i + 1] + job.windows[i + 3]) / 2 - t.oy) * S) - my0;
    const below = myw + Math.round(1.2 * S), above = myw - Math.round(1.5 * S);
    if (mxw < 0 || mxw >= mw || above < 0 || below >= mh || m[below * mw + mxw] || !m[above * mw + mxw]) continue;
    const a = (job.windows[i] - t.ox) * S, b = (job.windows[i + 2] - t.ox) * S;
    wins.push(Math.round(Math.min(a, b)), Math.round(Math.max(a, b)) - 1, i / 6);
  }
  const dsx = (job.door.x - t.ox) * S, dsy = (job.door.y - t.oy) * S;
  const doorSouth = job.door.ny > 0.35;
  const dHalf = (hall ? 1.6 : shop ? 1.0 : 0.6) * am;
  const dA = Math.round(dsx - dHalf), dB = Math.round(dsx + dHalf) - 1;
  const rowLen = S === 1 ? 2 : 3;
  const seam = Math.max(4, Math.round(1.6 * am));
  const winP = Math.max(4, Math.round(2.7 * am)), winW = Math.max(2, Math.round(1.2 * am));

  const put = (ax: number, ay: number, c: RGB, f: number) => {
    const ti = Math.floor(ay / S) * N + Math.floor(ax / S);
    if (!IS_ROOF[ids[ti]]) return;
    let k = f;
    if (S > 1) { const sh = texelShade(tg, ti); if (sh < 0) return; k *= sh; }
    const o = (ay * W + ax) * 4;
    px[o] = c[0] * k; px[o + 1] = c[1] * k; px[o + 2] = c[2] * k;
  };

  const ax0 = Math.max(0, mx0), ax1 = Math.min(W - 1, mx1), ay0 = Math.max(0, my0), ay1 = Math.min(W - 1, my1);
  for (let ay = ay0; ay <= ay1; ay++) {
    const ly = ay - my0;
    const way = Math.floor(ctx.wy0 * S) + ay;
    for (let ax = ax0; ax <= ax1; ax++) {
      const lx = ax - mx0;
      const li = ly * mw + lx;
      if (!m[li]) continue;
      if (edge[li]) { put(ax, ay, OUT, 1); continue; }
      const wax = Math.floor(ctx.wx0 * S) + ax;
      let c: RGB = roofCol, f = 1;
      const fh = seg[li], r = run[li];
      if (r < fh) {
        // ---------------- facade
        const fr = fh - 1 - r; // 0 = under the eaves, fh-1 = ground (outline)
        c = wall.c;
        const plinth = fr >= fh - 2;
        const awn = shop ? Math.max(1, Math.round(fh * 0.34)) : 0;
        const wA = Math.max(2, Math.round(fh * 0.26)), wB = fh - Math.max(3, Math.round(fh * 0.3));
        let win = -1, wpos = 0, wlen = 0;
        for (let k = 0; k < wins.length; k += 3) {
          if (ax >= wins[k] && ax <= wins[k + 1]) { win = wins[k + 2]; wpos = ax - wins[k]; wlen = wins[k + 1] - wins[k] + 1; break; }
        }
        if (!wins.length && !hall) {
          // no plan windows on this side: a row of them either side of the door
          let q = -1, id = 0;
          if (doorSouth) {
            const right = ax > dB, d = right ? ax - dB - 1 : dA - 1 - ax;
            const g0 = Math.round(0.5 * am), P2 = winW + Math.round(0.9 * am);
            if (d >= g0) {
              const k = (d - g0) % P2;
              if (k < winW) { q = right ? k : winW - 1 - k; id = (right ? 1100 : 1000) + Math.floor((d - g0) / P2); }
            }
          } else {
            const p = wax - Math.floor(winP * 0.3);
            const k = ((p % winP) + winP) % winP;
            if (k < winW) { q = k; id = 1200 + Math.floor(p / winP); }
          }
          if (q >= 0 && m[li - q] && m[li + winW - 1 - q] && seg[li - q] && seg[li + winW - 1 - q]) { win = id; wpos = q; wlen = winW; }
        }
        const inDoor = doorSouth && ax >= dA && ax <= dB && Math.abs(ay + r - dsy) < FH + 2 * S;
        const dTop = shop ? awn + 1 : Math.max(1, Math.round(fh * 0.2));
        // plain wall texture
        if (wall.kind === 'brick' && S > 1) {
          const row = Math.floor(way / 3);
          if (way % 3 === 2 || (wax + (row & 1) * 3) % 6 === 0) f = 0.9;
        } else if (wall.kind === 'metal') f = (wax % 3 === 0) ? 0.82 : (wax % 3 === 1 ? 1.08 : 1);
        else if (wall.kind === 'timber') f = (wax % 4 === 0) ? 0.78 : 1;
        if (fr === 0) { c = OUT; f = 1; }
        else if (shop && fr <= awn) {
          // striped awning with a scalloped edge
          const stripe = Math.floor(wax / Math.max(2, Math.round(0.45 * am))) & 1;
          c = stripe ? sign : AWN_LIGHT; f = fr === 1 ? 1.08 : 1;
          if (fr === awn) { c = ((wax >> (S > 1 ? 1 : 0)) & 1) ? OUT : sign; f = (c === sign) ? 0.75 : 1; }
          if (burnt) { c = BURNT; f = 1 + (fr & 1) * 0.15; }
        } else if (inDoor && fr >= dTop && fr < fh - 1) {
          if (fr === fh - 2) { c = STEP; f = 1; }
          else if (ax === dA || ax === dB || fr === dTop) { c = OUT; f = 1; }
          else if (hall) { c = hallCol; f = (fr & 1) ? 0.78 : 1.05; }
          else if (shop) { c = SHOPGLASS; f = ((ax + fr) % 5 === 0) ? 1.35 : 0.9; }
          else {
            c = doorCol; f = 1;
            const mid = Math.round((dTop + fh - 2) / 2);
            if (ax === dB - 1 - (S > 1 ? 1 : 0) && fr === mid && dB - dA >= 3) { c = KNOB; }
            else if (S > 1 && dB - dA >= 5 && (ax === dA + 2 || ax === dB - 2) && fr > dTop + 1 && fr < fh - 3) f = 0.82;
          }
          if (burnt) { c = fr > dTop + 1 && (hash2(job.seed, 7) & 1) ? FIRE : CHAR; f = 1; }
        } else if (plinth) {
          c = wall.c; f = 0.68;
          if (inDoor) { c = STEP; f = 1; }
        } else if (shop) {
          // shop window over the whole front, mullions every 1.5 m, glints
          const mul = Math.max(4, Math.round(1.5 * am));
          if (wax % mul === 0) { c = SHOP_FRAME; f = 1; }
          else if (fr === awn + 1) { c = SHOPGLASS; f = 0.7; }
          else {
            c = SHOPGLASS; f = 1;
            if ((wax + fr) % 9 === 0 || (wax + fr) % 9 === 1 && S > 1) c = SHOPGLASS_HI;
          }
          const hp = hash2(Math.floor(wax / mul), job.seed, 3) / 4294967296;
          if (hp < damage * 0.15) { c = (wax + fr) % 3 ? BOARD : BOARD_DK; f = 1; }
          else if (hp < damage * 0.35 && c !== SHOP_FRAME) { c = OUT; f = (wax * 7 + fr * 3) % 11 === 0 ? 4 : 1; }
        } else if (fr === 1) { f *= 0.72; }
        else if (win >= 0 && fr >= wA && fr <= wB + 1) {
          const hw = hash2(win, job.seed, 5) / 4294967296;
          const framed = wlen >= 4 && fr <= wB;
          if (fr === wB + 1) { c = SILL; f = wpos === 0 || wpos === wlen - 1 ? 0.85 : 1; }
          else if (hall) { c = WIN; f = 1; if (fr !== wA) { c = wall.c; f *= 1; } }
          else if (framed && (wpos === 0 || wpos === wlen - 1 || fr === wA || fr === wB)) { c = hw < damage * 0.2 ? BOARD_DK : FRAME; f = 1; }
          else {
            const gx = wpos - (framed ? 1 : 0), gy = fr - wA - (framed ? 1 : 0);
            if (hw < damage * 0.2) { c = (gy & 1) ? BOARD_DK : BOARD; f = 1; if (S > 1 && gx === gy) c = BOARD_DK; }
            else if (hw < damage * 0.45) { c = OUT; f = 1; if ((gx + gy * 2) % 5 === 0) c = WIN_HI; }
            else {
              const lit = hash2(win, job.seed, 11) % 7 === 0;
              const glint = S > 1 ? (gx + gy === 1 || gx + gy === 2) : (gx === 0 && gy === 0);
              c = lit ? (glint ? LIT_HI : LIT) : (glint ? WIN_HI : WIN); f = 1;
            }
            if (burnt) { c = (hw < 0.4) ? (gy > 0 ? FIRE : GLOW) : OUT; f = 1; }
          }
        }
        // ivy creeping up the walls
        if (!burnt && ctx.overgrowth > 0.2 && fr > fh * 0.4 && c !== OUT) {
          const n = valueNoise(wax / (1.6 * am), way / (1.2 * am), job.seed & 1023);
          if (n > 1.02 - ctx.overgrowth * 0.35) { c = n > 1.06 - ctx.overgrowth * 0.35 ? IVY : IVY_DK; f = 1; }
        }
        if (burnt && c !== OUT && c !== FIRE && c !== GLOW) { f *= 0.32; }
        put(ax, ay, c, f);
        continue;
      }
      // ---------------- roof
      const fx = t.ox + (ax + 0.5) / S, fy = t.oy + (ay + 0.5) / S;
      const u = fx * ux + fy * uy, v = -fx * uy + fy * ux;
      const du = u - uc, dv = v - vc;
      const a = ridgeAlongU ? du : dv, b = ridgeAlongU ? dv : du;
      if (style === 'pitched' || style === 'metal') {
        // which slope: the two long sides, or hipped ends
        const e = hip ? Math.abs(a) - (ha - hb) : -1e9;
        let nx: number, ny: number, dist: number, along: number, side: number;
        if (e > Math.abs(b)) {
          side = a > 0 ? 2 : -2;
          const sg = a > 0 ? 1 : -1;
          nx = (ridgeAlongU ? ux : -uy) * sg; ny = (ridgeAlongU ? uy : ux) * sg;
          dist = e; along = b;
        } else {
          side = b > 0 ? 1 : -1;
          nx = (ridgeAlongU ? -uy : ux) * side; ny = (ridgeAlongU ? ux : uy) * side;
          dist = Math.abs(b); along = a;
        }
        // cel shading: lit from the north-west
        const d = (-nx - ny) * 0.7071;
        const tone = d > 0.3 ? 1.1 : d < -0.3 ? 0.72 : 0.9;
        const dpx = dist * S, apx = along * S;
        f = tone;
        if (style === 'pitched') {
          const row = Math.floor(dpx / rowLen);
          if (Math.floor(dpx) % rowLen === rowLen - 1) f *= 0.86;
          else if (S > 1 && (Math.floor(apx) + (row & 1) * 2) % 4 === 0) f *= 0.95;
          if (dpx < 1 || (hip && Math.abs(e - Math.abs(b)) * S < 0.8)) f = 1.3; // ridge cap
          if (solarPitched && side === panelSide && dist > hb * 0.22 && dist < hb * 0.78 && Math.abs(along) < ha * 0.62) {
            const pd = Math.floor((dist - hb * 0.22) * S), pa = Math.floor((along + ha * 0.62) * S);
            const pdl = Math.floor((hb * 0.56) * S), pal = Math.floor(ha * 1.24 * S);
            if (pd === 0 || pa === 0 || pd >= pdl - 1 || pa >= pal - 1) { c = OUT; f = 1; }
            else if (S > 1 && (pa % Math.max(3, Math.round(1.0 * am)) === 0 || pd % Math.max(3, Math.round(1.6 * am)) === 0)) { c = SOLAR_LINE; f = 1; }
            else { c = SOLAR; f = pd === 1 ? 1.25 : 1; }
          }
        } else {
          // corrugated metal with ribs running down the slope and skylight strips
          const rib = Math.floor(apx) % 3;
          f *= rib === 0 ? 0.8 : rib === 1 ? 1.08 : 1;
          if (dpx < 1) f = 1.25;
          const strip = Math.floor(along / (7 * tpm));
          if (dist > hb * 0.35 && dist < hb * 0.55 && (strip & 1) === 0 && hb > 4 * tpm) { c = PANE; f = tone; if (Math.floor(apx) % 6 === 0) { c = PANE_FRAME; } }
          if (!burnt && damage > 0.2) {
            const n = valueNoise((fx + og.x) / (2.5 * tpm), (fy + og.y) / (2.5 * tpm), job.seed & 1023);
            if (n > 0.86 - damage * 0.12) { c = RUST; f = tone; }
          }
        }
      } else if (style === 'flat') {
        f = 1;
        // parapet rim with a shadow on the inside of the north and west walls
        const rim = S;
        let nearEdge = false, shade = false;
        for (let k = 1; k <= rim && !nearEdge; k++) {
          if (!m[li - k] || !m[li + k] || !m[li - k * mw] || !m[li + k * mw]) nearEdge = true;
        }
        if (nearEdge) { c = RIM; }
        else {
          for (let k = rim + 1; k <= rim + S && !shade; k++) if (!m[li - k] || !m[li - k * mw]) shade = true;
          if (shade) f = 0.8;
          else if (S > 1 && ((Math.floor(u * S) % seam) + seam) % seam === 0) f = 0.95; // membrane seams
          if (solarFlat && u > featU0 && u < featU1 && v > featV0 && v < featV1) {
            const rowM = 1.9 * tpm, vv = v - featV0;
            const inRow = vv % rowM;
            if (inRow < 1.1 * tpm) {
              const rp = Math.floor(inRow * S), last = Math.floor(1.1 * tpm * S) - 1;
              c = SOLAR; f = rp === 0 ? 1.3 : 1;
              if (rp >= last) { c = OUT; f = 1; }
              else if (S > 1 && Math.floor((u - featU0) * S) % Math.max(3, Math.round(1.0 * am)) === 0) { c = SOLAR_LINE; f = 1; }
            }
          } else if (garden && u > featU0 && u < featU1 && v > featV0 && v < featV1) {
            const ed = Math.min(u - featU0, featU1 - u, v - featV0, featV1 - v) * S;
            if (ed < 1) { c = OUT; f = 1; }
            else if (ed < 1 + 0.4 * am) { c = PLANTER; f = 1; }
            else {
              const n = valueNoise((fx + og.x) / (1.5 * tpm), (fy + og.y) / (1.5 * tpm), job.seed & 1023);
              c = n > 0.66 ? BUSH_HI : n > 0.55 ? BUSH : n > 0.52 ? OUT : GRASS; f = 1;
            }
          }
        }
      } else {
        // greenhouse glass
        const g = Math.max(3, Math.round(1.3 * am));
        const pu = Math.floor(u * S), pv = Math.floor(v * S);
        if (((pu % g) + g) % g === 0 || ((pv % g) + g) % g === 0) { c = PANE_FRAME; f = 1; }
        else {
          c = PANE; f = 1;
          if ((((wax + way) % 13) + 13) % 13 < (S > 1 ? 2 : 1)) c = PANE_HI;
          if (hash2(Math.floor(pu / g), Math.floor(pv / g), job.seed) / 4294967296 < damage * 0.2) c = OUT;
        }
      }
      if (burnt) {
        // blackened roof with fallen-in holes glowing orange
        const n = valueNoise((fx + og.x) / (2.6 * tpm), (fy + og.y) / (2.6 * tpm), job.seed & 1023);
        if (n > 0.6) {
          c = CHAR; f = 1;
          if (Math.floor(Math.abs(ridgeAlongU ? du : dv) * S) % Math.max(3, Math.round(0.9 * am)) === 0) c = RAFTER;
          if ((hash2(wax, way, job.seed) & 63) === 0) c = EMBER;
        } else if (n > 0.57) { c = S > 1 && n > 0.585 ? GLOW : EMBER; f = 1; }
        else if (n > 0.535) { c = EMBER_DK; f = 1; }
        else { c = BURNT; f = f > 1.05 ? 1.25 : f < 0.8 ? 0.85 : 1; }
      }
      put(ax, ay, c, f);
    }
  }

  // ---- props
  const inMaskRoof = (x: number, y: number) => {
    const lx = x - mx0, ly = y - my0;
    if (lx < 0 || ly < 0 || lx >= mw || ly >= mh) return false;
    const i = ly * mw + lx;
    return m[i] === 1 && !edge[i] && run[i] >= seg[i] + S;
  };
  const prop = (x: number, y: number, w: number, h: number, kind: PropKind) => {
    for (let yy = y - S; yy <= y + h + S; yy++) for (let xx = x - S; xx <= x + w + S; xx++) if (!inMaskRoof(xx, yy)) return;
    if (style === 'flat') {
      // keep clear of the parapet, the solar array and the garden
      for (const [cx, cy] of [[x - S, y - S], [x + w + S, y - S], [x - S, y + h + S], [x + w + S, y + h + S]]) {
        const fx = t.ox + (cx + 0.5) / S, fy = t.oy + (cy + 0.5) / S;
        const u = fx * ux + fy * uy, v = -fx * uy + fy * ux;
        if ((solarFlat || garden) && u > featU0 - 0.5 * tpm && u < featU1 + 0.5 * tpm && v > featV0 - 0.5 * tpm && v < featV1 + 0.5 * tpm) return;
        const lx = cx - mx0, ly = cy - my0;
        for (let k = 1; k <= 2 * S; k++) if (!m[ly * mw + lx - k] || !m[(ly - k) * mw + lx] || !m[ly * mw + lx + k] || !m[(ly + k) * mw + lx]) return;
      }
    }
    const outline = w >= 4 && h >= 4;
    // drop shadow to the south-east
    const sd = Math.max(1, Math.round(S * (kind === 'chimney' || kind === 'housing' ? 1.6 : kind === 'hvac' ? 1.2 : 1)));
    for (let k = 1; k <= sd; k++) {
      for (let xx = x + k; xx < x + w + k; xx++) darken(xx, y + h - 1 + k);
      for (let yy = y + k; yy < y + h - 1 + k; yy++) darken(x + w - 1 + k, yy);
    }
    const cxm = x + (w - 1) / 2, cym = y + (h - 1) / 2;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= W) continue;
        const bd = xx === x || yy === y || xx === x + w - 1 || yy === y + h - 1;
        if (outline && bd) { put(xx, yy, OUT, 1); continue; }
        const top = yy === y + (outline ? 1 : 0);
        let c: RGB, f = 1;
        const dx = xx - cxm, dy = yy - cym;
        switch (kind) {
          case 'ac': {
            const rr = Math.min(w, h) / 2 - (outline ? 1.6 : 1);
            c = AC; f = top ? 1.05 : 0.95;
            if (rr > 0.6 && dx * dx + dy * dy <= rr * rr) { c = AC_FAN; f = dx * dx + dy * dy < 0.6 ? 1.8 : 1; }
            break;
          }
          case 'hvac': {
            // a big unit with two fans side by side
            const half = w / 2, lxp = xx - x < half ? x + (half - 1) / 2 : x + half + (half - 1) / 2;
            const ex = xx - lxp, rr = Math.min(half, h) / 2 - 1.4;
            c = AC; f = top ? 1.06 : 0.94;
            if (rr > 0.6 && ex * ex + dy * dy <= rr * rr) { c = AC_FAN; f = ex * ex + dy * dy < 0.8 ? 1.8 : 1; }
            else if (Math.abs(xx - (x + half - 0.5)) < 0.6) f = 0.8;
            break;
          }
          case 'housing': {
            // stair or lift housing: a raised box with a door on its south side
            c = RIM; f = top ? 1 : (yy - y) / h > 0.62 ? 0.78 : 0.94;
            if ((yy - y) / h > 0.62 && Math.abs(dx) < Math.max(1, w * 0.14)) { c = DOORS[(job.seed >>> 3) % DOORS.length]; f = 1; }
            break;
          }
          case 'sky': c = (xx - x) + (yy - y) === (outline ? 3 : 1) || (xx - x) + (yy - y) === (outline ? 4 : 2) ? PANE_HI : SHOPGLASS; break;
          case 'vent': c = dx * dx + dy * dy < Math.max(0.6, (Math.min(w, h) / 2 - 1.4) ** 2) ? VENT_DK : VENT; break;
          case 'hatch': c = HATCH; f = (yy - y) === Math.floor(h / 2) ? 0.7 : top ? 1.08 : 1; break;
          default: { const inner = Math.abs(dx) < w / 2 - 1.5 && Math.abs(dy) < h / 2 - 1.5; c = inner ? OUT : CHIMNEY; f = top ? 1.15 : 1; if (burnt) { c = inner ? EMBER : BURNT; } }
        }
        put(xx, yy, c, f);
      }
    }
  };
  function darken(xx: number, yy: number) {
    if (xx < 0 || yy < 0 || xx >= W || yy >= W) return;
    const lx = xx - mx0, ly = yy - my0;
    if (lx < 0 || ly < 0 || lx >= mw || ly >= mh || !m[ly * mw + lx] || edge[ly * mw + lx]) return;
    const ti = Math.floor(yy / S) * N + Math.floor(xx / S);
    if (!IS_ROOF[ids[ti]]) return;
    if (S > 1 && texelShade(tg, ti) < 0) return;
    const o = (yy * W + xx) * 4;
    px[o] = px[o] * SHK + OUT[0] * SHADOW_ALPHA; px[o + 1] = px[o + 1] * SHK + OUT[1] * SHADOW_ALPHA; px[o + 2] = px[o + 2] * SHK + OUT[2] * SHADOW_ALPHA;
  }

  if (style === 'flat' && !burnt) {
    // a grid fixed in the world, so props match across chunk edges
    const cell = (big ? 6.5 : 4.5) * tpm;
    const gx0 = Math.floor((bx0 + ctx.wx0) / cell), gx1 = Math.floor((bx1 + ctx.wx0) / cell);
    const gy0 = Math.floor((by0 + ctx.wy0) / cell), gy1 = Math.floor((by1 + ctx.wy0) / cell);
    const sky = shop || BIG_FLAT.has(job.cls) || hall;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const hsh = hash2(gx, gy, job.seed ^ 0x51);
        const p = (hsh & 255) / 256;
        if (p > (big ? 0.62 : 0.5)) continue;
        let kind: PropKind, wM: number, hM: number;
        if (big) {
          kind = p < 0.16 ? 'hvac' : p < 0.3 && sky ? 'sky' : p < 0.38 ? 'ac' : p < 0.46 ? 'vent' : p < 0.54 ? 'housing' : 'hatch';
        } else kind = p < 0.2 ? 'ac' : p < 0.32 && sky ? 'sky' : p < 0.4 ? 'vent' : 'hatch';
        switch (kind) {
          case 'hvac': wM = 3.0; hM = 1.5; break;
          case 'housing': wM = 3.2; hM = 2.6; break;
          case 'ac': wM = 1.3; hM = 1.0; break;
          case 'sky': wM = big ? 3.4 : 1.6; hM = big ? 1.8 : 1.3; break;
          case 'vent': wM = 0.7; hM = 0.7; break;
          default: wM = 1.0; hM = 1.0;
        }
        const w = Math.max(S > 1 ? 4 : 2, Math.round(wM * am)), h = Math.max(S > 1 ? 4 : 2, Math.round(hM * am));
        const jx = ((hsh >>> 8) % 100) / 100, jy = ((hsh >>> 16) % 100) / 100;
        const x = Math.round((gx * cell + jx * (cell - (wM + 0.8) * tpm) - ctx.wx0) * S), y = Math.round((gy * cell + jy * (cell - (hM + 0.8) * tpm) - ctx.wy0) * S);
        prop(x, y, w, h, kind);
      }
    }
  } else if (style === 'pitched' && (home || job.cls === 'apartments') && ((s >>> 21) % 10) < 6 && ha > 2.5 * tpm) {
    // a chimney beside the ridge, a quarter of the way along
    const sa = ((s >>> 23) & 1 ? 1 : -1) * ha * 0.5, sb = -panelSide * Math.min(hb * 0.45, 1.0 * tpm);
    const cu = uc + (ridgeAlongU ? sa : sb), cv = vc + (ridgeAlongU ? sb : sa);
    const fx = cu * ux - cv * uy, fy = cu * uy + cv * ux;
    const w = Math.max(S > 1 ? 4 : 2, Math.round(0.75 * am));
    prop(Math.round((fx - t.ox) * S - w / 2), Math.round((fy - t.oy) * S - w / 2), w, w, 'chimney');
  }

  // a door not facing the camera: its canopy at the roof edge
  if (!doorSouth) {
    const tnx = -job.door.ny, tny = job.door.nx;
    const r = Math.ceil(dHalf) + 2 * S;
    for (let yy = Math.floor(dsy) - r; yy <= Math.ceil(dsy) + r; yy++) {
      for (let xx = Math.floor(dsx) - r; xx <= Math.ceil(dsx) + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= W) continue;
        const lx = xx - mx0, ly = yy - my0;
        if (lx < 0 || ly < 0 || lx >= mw || ly >= mh || !m[ly * mw + lx]) continue;
        const qx = xx + 0.5 - dsx, qy = yy + 0.5 - dsy;
        const along = Math.abs(qx * tnx + qy * tny), depth = -(qx * job.door.nx + qy * job.door.ny);
        if (along > dHalf + 1 || depth > 0.55 * am + 1) continue;
        const bd = along > dHalf || depth > 0.55 * am || edge[ly * mw + lx];
        put(xx, yy, bd ? OUT : doorCol, burnt ? 0.3 : (depth < S ? 0.8 : 1));
      }
    }
  }
}

function shortSide(job: ExteriorJob, outer: number[]): number {
  const ux = job.ux, uy = job.uy;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    const u = outer[i] * ux + outer[i + 1] * uy, v = -outer[i] * uy + outer[i + 1] * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  return Math.min(u1 - u0, v1 - v0);
}
