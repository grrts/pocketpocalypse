// The inside view of a building, drawn on the art grid (4 pixels per world
// texel, about 9 cm each) from its floor plan, in the arcade style: clean flat
// floors (wood planks, checker tiles, carpets in a few colours), thick walls
// with dark outlines, doorways with door leaves, windows in the outer walls,
// chunky outlined furniture, and a little clutter (blood, papers, a toppled
// chair). The collision raster (texel grid) decides where you can walk; this
// only draws.

import { hash2 } from '../core/rng';
import type { BuildingInfo } from '../world/spawnTypes';
import type { PlanItem } from '../world/interior';
import { M } from './materials';
import { facadeColor, fillRings } from './buildingArt';

/** art pixels per world texel */
export const ART = 4;

const enum K { NONE = 0, FLOOR = 1, WALL = 2, OUTER = 3, SILL = 4, GLASS = 5, FRAME = 6, THING = 7, LEAF = 8, FLAT = 9 }

const rgb = (h: string) => parseInt(h.slice(1), 16);
const R8 = (c: number) => (c >> 16) & 255, G8 = (c: number) => (c >> 8) & 255, B8 = (c: number) => c & 255;
const mul = (c: number, f: number) => (Math.min(255, R8(c) * f) << 16) | (Math.min(255, G8(c) * f) << 8) | Math.min(255, B8(c) * f);
const pick = <T>(a: T[], v: number) => a[(v >>> 0) % a.length];

const OUT = rgb('#1b1a2e');
const C = {
  wood: rgb('#c98d52'), concrete: rgb('#aeb0ac'), stone: rgb('#dcd2bc'),
  wallTop: rgb('#f3ead6'), sill: rgb('#8a5a32'), frame: rgb('#6a4226'),
  glass: rgb('#8fd0ea'), glassHi: rgb('#e0f6ff'), windowSill: rgb('#f4f1e8'),
  leaf: rgb('#b8783e'), leafHi: rgb('#d49a5a'), knob: rgb('#ffd040'),
  blood: rgb('#a01c1c'), bloodDk: rgb('#6a1010'), paper: rgb('#f4f2ea'),
};

// carpets by room
const CARPET: Record<string, number[]> = {
  living: ['#5a7ab8', '#b05a50', '#5f9a68', '#c49a4a'].map(rgb),
  bed: ['#8a6ab0', '#5a8ab8', '#c87a8a', '#6aa88a'].map(rgb),
  office: ['#5a6a8a', '#4f7a9a', '#7a6a5a'].map(rgb),
  class: ['#4f7ab0', '#5f9a68', '#b07a4a'].map(rgb),
  other: ['#7a6ab0', '#5a8ab8', '#b06060'].map(rgb),
};
// checker tiles: light, dark
const CHECKER: [number, number][] = [[rgb('#f2f4f4'), rgb('#9cc4d8')], [rgb('#f0ece2'), rgb('#3e3e52')], [rgb('#f2eee4'), rgb('#d07a5a')], [rgb('#eef2ea'), rgb('#8ab88a')]];

const FABRIC = ['#5a6ab8', '#c07a3a', '#3a8a9a', '#b83a3a', '#5a9a4a', '#8a5ab0'].map(rgb);
const BLANKET = ['#4a7ac8', '#c84a4a', '#5aa85a', '#e0c070', '#9a6ac8', '#f0a040'].map(rgb);
const GOODS = ['#e04a3a', '#3a7ae0', '#f0c83a', '#4ab85a', '#f4f0e6', '#9a5ae0', '#f08a3a', '#3ac0c0'].map(rgb);
const BOOKS = ['#b03030', '#2f5f9a', '#3f8a3a', '#e0b43a', '#7a4a9a', '#e8e0cf', '#5a3a2a'].map(rgb);
const CARS = ['#d0d0cc', '#2a2a3a', '#c03030', '#2a5aa8', '#f0ece0', '#4a8a4a'].map(rgb);
const RUGS: [number, number][] = [[rgb('#b04040'), rgb('#f0c870')], [rgb('#3a6aa8'), rgb('#e8e0c0')], [rgb('#5a8a3a'), rgb('#f0e0a0')], [rgb('#8a4a9a'), rgb('#f4e4c8')]];
const LOCKERS = ['#4a7ac8', '#c84a4a', '#4aa86a', '#e0a030'].map(rgb);

const WOOD_D = rgb('#7a4a2a'), WOOD_M = rgb('#a8703e'), WOOD_L = rgb('#d49c60');
const WHITE = rgb('#f4f2ec'), STEEL = rgb('#b4bec4'), DARK = rgb('#2a2a36'), GREY = rgb('#8e9098');

/** Pixel colour of a furniture piece at (a, b): a along its length, b from its back. -1 = transparent. */
function furniture(kind: string, a: number, b: number, L: number, D: number, v: number): number {
  const edge = a === 0 || b === 0 || a === L - 1 || b === D - 1;
  const front = b === D - 1, right = a === L - 1;
  const h = (x: number, y: number) => hash2(x, y, v) & 255;
  switch (kind) {
    case 'bed': {
      if (b < 2) return mul(WOOD_D, 1.15);
      if (a === 0 || right) return WOOD_D;
      const pil = Math.max(3, Math.round(D * 0.22));
      if (b < 2 + pil) {
        const two = L >= 14, mid = Math.floor(L / 2);
        if (two && (a === mid || a === mid - 1)) return mul(pick(BLANKET, v), 0.7);
        if (a === 1 || right || a === L - 2 || b === 2 || b === 1 + pil) return rgb('#d8d4ca');
        return WHITE;
      }
      const c = pick(BLANKET, v);
      if (b === 2 + pil) return mul(c, 1.25);
      if (front) return mul(c, 0.72);
      if (a === 1 || a === L - 2) return mul(c, 0.85);
      return c;
    }
    case 'sofa': case 'armchair': {
      const c = pick(FABRIC, v);
      if (b < 3) return mul(c, 0.75);
      if (a < 3 || a >= L - 3) return mul(c, 0.82);
      if (front) return mul(c, 0.8);
      if (kind === 'sofa') { const n = Math.max(1, Math.round((L - 6) / 7)); const seg = (L - 6) / n; if (n > 1 && Math.abs(((a - 3) % seg)) < 1 && a > 3) return mul(c, 0.75); }
      return b === 3 ? mul(c, 1.12) : c;
    }
    case 'tv': {
      if (b >= 1 && b <= 2 && a >= 2 && a < L - 2) return b === 1 ? DARK : rgb('#4a5a7a');
      return WOOD_D;
    }
    case 'coffeetable': case 'table': case 'cafetable': {
      if (kind === 'cafetable') { const r = (L - 1) / 2, dx = a - r, dy = b - r; if (dx * dx + dy * dy > r * r + 0.5) return -1; }
      if (kind === 'table' && (h(a >> 2, b >> 2) & 15) === 0) return WHITE;
      return b === 1 ? mul(WOOD_L, 1.1) : WOOD_L;
    }
    case 'chair':
      if (b <= 1) return WOOD_D;
      return WOOD_M;
    case 'rug': {
      const [c1, c2] = RUGS[(v >>> 0) % RUGS.length];
      if (a < 2 || b < 2 || a >= L - 2 || b >= D - 2) return c1;
      if (a === 3 || b === 3 || a === L - 4 || b === D - 4) return c2;
      const cx = Math.abs(a - L / 2) / (L / 2), cy = Math.abs(b - D / 2) / (D / 2);
      return cx + cy < 0.5 ? c2 : c1;
    }
    case 'kitchen': {
      if (b === 0) return rgb('#e8e4da');
      const sink = Math.floor(L * 0.3), stove = Math.floor(L * 0.68);
      if (a >= sink && a < sink + 6 && b >= 1 && b < D - 1) return b === 1 || b === D - 2 || a === sink || a === sink + 5 ? STEEL : rgb('#6a8494');
      if (L >= 14 && a >= stove && a < stove + 6 && b >= 1 && b < D - 1) {
        const ring = ((a - stove) % 3 === 1) && ((b - 1) % 3 === 1);
        return ring ? rgb('#e04a2a') : DARK;
      }
      if (front) return rgb('#9a8a7a');
      return rgb('#dcd8d0');
    }
    case 'fridge': case 'washer': {
      if (kind === 'washer') { const r = Math.min(L, D) / 2 - 1.5, dx = a - (L - 1) / 2, dy = b - (D - 1) / 2; if (dx * dx + dy * dy < r * r) return dx * dx + dy * dy < (r - 1.2) * (r - 1.2) ? rgb('#5a8ab0') : GREY; }
      if (kind === 'fridge' && b === D - 2 && a > 1 && a < 4) return GREY;
      return b === 1 ? WHITE : rgb('#e2e6e8');
    }
    case 'wardrobe': case 'cabinet': {
      if (a === Math.floor(L / 2)) return WOOD_D;
      if (b === D - 2 && (a === Math.floor(L / 2) - 2 || a === Math.floor(L / 2) + 2)) return C.knob;
      return b === 1 ? mul(WOOD_M, 1.12) : WOOD_M;
    }
    case 'bookshelf': case 'shelf': case 'gondola': {
      const frame = kind === 'bookshelf' ? WOOD_D : rgb('#8a8e98');
      if (a === 0 || right || b === 0 || front) return frame;
      if (kind === 'gondola' && Math.abs(b - (D - 1) / 2) < 0.6) return frame;
      if (kind === 'bookshelf') { if (a % 6 === 0) return frame; return BOOKS[h(a, 0) % BOOKS.length]; }
      // goods in rows; the picked-over gaps show the shelf
      const slot = h(a >> 1, b >> 1);
      if (slot < 70) return rgb('#5a5e6a');
      const c = GOODS[slot % GOODS.length];
      return (a & 1) ? mul(c, 0.85) : c;
    }
    case 'nightstand':
      if (Math.abs(a - (L - 1) / 2) < 1.2 && Math.abs(b - (D - 1) / 2) < 1.2) return rgb('#ffe08a');
      return WOOD_M;
    case 'desk': case 'schooldesk': {
      const top = kind === 'schooldesk' ? rgb('#e0b878') : rgb('#a8865a');
      if (kind === 'desk' && b >= 1 && b <= 2 && a >= L * 0.3 && a < L * 0.7) return DARK;
      if (kind === 'desk' && b === 4 && a >= L * 0.35 && a < L * 0.65) return rgb('#d0d0cc');
      if (kind === 'schooldesk' && b === 1 && a >= 2 && a < 6) return rgb('#4a7ac8');
      if ((h(a >> 1, b >> 1) & 31) === 0) return WHITE;
      return b === 1 ? mul(top, 1.1) : top;
    }
    case 'bathtub': case 'shower': case 'sink': {
      if (edge || (kind === 'bathtub' && (a === 1 || b === 1 || a === L - 2 || b === D - 2))) return WHITE;
      if (kind === 'shower') return (a % 3 === 0 || b % 3 === 0) ? rgb('#d8e4e8') : rgb('#a8d4e4');
      if (kind === 'bathtub' && a === 3 && b === Math.floor(D / 2)) return GREY;
      return rgb('#a8dcf0');
    }
    case 'toilet': {
      const tank = Math.max(2, Math.round(D * 0.35));
      if (b < tank) return WHITE;
      const r = (L - 1) / 2, dx = (a - r) / (r + 0.3), dy = (b - tank - (D - tank - 1) / 2) / ((D - tank) / 2 + 0.3);
      const d = dx * dx + dy * dy;
      if (d > 1) return -1;
      return d < 0.35 ? rgb('#9cd0e4') : WHITE;
    }
    case 'plant': {
      const r = (L - 1) / 2, dx = a - r, dy = b - r, d = Math.sqrt(dx * dx + dy * dy);
      const lump = r * (0.8 + (h(Math.round(Math.atan2(dy, dx) * 2), 0) & 63) / 320);
      if (d > lump) return -1;
      return d < r * 0.3 ? rgb('#c46a3a') : (dx + dy < 0 ? rgb('#7ac84a') : rgb('#4a9a3a'));
    }
    case 'counter': case 'checkout': {
      if (a < 6 && b >= 1 && b <= 4) return b === 1 ? rgb('#5a6066') : rgb('#7ac0e0');
      if (kind === 'checkout' && a >= 7 && b >= 1 && b < D - 1) return (a % 3 === 0) ? rgb('#3a3a44') : rgb('#5a5a66');
      if (front) return rgb('#c84a3a');
      if (L > 14 && b >= 2 && b < D - 2 && a > 7) return (a % 2) ? rgb('#2e2e36') : rgb('#3a3a44');
      return rgb('#e8e4dc');
    }
    case 'locker':
      if (a % 5 === 0) return mul(pick(LOCKERS, v), 0.7);
      if (b === 1 && a % 5 === 3) return WHITE;
      return pick(LOCKERS, v);
    case 'bench':
      return b === 1 ? mul(WOOD_L, 1.1) : WOOD_L;
    case 'rack': {
      if (a % 10 === 0 || right) return rgb('#f07a2a');
      if (b === 0 || front || Math.abs(b - (D - 1) / 2) < 0.6) return rgb('#3a6ac8');
      const bx = h(Math.floor(a / 5), b > D / 2 ? 1 : 0);
      if (bx < 50) return rgb('#4a4c56');
      return (a % 5 === 0 || (b % 4 === 0)) ? rgb('#a87a4a') : rgb('#d0a46a');
    }
    case 'pallet': case 'crate':
      if (kind === 'pallet') return (b % 3 === 2) ? mul(rgb('#c89a60'), 0.72) : rgb('#c89a60');
      return (a === b || a === L - 1 - b) ? mul(WOOD_M, 0.75) : WOOD_L;
    case 'machine':
      if (a <= 1 || b <= 1 || a >= L - 2 || b >= D - 2) return ((a + b) >> 1) & 1 ? rgb('#f0c030') : DARK;
      if (a > L * 0.6 && b > 2 && b < 6) return rgb('#4ae07a');
      return rgb('#7a8aa0');
    case 'hay':
      if (a === Math.floor(L / 3) || a === Math.floor((2 * L) / 3)) return rgb('#b09040');
      return (b + (h(a, 0) & 1)) % 2 ? rgb('#e0c060') : rgb('#f0d070');
    case 'workbench':
      if ((h(a >> 1, b >> 1) & 15) === 0) return GREY;
      return b < 2 ? rgb('#7a7a86') : WOOD_M;
    case 'drum': {
      const r = (L - 1) / 2, dx = a - r, dy = b - r, d = dx * dx + dy * dy;
      if (d > r * r + 0.5) return -1;
      const c = v & 1 ? rgb('#2a5ab0') : rgb('#c03a2a');
      return d < 1.2 ? DARK : (d > (r - 1.2) * (r - 1.2) ? mul(c, 1.25) : c);
    }
    case 'pew':
      if (b <= 1) return WOOD_D;
      return WOOD_M;
    case 'altar':
      if (b === 1 && (a === 2 || a === L - 3)) return rgb('#ffd860');
      return b === 1 ? WHITE : rgb('#ece6d8');
    case 'stairs':
      return (a % 3 === 0) ? WOOD_D : (a % 3 === 1 ? WOOD_L : WOOD_M);
    case 'board':
      return b === 0 ? GREY : (kind === 'board' && b > 0 && (h(a >> 1, 1) & 7) === 0 ? rgb('#4a7ac8') : WHITE);
    case 'trough':
      return b === 0 || front ? GREY : rgb('#5a8aa0');
    case 'car': {
      const c = pick(CARS, v);
      const ra = Math.min(a, L - 1 - a), rb = Math.min(b, D - 1 - b);
      if (ra + rb < 2) return -1;
      const t = a / L;
      if ((t > 0.22 && t < 0.32) || (t > 0.7 && t < 0.78)) return rb > 1 ? rgb('#3a4a60') : mul(c, 0.7);
      return c;
    }
    case 'mat':
      return edge ? rgb('#5a4a36') : ((a + b) & 1 ? rgb('#8a6a48') : rgb('#7a5e40'));
  }
  return b === 1 ? WOOD_L : WOOD_M;
}

/** Fill pixels whose centres lie in an oriented box (art pixel coordinates). */
function box(W: number, H: number, cx: number, cy: number, ax: number, ay: number, bx: number, by: number, hl: number, hd: number, fn: (i: number, a: number, b: number) => void) {
  const r = Math.abs(ax) * hl + Math.abs(bx) * hd, s = Math.abs(ay) * hl + Math.abs(by) * hd;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - s)), y1 = Math.min(H - 1, Math.ceil(cy + s));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const a = dx * ax + dy * ay, b = dx * bx + dy * by;
      if (a < -hl || a >= hl || b < -hd || b >= hd) continue;
      fn(y * W + x, a + hl, b + hd);
    }
  }
}

const FLAT_ITEMS = new Set(['rug', 'mat']);

/** Paint a building's inside; returns RGBA at ART pixels per texel. */
export function paintInterior(b: BuildingInfo): { w: number; h: number; data: Uint8ClampedArray } {
  const S = ART;
  const W = b.w * S, H = b.h * S;
  const plan = b.plan!, ids = b.ids!;
  const seed = b.seed >>> 0;
  const n = W * H;
  const kind = new Uint8Array(n);
  const col = new Int32Array(n);
  const floor = new Uint8Array(n);
  const room = new Uint8Array(n);
  const item = new Int32Array(n);
  const local = b.rings.map((r) => r.map((v, i) => v - (i & 1 ? b.y0 : b.x0)));
  // footprint at art resolution
  const foot = new Uint8Array(n);
  fillRings(foot, W, H, local, 0, 0, S);
  const texel = (i: number) => ids[Math.floor(Math.floor(i / W) / S) * b.w + Math.floor((i % W) / S)];
  // floors by room
  const firstFloor = plan.rooms[0]?.floor ?? M.FLOOR_WOOD;
  for (let i = 0; i < n; i++) {
    const t = texel(i);
    if (!foot[i] && !t) continue;
    floor[i] = firstFloor;
    room[i] = 1;
    kind[i] = foot[i] ? K.FLOOR : K.OUTER;
  }
  plan.rooms.forEach((r, ri) => {
    const p = r.poly.map((v) => v * S);
    const cx = (p[0] + p[4]) / 2, cy = (p[1] + p[5]) / 2;
    const lx = p[2] - p[0], ly = p[3] - p[1], dx = p[6] - p[0], dy = p[7] - p[1];
    const L = Math.hypot(lx, ly), D = Math.hypot(dx, dy);
    if (L < 1 || D < 1) return;
    box(W, H, cx, cy, lx / L, ly / L, dx / D, dy / D, L / 2 + 0.5, D / 2 + 0.5, (i) => { if (kind[i] === K.FLOOR) { floor[i] = r.floor; room[i] = ri + 1; } });
  });
  // outer walls: a thick band inside the outline
  const band = (ax: number, ay: number, bx: number, by: number, half: number, ext: number, fn: (i: number, a: number, b: number) => void) => {
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
    if (l < 1e-6) return;
    box(W, H, (ax + bx) / 2, (ay + by) / 2, dx / l, dy / l, -dy / l, dx / l, l / 2 + ext, half, fn);
  };
  for (const r of local) {
    for (let k = 0; k + 3 < r.length; k += 2) {
      band(r[k] * S, r[k + 1] * S, r[k + 2] * S, r[k + 3] * S, S * 1.5, S * 0.75, (i) => { if (kind[i]) kind[i] = K.OUTER; });
    }
  }
  // inner walls
  for (let k = 0; k < plan.walls.length; k += 4) {
    band(plan.walls[k] * S, plan.walls[k + 1] * S, plan.walls[k + 2] * S, plan.walls[k + 3] * S, 2.1, S * 0.5, (i) => { if (kind[i] === K.FLOOR) kind[i] = K.WALL; });
  }
  // windows in the outer walls
  for (let k = 0; k < plan.windows.length; k += 6) {
    const w = plan.windows;
    band(w[k] * S, w[k + 1] * S, w[k + 2] * S, w[k + 3] * S, S * 1.55, 0, (i) => {
      if (kind[i] === K.OUTER && foot[i]) kind[i] = K.GLASS;
    });
  }
  // doorways: from the plan, plus any the collision raster opened
  for (const d of plan.doors) {
    const hl = (d.w * S) / 2, half = d.front ? S * 1.9 : 3;
    box(W, H, d.x * S, d.y * S, d.tx, d.ty, -d.ty, d.tx, hl, half, (i) => {
      if (kind[i] === K.WALL || kind[i] === K.OUTER || kind[i] === K.GLASS) kind[i] = K.SILL;
    });
  }
  for (let i = 0; i < n; i++) if ((kind[i] === K.WALL || kind[i] === K.OUTER) && texel(i) === M.DOORWAY && foot[i]) kind[i] = K.SILL;
  // door jambs: wall pixels touching a doorway
  for (let i = 0; i < n; i++) {
    if (kind[i] !== K.WALL && kind[i] !== K.OUTER) continue;
    const x = i % W;
    if ((x > 0 && kind[i - 1] === K.SILL) || (x < W - 1 && kind[i + 1] === K.SILL) || (i >= W && kind[i - W] === K.SILL) || (i < n - W && kind[i + W] === K.SILL)) kind[i] = K.FRAME;
  }

  // ---- colour
  const isWall = (k: number) => k === K.WALL || k === K.OUTER || k === K.FRAME || k === K.GLASS;
  const outerCol = (() => { const c = facadeColor(b.cls, b.seed); return (Math.min(255, c[0] * 1.08) << 16) | (Math.min(255, c[1] * 1.08) << 8) | Math.min(255, c[2] * 1.08); })();
  const checker = CHECKER[(seed >>> 3) % CHECKER.length];
  const bigTiles = b.cls === 'shop' || b.cls === 'retail' || b.cls === 'supermarket' || b.cls === 'grocery' || b.cls === 'commercial' || b.cls === 'hospital' || b.cls === 'school' || b.cls === 'civic';
  const roomCarpet = plan.rooms.map((r, ri) => pick(CARPET[r.kind] ?? CARPET.other, hash2(ri, 3, seed)));
  const ux = plan.ux, uy = plan.uy;
  for (let i = 0; i < n; i++) {
    const k = kind[i];
    if (!k) continue;
    const x = i % W, y = (i - x) / W;
    let c: number;
    if (k === K.FLOOR) {
      const f = floor[i];
      // patterns follow the building's axis
      const pu = Math.floor(x * ux + y * uy), pv = Math.floor(-x * uy + y * ux);
      if (f === M.FLOOR_WOOD) {
        // planks 3 px wide with staggered end joints
        const row = Math.floor(pv / 3);
        const len = 14 + (hash2(row, 0, seed) & 7);
        const seam = (((pu + row * 7) % len) + len) % len === 0;
        const tone = hash2(row, Math.floor((pu + row * 7) / len), seed) & 3;
        c = mul(C.wood, seam || ((pv % 3) + 3) % 3 === 2 ? 0.84 : 0.96 + tone * 0.03);
      } else if (f === M.FLOOR_TILE) {
        if (bigTiles) {
          const grout = ((pu % 8) + 8) % 8 === 0 || ((pv % 8) + 8) % 8 === 0;
          c = grout ? mul(checker[0], 0.86) : checker[0];
        } else {
          c = ((Math.floor(pu / 4) + Math.floor(pv / 4)) & 1) ? checker[1] : checker[0];
        }
      } else if (f === M.FLOOR_CARPET) {
        c = roomCarpet[room[i] - 1] ?? CARPET.other[0];
      } else if (f === M.FLOOR_CONCRETE) {
        c = mul(C.concrete, (((pu % 24) + 24) % 24 === 0 || ((pv % 24) + 24) % 24 === 0) ? 0.88 : 1);
      } else if (f === M.FLOOR_STONE) {
        const row = Math.floor(pv / 6), off = row & 1 ? 4 : 0;
        c = mul(C.stone, (((pv % 6) + 6) % 6 === 0 || (((pu + off) % 8) + 8) % 8 === 0) ? 0.86 : 1);
      } else {
        c = C.wood;
      }
    } else if (k === K.WALL || k === K.OUTER) {
      // wall tops with a dark outline wherever they meet floor or the outside
      const x0 = x > 0 ? kind[i - 1] : 0, x1 = x < W - 1 ? kind[i + 1] : 0, y0 = y > 0 ? kind[i - W] : 0, y1 = y < H - 1 ? kind[i + W] : 0;
      const top = k === K.WALL ? C.wallTop : outerCol;
      if (!isWall(x0) || !isWall(x1) || !isWall(y0) || !isWall(y1)) c = OUT;
      else c = y0 !== K.WALL && y0 !== K.OUTER ? mul(top, 1.08) : top;
    } else if (k === K.GLASS) {
      const y0 = y > 0 ? kind[i - W] : 0, y1 = y < H - 1 ? kind[i + W] : 0, x0 = x > 0 ? kind[i - 1] : 0, x1 = x < W - 1 ? kind[i + 1] : 0;
      if (!x0 || !x1 || !y0 || !y1) c = OUT;
      else if (x0 === K.FLOOR || x1 === K.FLOOR || y0 === K.FLOOR || y1 === K.FLOOR) c = C.windowSill;
      else c = (x + y) % 6 < 2 ? C.glassHi : C.glass;
    } else if (k === K.SILL) {
      c = C.sill;
    } else {
      c = C.frame;
    }
    col[i] = c;
  }

  // ---- doors: leaves swung open against the wall
  const leafIdx = 1 << 20;
  for (const d of plan.doors) {
    if (!d.leaf) continue;
    const nx = -d.ty * d.leaf, ny = d.tx * d.leaf;
    const hx = (d.x + d.tx * (d.w / 2)) * S, hy = (d.y + d.ty * (d.w / 2)) * S;
    const len = d.w * S * 0.95;
    box(W, H, hx + nx * len / 2 - d.tx * 1.5, hy + ny * len / 2 - d.ty * 1.5, nx, ny, d.tx, d.ty, len / 2, 1.5, (i, a, bb) => {
      if (kind[i] !== K.FLOOR) return;
      kind[i] = K.LEAF;
      item[i] = leafIdx;
      col[i] = a > len - 3 && bb > 1 && bb < 2 ? C.knob : bb < 1 ? C.leafHi : C.leaf;
    });
  }
  const front = plan.doors.find((d) => d.front);
  const items: PlanItem[] = [...plan.items];
  if (front) {
    const nx = -front.ty, ny = front.tx;
    const ix = b.door.nx, iy = b.door.ny;
    const s = nx * -ix + ny * -iy > 0 ? 1 : -1;
    items.unshift({ k: 'mat', x: front.x + nx * s * 2, y: front.y + ny * s * 2, ax: front.tx, ay: front.ty, bx: nx * s, by: ny * s, l: 2.2, d: 1.3, v: 0, solid: false });
  }

  // ---- furniture: flat pieces first; a few chairs knocked over
  items.sort((p, q) => (FLAT_ITEMS.has(p.k) ? 0 : 1) - (FLAT_ITEMS.has(q.k) ? 0 : 1));
  items.forEach((it, idx) => {
    const L = Math.max(2, Math.round(it.l * S)), D = Math.max(2, Math.round(it.d * S));
    let { ax, ay, bx, by } = it;
    const flat = FLAT_ITEMS.has(it.k);
    let toppled = false;
    if (it.k === 'chair' && (hash2(idx, seed, 41) & 7) < 2) {
      // lying on its side: turned and darker
      const an = ((hash2(idx, seed, 43) & 255) / 255 - 0.5) * 2.4;
      const c = Math.cos(an), s = Math.sin(an);
      [ax, ay] = [ax * c - ay * s, ax * s + ay * c];
      [bx, by] = [bx * c - by * s, bx * s + by * c];
      toppled = true;
    }
    box(W, H, it.x * S, it.y * S, ax, ay, bx, by, L / 2, D / 2, (i, a, bb) => {
      const k = kind[i];
      if (k !== K.FLOOR && k !== K.THING && k !== K.LEAF && k !== K.FLAT) return;
      let c = furniture(it.k, Math.min(L - 1, Math.floor(a)), Math.min(D - 1, Math.floor(bb)), L, D, it.v);
      if (c < 0) return;
      if (toppled) c = mul(c, 0.8);
      col[i] = c;
      item[i] = idx + 1;
      kind[i] = flat ? K.FLAT : (it.solid || it.k === 'chair' ? K.THING : K.FLAT);
      if (!flat && !it.solid && it.k !== 'chair') kind[i] = K.THING;
    });
    if (flat) for (let i = 0; i < n; i++) if (item[i] === idx + 1) item[i] = -(idx + 1);
  });
  // outlines: every standing piece gets a dark rim where it meets something else
  for (let i = 0; i < n; i++) {
    const id = item[i];
    if (id <= 0) continue;
    const x = i % W;
    if ((x > 0 && item[i - 1] !== id) || (x < W - 1 && item[i + 1] !== id) || (i >= W && item[i - W] !== id) || (i < n - W && item[i + W] !== id)) col[i] = OUT;
  }

  // ---- shadows to the south-east of walls and furniture
  const solid = (k: number) => k === K.WALL || k === K.OUTER || k === K.FRAME || k === K.THING || k === K.GLASS;
  for (let i = n - 1; i >= 2 * W + 2; i--) {
    const k = kind[i];
    if (k !== K.FLOOR && k !== K.FLAT && k !== K.SILL) continue;
    if (solid(kind[i - W - 1]) || solid(kind[i - W]) || solid(kind[i - 2 * W - 2])) col[i] = mul(col[i], 0.8);
  }

  // ---- clutter: blood pools with drips, scattered papers
  const floorAt = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && (kind[y * W + x] === K.FLOOR || kind[y * W + x] === K.FLAT);
  if (!b.burnt) {
    const splats = 1 + (hash2(seed, 1, 5) % 3) + Math.floor((W * H) / 60000);
    for (let s = 0; s < splats; s++) {
      const cx = hash2(seed, s, 11) % W, cy = hash2(seed, s, 13) % H;
      if (!floorAt(cx, cy)) continue;
      const rr = 3 + (hash2(seed, s, 17) % 5);
      for (let dy = -rr - 3; dy <= rr + 3; dy++) {
        for (let dx = -rr - 3; dx <= rr + 3; dx++) {
          const x = cx + dx, y = cy + dy;
          if (!floorAt(x, y)) continue;
          const ang = Math.atan2(dy, dx);
          const lump = rr * (0.75 + ((hash2(Math.round(ang * 3), s, seed) & 255) / 255) * 0.5);
          const d = Math.hypot(dx, dy);
          const drop = (hash2(x, y, seed ^ s) & 63) === 0 && d < rr + 3;
          if (d < lump || drop) col[y * W + x] = d > lump - 1.2 && !drop ? C.bloodDk : C.blood;
        }
      }
    }
    const papers = 3 + (hash2(seed, 2, 5) % 6);
    for (let s = 0; s < papers; s++) {
      const cx = hash2(seed, s, 19) % W, cy = hash2(seed, s, 23) % H;
      const wide = hash2(seed, s, 29) & 1;
      for (let dy = 0; dy < (wide ? 2 : 3); dy++) for (let dx = 0; dx < (wide ? 3 : 2); dx++) if (floorAt(cx + dx, cy + dy)) col[(cy + dy) * W + cx + dx] = dy === 0 ? C.paper : mul(C.paper, 0.9);
    }
  }

  // ---- output; burnt-out shells are charred with glowing embers
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const k = kind[i];
    if (!k) continue;
    let c = col[i];
    if (b.burnt) {
      const x = i % W, y = (i - x) / W;
      const soot = hash2(x >> 3, y >> 3, seed) & 3;
      c = c === OUT ? OUT : mul(c, 0.26 + soot * 0.04);
      const e = hash2(x >> 1, y >> 1, seed ^ 0x3c) & 1023;
      if ((k === K.FLOOR || k === K.FLAT) && e < 6) c = e < 2 ? rgb('#ffc23a') : rgb('#ff7a1c');
      else if ((k === K.FLOOR || k === K.FLAT) && (hash2(x >> 2, y >> 2, seed ^ 0x5a) & 31) === 0) c = rgb('#6b625a');
    }
    const o = i * 4;
    out[o] = R8(c); out[o + 1] = G8(c); out[o + 2] = B8(c); out[o + 3] = 255;
  }
  return { w: W, h: H, data: out };
}
