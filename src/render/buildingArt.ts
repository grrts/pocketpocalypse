// Building exteriors in the street-level texture: pitched tile roofs with a
// ridge and a lit and a shaded slope, flat roofs with gravel, parapets and
// plant, corrugated metal halls, burnt shells, and along each building's
// southern edge a strip of facade (the light 3/4 cheat) with windows, a sign
// band on shops and the front door when it faces the camera. Everything stays
// inside the true footprint, so collision and the street are untouched.

import { hash2, valueNoise } from '../core/rng';
import { IS_ROOF, M, materialColor } from './materials';
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
  /** chunk raster (ids + aux heights) and its RGBA */
  R: IdRaster;
  rgba: Uint8ClampedArray;
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

const BRICK = ['#8e4f3c', '#7d4434', '#94583f', '#6e3d31', '#a0714c'].map(hex);
const RENDER = ['#cfc6b2', '#c2b9a6', '#d6cfbf', '#b9b1a1'].map(hex);
const CONCRETE = ['#a19c92', '#948f86', '#aaa59a'].map(hex);
const METAL = ['#7d8790', '#6f7a72', '#8a8f94', '#6d7f8c'].map(hex);
const TIMBER = ['#6b4a2f', '#5a3e2a', '#7a5636'].map(hex);
const STONE = hex('#8a8478');
const GLASS = hex('#5d7a86'), GLASS_HI = hex('#a9c3c8'), FRAME = hex('#e6e0d2'), SILL = hex('#d2cbbc');
const BROKEN = hex('#25292c'), BOARD = hex('#7a5a3a');
const DOORS = ['#2f4a3a', '#2b3d5a', '#6a2a24', '#3a3434', '#5a3a26', '#e6e0d2'].map(hex);
const SIGNS = ['#2f5f8a', '#8a2f2f', '#2f7a4a', '#c9a43a', '#45403c', '#c4632a'].map(hex);
const SOOT = hex('#2b2725'), CHAR = hex('#3a2a20'), EMBER = hex('#c4471d'), ASH = hex('#6b625a');
const GRAVEL = hex('#8d877c'), TRIM = hex('#a9a398'), AC = hex('#b9b9b2');
const IVY = hex('#4f7430');
const MULLION = hex('#3c3c3c'), RUST = hex('#8a5a3c'), RAFTER = hex('#22180f'), GRID = hex('#c8ccc4'), PANE = hex('#93adb3');
const AC_FAN = hex('#5a5c5e'), VENT = hex('#3a3a3a');

const SHOPS = new Set(['shop', 'retail', 'commercial', 'grocery', 'supermarket', 'pharmacy', 'hardware', 'outdoor', 'food_service', 'fuel']);
const HALLS = new Set(['industrial', 'warehouse', 'garage', 'mechanic', 'farm', 'shed', 'fire_station', 'military']);
const HOMES = new Set(['house', 'residential', 'other']);

// 64x64 per-texel random table
const NOISE = new Float32Array(4096);
for (let i = 0; i < 4096; i++) NOISE[i] = hash2(i & 63, i >> 6, 913) / 4294967296;
const grain = (x: number, y: number) => NOISE[((y & 63) << 6) | (x & 63)];

type RoofStyle = 'pitched' | 'flat' | 'metal' | 'glass' | 'burnt';

function wallColor(cls: string, seed: number): { c: RGB; kind: 'brick' | 'render' | 'metal' | 'timber' | 'stone' } {
  const k = (seed >>> 5) % 97;
  if (cls === 'church') return { c: STONE, kind: 'stone' };
  if (cls === 'farm') return k % 3 ? { c: TIMBER[k % TIMBER.length], kind: 'timber' } : { c: METAL[k % METAL.length], kind: 'metal' };
  if (HALLS.has(cls)) return k % 4 ? { c: METAL[k % METAL.length], kind: 'metal' } : { c: BRICK[k % BRICK.length], kind: 'brick' };
  if (HOMES.has(cls)) return k % 7 ? { c: BRICK[k % BRICK.length], kind: 'brick' } : { c: RENDER[k % RENDER.length], kind: 'render' };
  if (cls === 'apartments') return k % 3 === 0 ? { c: RENDER[k % RENDER.length], kind: 'render' } : k % 3 === 1 ? { c: CONCRETE[k % CONCRETE.length], kind: 'render' } : { c: BRICK[k % BRICK.length], kind: 'brick' };
  return k % 2 ? { c: RENDER[k % RENDER.length], kind: 'render' } : k % 4 === 0 ? { c: BRICK[k % BRICK.length], kind: 'brick' } : { c: CONCRETE[k % CONCRETE.length], kind: 'render' };
}

function roofStyle(job: ExteriorJob, short: number, tpm: number): RoofStyle {
  if (job.burnt) return 'burnt';
  switch (job.roof) {
    case M.GLASS: return 'glass';
    case M.ROOF_METAL: return 'metal';
    case M.ROOF_FLAT: return 'flat';
    case M.ROOF_GRAY: return HALLS.has(job.cls) ? 'metal' : 'flat';
    default: return short <= 17 * tpm || job.cls === 'church' ? 'pitched' : 'flat';
  }
}

// scratch buffers reused for every building
let S_CAP = 0;
let S_MASK = new Uint8Array(0), S_RUN = new Uint8Array(0), S_SEG = new Uint8Array(0);
function grow(n: number) {
  if (n <= S_CAP) return;
  S_CAP = Math.max(n, S_CAP * 2, 16384);
  S_MASK = new Uint8Array(S_CAP); S_RUN = new Uint8Array(S_CAP); S_SEG = new Uint8Array(S_CAP);
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

/** Paint one building's roof and south facade into the chunk RGBA (after shading). */
export function paintExterior(job: ExteriorJob, ctx: ExteriorContext): void {
  const { R, rgba, t, tpm } = ctx;
  const N = R.w;
  const outer = job.rings[0];
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    const x = outer[i] - t.ox, y = outer[i + 1] - t.oy;
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  const FH = Math.max(2, Math.round(1.5 * tpm));
  // local mask: the footprint, clipped to the chunk plus room below for the facade runs
  const mx0 = Math.max(-1, Math.floor(bx0) - 1), mx1 = Math.min(N, Math.ceil(bx1) + 1);
  const my0 = Math.max(-1, Math.floor(by0) - 1), my1 = Math.min(N + FH + 1, Math.ceil(by1) + 1);
  if (mx1 <= mx0 || my1 <= my0 || mx1 < 0 || my0 > N) return;
  const mw = mx1 - mx0 + 1, mh = my1 - my0 + 1;
  grow(mw * mh);
  const m = S_MASK, run = S_RUN, seg = S_SEG;
  const glassRoof = !job.burnt && job.roof === M.GLASS;
  m.fill(0, 0, mw * mh);
  fillRings(m, mw, mh, job.rings, t.ox + mx0, t.oy + my0);
  for (let x = 0; x < mw; x++) {
    let r = -1;
    for (let y = mh - 1; y >= 0; y--) {
      const i = y * mw + x;
      if (!m[i]) { r = -1; continue; }
      r = r < 0 ? 0 : Math.min(255, r + 1);
      run[i] = r;
    }
    // total run length, written top-down
    let y = 0;
    while (y < mh) {
      if (!m[y * mw + x]) { y++; continue; }
      const top = y;
      while (y < mh && m[y * mw + x]) y++;
      // facade strip height for this run; none where a taller neighbour abuts to the south
      let fh = glassRoof ? 0 : Math.min(FH, Math.floor((y - top) * 0.4));
      const cx = x + mx0, by = y + my0;
      if (fh > 0 && by >= 0 && by < N && cx >= 0 && cx < N) {
        const bi = by * N + cx;
        if (IS_ROOF[R.ids[bi]] && R.aux[bi] >= job.height) fh = 0;
      }
      for (let k = top; k < y; k++) seg[k * mw + x] = fh;
    }
  }

  // roof frame
  const ux = job.ux, uy = job.uy;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    const u = outer[i] * ux + outer[i + 1] * uy, v = -outer[i] * uy + outer[i + 1] * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2, hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
  const style = roofStyle(job, Math.min(hu, hv) * 2, tpm);
  // ridge along the long side; hipped ends on some detached houses
  const ridgeAlongU = hu >= hv;
  const hip = style === 'pitched' && ((job.seed >>> 11) & 3) === 0 && Math.max(hu, hv) < 2.2 * Math.min(hu, hv);
  const base = materialColor(job.roof === M.ROOF_BURNT ? M.ROOF_DARK : job.roof);
  const wall = wallColor(job.cls, job.seed);
  const shop = SHOPS.has(job.cls);
  const hall = HALLS.has(job.cls);
  const sign = SIGNS[(job.seed >>> 7) % SIGNS.length];
  const doorCol = DOORS[(job.seed >>> 9) % DOORS.length];
  const gravel = style === 'flat' && ((job.seed >>> 13) & 1) === 1;
  const flatBase = gravel ? GRAVEL : base;

  // south-facing windows and the door, as column ranges in chunk pixels
  const wins: number[] = [];
  for (let i = 0; i < job.windows.length; i += 6) {
    if (job.windows[i + 5] < 0.35) continue;
    const a = job.windows[i] - t.ox, b = job.windows[i + 2] - t.ox;
    wins.push(Math.round(Math.min(a, b)), Math.round(Math.max(a, b)) - 1, i / 6);
  }
  const dsx = job.door.x - t.ox, dsy = job.door.y - t.oy;
  const doorSouth = job.door.ny > 0.35;
  const dHalf = (hall ? 1.5 : shop ? 0.9 : 0.55) * tpm;
  const dA = Math.round(dsx - dHalf), dB = Math.round(dsx + dHalf) - 1;

  const damage = ctx.damage;
  const ids = R.ids;
  for (let ly = 0; ly < mh; ly++) {
    const y = ly + my0;
    if (y < 0 || y >= N) continue;
    const wy = ctx.wy0 + y;
    for (let lx = 0; lx < mw; lx++) {
      const li = ly * mw + lx;
      if (!m[li]) continue;
      const x = lx + mx0;
      if (x < 0 || x >= N) continue;
      const ci = y * N + x;
      if (!IS_ROOF[ids[ci]]) continue;
      const wx = ctx.wx0 + x;
      const g = grain(wx, wy);
      let cr: number, cg: number, cb: number;
      // facade strip height for this column
      const fh = seg[li];
      const r = run[li];
      const left = lx === 0 || !m[li - 1], right = lx === mw - 1 || !m[li + 1];
      if (r < fh) {
        // ---- facade
        const fr = fh - 1 - r; // 0 = under the eaves
        let c: RGB = wall.c;
        let f = 0.94 + g * 0.08;
        if (wall.kind === 'brick' && ((wx + (fr & 1) * 2) & 3) === 0) f *= 0.93;
        if (wall.kind === 'metal' && (wx & 1)) f *= 0.86;
        if (wall.kind === 'timber' && (wx % 3 === 0)) f *= 0.8;
        let win = -1, wpos = 0, wlen = 0;
        for (let k = 0; k < wins.length; k += 3) {
          if (x >= wins[k] && x <= wins[k + 1]) { win = wins[k + 2]; wpos = x - wins[k]; wlen = wins[k + 1] - wins[k] + 1; break; }
        }
        const inDoor = doorSouth && x >= dA && x <= dB && Math.abs(y + r - dsy) < FH + 2;
        if (fr === 0) {
          if (shop) { c = sign; f = left || right ? 0.8 : 1; }
          else if (style === 'flat') { c = TRIM; f = 0.85; }
          else { c = base; f = 0.5; }
        } else if (inDoor) {
          if (hall) { c = METAL[1]; f = (fr & 1) ? 0.85 : 1.05; if (fr === fh - 1) f *= 0.8; }
          else if (fr === fh - 1) { c = SILL; f = 0.9; }
          else { c = doorCol; f = x === dA || x === dB ? 0.8 : 1; }
        } else if (fr === fh - 1) {
          c = win >= 0 && !shop && !hall ? SILL : wall.c;
          f = win >= 0 && !shop && !hall ? 1 : 0.72 * (0.95 + g * 0.08);
          if (g < ctx.overgrowth * 0.3) { c = IVY; f = 0.9 + g; }
        } else if (shop && !left && !right) {
          // shop window across the whole front, mullions every few texels
          c = (wx % 5 === 0) ? MULLION : GLASS;
          f = fr === 1 && (wx % 5) === 1 ? 1.35 : 1;
          if (hash2(wx >> 2, job.seed, 3) / 4294967296 < damage * 0.3) { c = BROKEN; f = 1; }
        } else if (win >= 0 && !hall) {
          const hw = hash2(win, job.seed, 5) / 4294967296;
          if (hw < damage * 0.18) { c = BOARD; f = (wx + fr) % 3 === 0 ? 0.75 : 1; }
          else if (hw < damage * 0.5) { c = BROKEN; f = g > 0.85 ? 3 : 1; }
          else if (wlen >= 4 && (wpos === 0 || wpos === wlen - 1)) { c = FRAME; f = 0.95; }
          else { c = fr === 1 && wpos <= 1 ? GLASS_HI : GLASS; f = 1; }
        } else if (win >= 0 && hall && fr === 1) {
          c = GLASS; f = 0.9;
        }
        if (left) f *= 1.08;
        if (right) f *= 0.84;
        if (job.burnt) {
          f *= 0.42 + (fr / fh) * 0.15;
          if (c === GLASS || c === GLASS_HI || c === FRAME) { c = SOOT; f = 0.6; }
        }
        cr = c[0] * f; cg = c[1] * f; cb = c[2] * f;
      } else {
        // ---- roof
        const px = wx + 0.5, py = wy + 0.5;
        const u = px * ux + py * uy, v = -px * uy + py * ux;
        let c: RGB = base, f = 1;
        const top = ly === 0 || !m[li - mw];
        if (style === 'pitched' || style === 'burnt') {
          const du = u - uc, dv = v - vc;
          // which slope: the two long sides, or hipped ends
          const a = ridgeAlongU ? du : dv, b = ridgeAlongU ? dv : du;
          const ha = ridgeAlongU ? hu : hv, hb = ridgeAlongU ? hv : hu;
          const e = hip ? Math.abs(a) - (ha - hb) : -1e9;
          let nx: number, ny: number, dist: number, along: number;
          if (e > Math.abs(b)) {
            const s = a > 0 ? 1 : -1;
            nx = (ridgeAlongU ? ux : -uy) * s; ny = (ridgeAlongU ? uy : ux) * s;
            dist = e; along = b;
          } else {
            const s = b > 0 ? 1 : -1;
            nx = (ridgeAlongU ? -uy : ux) * s; ny = (ridgeAlongU ? ux : uy) * s;
            dist = Math.abs(b); along = a;
          }
          // lit from the west-north-west so NW-SE ridges still show a bright and a dark slope
          f = 1 + (-nx * 0.86 - ny * 0.51) * 0.3;
          const row = Math.floor(dist);
          if (row % 2 === 1) f *= 0.88;
          else if ((Math.floor(along) + (row >> 1) * 2) % 3 === 0) f *= 0.96;
          if (dist < 0.75) f *= 0.8; // ridge cap
          if (g > 0.985) f *= 0.88;
          if (style === 'burnt') {
            c = SOOT;
            const n = valueNoise(wx / 6, wy / 6, job.seed & 1023);
            if (n > 0.52) {
              // fallen in: charred rafters over a burnt-out floor
              c = Math.floor(along) % 3 === 0 && n < 0.7 ? RAFTER : CHAR;
              f = 0.8 + g * 0.4;
              if (g > 0.93) { c = EMBER; f = 0.8; }
              else if (g < 0.12) { c = ASH; f = 1; }
            } else f = 0.8 + g * 0.35;
          }
        } else if (style === 'flat') {
          c = flatBase;
          f = gravel ? 0.88 + g * 0.24 : 0.95 + g * 0.08;
          const edge = left || right || top || ly === mh - 1 || !m[li + mw];
          if (edge) { c = TRIM; f = 1; }
          else if ((lx > 1 && !m[li - 2]) || (ly > 1 && !m[li - 2 * mw]) || !m[li - mw - 1]) f *= 0.8; // parapet shadow
        } else if (style === 'metal') {
          const rib = Math.floor(ridgeAlongU ? v : u) & 1;
          f = rib ? 0.88 : 1.06;
          const rust = grain((wx >> 3) + job.seed, (wy >> 3) + (job.seed >>> 6));
          if (rust < 0.25 + damage * 0.3 && g < 0.6) { c = RUST; f *= 0.9 + g * 0.2; }
        } else {
          c = (wx % 3 === 0 || wy % 3 === 0) ? GRID : PANE;
          f = 0.95 + g * 0.1;
          if (g < damage * 0.15) c = BROKEN;
        }
        if (style !== 'flat') {
          if (top || left) f *= 1.1;
          if (right) f *= 0.85;
        }
        cr = c[0] * f; cg = c[1] * f; cb = c[2] * f;
      }
      const o = ci * 4;
      rgba[o] = cr; rgba[o + 1] = cg; rgba[o + 2] = cb;
    }
  }

  if (style === 'flat') flatRoofKit(job, ctx, m, mw, mh, mx0, my0, FH);
  // a door not facing the camera: a doormat outside and a gap in the roof edge
  if (!doorSouth) {
    const mx = Math.round(dsx + job.door.nx * 0.9 * tpm - 0.5), my = Math.round(dsy + job.door.ny * 0.9 * tpm - 0.5);
    const tx = Math.round(-job.door.ny), ty = Math.round(job.door.nx);
    for (let k = -1; k <= 1; k++) {
      const x = mx + tx * k, y = my + ty * k;
      if (x < 0 || y < 0 || x >= N || y >= N || IS_ROOF[ids[y * N + x]]) continue;
      const o = (y * N + x) * 4;
      rgba[o] = 92; rgba[o + 1] = 74; rgba[o + 2] = 56;
    }
    const gx = Math.floor(dsx - job.door.nx * 0.5), gy = Math.floor(dsy - job.door.ny * 0.5);
    for (let k = -1; k <= 1; k++) {
      const x = gx + tx * k, y = gy + ty * k;
      if (x < 0 || y < 0 || x >= N || y >= N || !IS_ROOF[ids[y * N + x]]) continue;
      const o = (y * N + x) * 4;
      rgba[o] *= 0.45; rgba[o + 1] *= 0.45; rgba[o + 2] *= 0.45;
    }
  }
}

/** Air-conditioning units, vents and skylights on flat roofs. */
function flatRoofKit(job: ExteriorJob, ctx: ExteriorContext, m: Uint8Array, mw: number, mh: number, mx0: number, my0: number, FH: number) {
  const { rgba, R } = ctx;
  const N = R.w;
  const cell = 9;
  const inMask = (x: number, y: number) => {
    const lx = x - mx0, ly = y - my0;
    return lx >= 0 && ly >= 0 && lx < mw && ly < mh && m[ly * mw + lx] === 1;
  };
  const gx0 = Math.floor((ctx.wx0 + mx0) / cell), gx1 = Math.floor((ctx.wx0 + mx0 + mw) / cell);
  const gy0 = Math.floor((ctx.wy0 + my0) / cell), gy1 = Math.floor((ctx.wy0 + my0 + mh) / cell);
  const sky = SHOPS.has(job.cls) || job.cls === 'office' || job.cls === 'school';
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const hsh = hash2(gx, gy, job.seed ^ 0x51);
      const p = (hsh & 255) / 256;
      if (p > 0.45) continue;
      const x = gx * cell + ((hsh >>> 8) % 5) - ctx.wx0, y = gy * cell + ((hsh >>> 12) % 5) - ctx.wy0;
      const kind = p < 0.18 ? 'ac' : p < 0.3 && sky ? 'sky' : 'vent';
      const w = kind === 'ac' ? 3 : kind === 'sky' ? 3 : 1, h = kind === 'ac' ? 2 : kind === 'sky' ? 2 : 1;
      // whole unit plus margin on the roof, and clear of the facade strip
      let ok = true;
      for (let yy = y - 2; yy <= y + h + 1 + FH && ok; yy++) for (let xx = x - 2; xx <= x + w + 1; xx++) if (!inMask(xx, yy)) { ok = false; break; }
      if (!ok) continue;
      for (let yy = y; yy <= y + h; yy++) {
        for (let xx = x; xx <= x + w; xx++) {
          if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
          const o = (yy * N + xx) * 4;
          const shadow = xx === x + w || yy === y + h;
          if (shadow) { rgba[o] *= 0.6; rgba[o + 1] *= 0.6; rgba[o + 2] *= 0.62; continue; }
          let c: RGB;
          if (kind === 'ac') c = (xx === x + 1 && yy === y) ? AC_FAN : AC;
          else if (kind === 'sky') c = yy === y ? GLASS_HI : GLASS;
          else c = VENT;
          const f = yy === y && kind === 'ac' ? 1.08 : 1;
          rgba[o] = c[0] * f; rgba[o + 1] = c[1] * f; rgba[o + 2] = c[2] * f;
        }
      }
    }
  }
}
