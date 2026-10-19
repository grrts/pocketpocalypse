// The inside view of a building, drawn on the art grid (4 pixels per world
// texel, about 9 cm each) from its floor plan: floors by room type, walls with
// a light top and a shaded south face, doorways with frames and open doors,
// windows in the outer walls, and furniture as small pixel-art objects.
// The collision raster (texel grid) decides where you can walk; this only draws.

import { hash2 } from '../core/rng';
import type { BuildingInfo } from '../world/spawnTypes';
import type { ItemKind, PlanItem } from '../world/interior';
import { M } from './materials';
import { fillRings } from './buildingArt';

/** art pixels per world texel */
export const ART = 4;

const enum K { NONE = 0, FLOOR = 1, WALL = 2, OUTER = 3, SILL = 4, GLASS = 5, FRAME = 6, THING = 7, LEAF = 8 }

const rgb = (h: string) => parseInt(h.slice(1), 16);
const R8 = (c: number) => (c >> 16) & 255, G8 = (c: number) => (c >> 8) & 255, B8 = (c: number) => c & 255;
const mul = (c: number, f: number) => (Math.min(255, R8(c) * f) << 16) | (Math.min(255, G8(c) * f) << 8) | Math.min(255, B8(c) * f);

const C = {
  wood: rgb('#a0764a'), tile: rgb('#c8c2b4'), carpet: rgb('#6e6a78'), concrete: rgb('#8e8b85'), stone: rgb('#9a9180'),
  wallTop: rgb('#e4ddcf'), wallHi: rgb('#f3eee4'), wallFace: rgb('#b3a894'),
  outer: rgb('#b9ad98'), outerEdge: rgb('#7d705f'), sill: rgb('#8a6a48'), frame: rgb('#5a3e2a'),
  glass: rgb('#5d7a86'), glassHi: rgb('#a9c3c8'), leaf: rgb('#8a6240'), leafEdge: rgb('#5e4128'),
};

const CARPETS = ['#6e6a78', '#7a5f5a', '#5f6e64', '#6a6f80'].map(rgb);
const FABRIC = ['#6a5a8a', '#8a6a4a', '#4a6a7a', '#7a3a3a', '#5a7a5a', '#8a8070'].map(rgb);
const BLANKET = ['#5a7a9a', '#9a4a4a', '#6a8a5a', '#c8b48a', '#8a6a9a', '#d0a060'].map(rgb);
const GOODS = ['#c84a3a', '#3a7ac8', '#e8c84a', '#4aa85a', '#e8e4da', '#8a5ac8', '#d88a3a', '#3ab0b0'].map(rgb);
const BOOKS = ['#8a2f2f', '#2f4f7a', '#3f6a3a', '#c9a43a', '#6a4a7a', '#d6cfbf', '#4a3a2a'].map(rgb);
const CARS = ['#b8b8b4', '#2a2a2e', '#8a2a2a', '#2a4a7a', '#e0dcd0', '#4a5a3a'].map(rgb);
const RUGS: [number, number][] = [[rgb('#8a3a3a'), rgb('#c8a86a')], [rgb('#3a5a7a'), rgb('#c8c0a0')], [rgb('#5a6a3a'), rgb('#d0c090')], [rgb('#6a4a6a'), rgb('#d8c8b0')]];

const WOOD_D = rgb('#6b4a2f'), WOOD_M = rgb('#8a6a42'), WOOD_L = rgb('#a8865a');
const WHITE = rgb('#e8e6e0'), STEEL = rgb('#9aa4aa'), DARK = rgb('#2a2a2c'), GREY = rgb('#8a8a88');

/** Pixel colour of a furniture piece at (a, b): a along its length, b from its back. -1 = transparent. */
function furniture(k: ItemKind, a: number, b: number, L: number, D: number, v: number): number {
  const edge = a === 0 || b === 0 || a === L - 1 || b === D - 1;
  const front = b === D - 1, right = a === L - 1;
  const h = (x: number, y: number) => hash2(x, y, v) & 255;
  switch (k) {
    case 'bed': {
      if (b < 2) return a === 0 || right ? WOOD_D : mul(WOOD_D, 1.2);
      if (a === 0 || right) return WOOD_D;
      const pil = Math.max(3, Math.round(D * 0.22));
      if (b < 2 + pil) {
        const two = L >= 14, mid = Math.floor(L / 2);
        if (two && (a === mid || a === mid - 1)) return mul(BLANKET[v % 6], 0.7);
        if (a === 1 || right || a === L - 2 || b === 2 || b === 1 + pil) return rgb('#cfcac0');
        return WHITE;
      }
      const c = BLANKET[v % BLANKET.length];
      if (b === 2 + pil) return mul(c, 1.25);
      if (b === 3 + pil) return mul(c, 1.1);
      if (front) return mul(c, 0.7);
      if (a === 1 || a === L - 2) return mul(c, 0.85);
      return (b + a * 3) % 11 === 0 ? mul(c, 0.92) : c;
    }
    case 'sofa': case 'armchair': {
      const c = FABRIC[v % FABRIC.length];
      if (b < 3) return b === 0 ? mul(c, 0.6) : mul(c, 0.75);
      if (a < 3 || a >= L - 3) return a === 0 || right ? mul(c, 0.6) : mul(c, 0.8);
      if (front) return mul(c, 0.7);
      if (k === 'sofa') { const n = Math.max(1, Math.round((L - 6) / 7)); const seg = (L - 6) / n; if (n > 1 && Math.abs(((a - 3) % seg)) < 1 && a > 3) return mul(c, 0.72); }
      return b === 3 ? mul(c, 0.88) : c;
    }
    case 'tv': {
      if (b >= 1 && b <= 2 && a >= 2 && a < L - 2) return b === 1 ? DARK : rgb('#3a3e46');
      return edge ? mul(WOOD_D, 0.85) : WOOD_D;
    }
    case 'coffeetable': case 'table': case 'cafetable': {
      if (k === 'cafetable') { const r = (L - 1) / 2, dx = a - r, dy = b - r; const d = dx * dx + dy * dy; if (d > r * r + 0.5) return -1; if (d > (r - 1) * (r - 1)) return WOOD_D; }
      else if (edge) return WOOD_D;
      if (k === 'table' && (h(a >> 2, b >> 2) & 15) === 0) return WHITE;
      return b % 3 === 0 ? mul(WOOD_L, 0.9) : WOOD_L;
    }
    case 'chair':
      if (b === 0) return WOOD_D;
      return edge ? mul(WOOD_M, 0.8) : WOOD_M;
    case 'rug': {
      const [c1, c2] = RUGS[v % RUGS.length];
      if (a < 2 || b < 2 || a >= L - 2 || b >= D - 2) return c1;
      if (a === 3 || b === 3 || a === L - 4 || b === D - 4) return c2;
      const cx = Math.abs(a - L / 2) / (L / 2), cy = Math.abs(b - D / 2) / (D / 2);
      return cx + cy < 0.5 ? c2 : (cx + cy < 0.6 ? mul(c1, 0.8) : c1);
    }
    case 'kitchen': {
      if (b === 0) return (a & 1) ? rgb('#d8d4ca') : rgb('#e8e4da');
      const sink = Math.floor(L * 0.3), stove = Math.floor(L * 0.68);
      if (a >= sink && a < sink + 6 && b >= 1 && b < D - 1) return b === 1 || b === D - 2 || a === sink || a === sink + 5 ? STEEL : rgb('#6a747a');
      if (L >= 14 && a >= stove && a < stove + 6 && b >= 1 && b < D - 1) {
        const ring = ((a - stove) % 3 === 1) && ((b - 1) % 3 === 1);
        return ring ? rgb('#5a5a5a') : DARK;
      }
      if (front) return rgb('#8a8680');
      return (a + b * 5) % 23 === 0 ? rgb('#d0ccc2') : rgb('#c8c4bc');
    }
    case 'fridge': case 'washer': {
      if (k === 'washer') { const r = Math.min(L, D) / 2 - 1.5, dx = a - (L - 1) / 2, dy = b - (D - 1) / 2; if (dx * dx + dy * dy < r * r) return dx * dx + dy * dy < (r - 1.2) * (r - 1.2) ? rgb('#4a5a66') : GREY; }
      if (edge) return rgb('#a8aaa8');
      if (k === 'fridge' && b === D - 2 && a > 1 && a < 4) return GREY;
      return rgb('#dcdfdf');
    }
    case 'wardrobe': case 'cabinet': {
      if (edge) return mul(WOOD_D, 0.85);
      if (a === Math.floor(L / 2)) return WOOD_D;
      if (b === D - 2 && (a === Math.floor(L / 2) - 2 || a === Math.floor(L / 2) + 2)) return rgb('#c8b080');
      if (k === 'cabinet' && b % 3 === 0) return mul(WOOD_M, 0.85);
      return WOOD_M;
    }
    case 'bookshelf': case 'shelf': case 'gondola': {
      const frame = k === 'bookshelf' ? WOOD_D : rgb('#7a7c80');
      if (a === 0 || right || b === 0 || front) return frame;
      if (k === 'gondola' && Math.abs(b - (D - 1) / 2) < 0.6) return frame;
      if (k === 'bookshelf') { if (a % 6 === 0) return frame; return BOOKS[h(a, 0) % BOOKS.length]; }
      // goods in rows; the picked-over gaps show the shelf
      const slot = h(a >> 1, b >> 1);
      if (slot < 60) return rgb('#4a4c50');
      const c = GOODS[slot % GOODS.length];
      return (a & 1) ? mul(c, 0.85) : c;
    }
    case 'nightstand':
      if (Math.abs(a - (L - 1) / 2) < 1.2 && Math.abs(b - (D - 1) / 2) < 1.2) return rgb('#f0e0a0');
      return edge ? WOOD_D : WOOD_M;
    case 'desk': {
      if (b >= 1 && b <= 2 && a >= L * 0.3 && a < L * 0.7) return DARK;
      if (b === 4 && a >= L * 0.35 && a < L * 0.65) return rgb('#c8c8c4');
      if ((h(a >> 1, b >> 1) & 31) === 0) return WHITE;
      return edge ? mul(rgb('#8a7a62'), 0.8) : rgb('#8a7a62');
    }
    case 'bathtub': case 'shower': case 'sink': {
      if (edge || (k === 'bathtub' && (a === 1 || b === 1 || a === L - 2 || b === D - 2))) return WHITE;
      if (k === 'shower') return (a % 3 === 0 || b % 3 === 0) ? rgb('#d0d4d4') : rgb('#b8c8cc');
      if (k === 'bathtub' && a === 3 && b === Math.floor(D / 2)) return GREY;
      return rgb('#c4d6da');
    }
    case 'toilet': {
      const tank = Math.max(2, Math.round(D * 0.35));
      if (b < tank) return edge ? rgb('#c8c8c4') : WHITE;
      const r = (L - 1) / 2, dx = (a - r) / (r + 0.3), dy = (b - tank - (D - tank - 1) / 2) / ((D - tank) / 2 + 0.3);
      const d = dx * dx + dy * dy;
      if (d > 1) return -1;
      return d < 0.35 ? rgb('#b8ccd0') : WHITE;
    }
    case 'plant': {
      const r = (L - 1) / 2, dx = a - r, dy = b - r, d = Math.sqrt(dx * dx + dy * dy);
      const lump = r * (0.75 + (h(Math.round(Math.atan2(dy, dx) * 2), 0) & 63) / 256);
      if (d > lump) return d < r * 0.55 ? rgb('#9a5a3a') : -1;
      return d < r * 0.35 ? rgb('#9a5a3a') : (h(a, b) & 1) ? rgb('#4f8a3a') : rgb('#7fae4a');
    }
    case 'counter': {
      if (a < 6 && b >= 1 && b <= 4) return b === 1 ? rgb('#5a6066') : rgb('#7a8088');
      if (b === D - 1) return rgb('#3a3a3e');
      if (L > 14 && b >= 2 && b < D - 2 && a > 7) return (a % 2) ? rgb('#1e1e20') : rgb('#2a2a2c');
      return rgb('#4a4a4e');
    }
    case 'rack': {
      if (a % 10 === 0 || right) return rgb('#d06a2a');
      if (b === 0 || front || Math.abs(b - (D - 1) / 2) < 0.6) return rgb('#3a5a9a');
      const box = h(Math.floor(a / 5), b > D / 2 ? 1 : 0);
      if (box < 50) return rgb('#4a4c50');
      return (a % 5 === 0 || (b % 4 === 0)) ? rgb('#8a6a42') : rgb('#b08a5a');
    }
    case 'pallet': case 'crate':
      if (k === 'pallet') return (b % 3 === 2) ? mul(rgb('#b08a5a'), 0.7) : (h(a >> 2, b) & 3) ? rgb('#b08a5a') : rgb('#c8a070');
      if (edge) return WOOD_D;
      return (a === b || a === L - 1 - b) ? mul(WOOD_M, 0.75) : (b % 3 === 0 ? mul(WOOD_M, 0.9) : WOOD_M);
    case 'machine':
      if (edge) return ((a + b) >> 1) & 1 ? rgb('#e0b030') : DARK;
      if (a > L * 0.6 && b > 1 && b < 5) return rgb('#3a4a3a');
      return (a + b) % 7 === 0 ? rgb('#5a6068') : rgb('#6a7078');
    case 'hay':
      if (edge) return rgb('#a08a40');
      if (a === Math.floor(L / 3) || a === Math.floor((2 * L) / 3)) return rgb('#8a7038');
      return (b + (h(a, 0) & 1)) % 2 ? rgb('#c8b060') : rgb('#d8c070');
    case 'workbench':
      if (edge) return WOOD_D;
      if ((h(a >> 1, b >> 1) & 15) === 0) return GREY;
      return b < 2 ? rgb('#6a6a6a') : WOOD_M;
    case 'drum': {
      const r = (L - 1) / 2, dx = a - r, dy = b - r, d = dx * dx + dy * dy;
      if (d > r * r + 0.5) return -1;
      const c = v & 1 ? rgb('#2a4a7a') : rgb('#8a2a2a');
      if (d > (r - 1) * (r - 1)) return mul(c, 1.3);
      return d < 1.2 ? DARK : c;
    }
    case 'pew':
      if (b <= 1) return WOOD_D;
      return edge ? mul(WOOD_M, 0.8) : WOOD_M;
    case 'altar':
      if (b === 1 && (a === 2 || a === L - 3)) return rgb('#f0d070');
      return edge ? rgb('#c8c0b0') : rgb('#ece6d8');
    case 'stairs':
      if (b === 0 || front) return WOOD_D;
      return (a % 3 === 0) ? WOOD_D : (a % 3 === 1 ? WOOD_L : WOOD_M);
    case 'board':
      return b === 0 ? GREY : WHITE;
    case 'trough':
      if (edge) return GREY;
      return rgb('#5a6a5a');
    case 'car': {
      const c = CARS[v % CARS.length];
      const ra = Math.min(a, L - 1 - a), rb = Math.min(b, D - 1 - b);
      if (ra + rb < 2) return -1;
      if (ra < 1 || rb < 1) return mul(c, 0.7);
      const t = a / L;
      if ((t > 0.22 && t < 0.32) || (t > 0.7 && t < 0.78)) return rb > 1 ? rgb('#2a3440') : mul(c, 0.7);
      return c;
    }
    case 'mat':
      return edge ? rgb('#4a3a2a') : ((a + b) & 1 ? rgb('#6b5a44') : rgb('#5e4e3a'));
  }
  return edge ? WOOD_D : WOOD_M;
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

function floorColor(id: number, carpet: number): number {
  switch (id) {
    case M.FLOOR_TILE: return C.tile;
    case M.FLOOR_CARPET: return carpet;
    case M.FLOOR_CONCRETE: return C.concrete;
    case M.FLOOR_STONE: return C.stone;
    default: return C.wood;
  }
}

/** Paint a building's inside; returns RGBA at ART pixels per texel. */
export function paintInterior(b: BuildingInfo): { w: number; h: number; data: Uint8ClampedArray } {
  const S = ART;
  const W = b.w * S, H = b.h * S;
  const plan = b.plan!, ids = b.ids!;
  const n = W * H;
  const kind = new Uint8Array(n);
  const col = new Int32Array(n);
  const floor = new Uint8Array(n);
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
    kind[i] = foot[i] ? K.FLOOR : K.OUTER;
  }
  for (const r of plan.rooms) {
    const p = r.poly.map((v) => v * S);
    const cx = (p[0] + p[4]) / 2, cy = (p[1] + p[5]) / 2;
    const lx = p[2] - p[0], ly = p[3] - p[1], dx = p[6] - p[0], dy = p[7] - p[1];
    const L = Math.hypot(lx, ly), D = Math.hypot(dx, dy);
    if (L < 1 || D < 1) continue;
    box(W, H, cx, cy, lx / L, ly / L, dx / D, dy / D, L / 2 + 0.5, D / 2 + 0.5, (i) => { if (kind[i] === K.FLOOR) floor[i] = r.floor; });
  }
  // outer walls: a band one texel thick inside the outline
  const band = (ax: number, ay: number, bx: number, by: number, half: number, ext: number, fn: (i: number, a: number, b: number) => void) => {
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
    if (l < 1e-6) return;
    box(W, H, (ax + bx) / 2, (ay + by) / 2, dx / l, dy / l, -dy / l, dx / l, l / 2 + ext, half, fn);
  };
  for (const r of local) {
    for (let k = 0; k + 3 < r.length; k += 2) {
      band(r[k] * S, r[k + 1] * S, r[k + 2] * S, r[k + 3] * S, S * 1.05, S * 0.5, (i) => { if (kind[i]) kind[i] = K.OUTER; });
    }
  }
  // inner walls
  for (let k = 0; k < plan.walls.length; k += 4) {
    band(plan.walls[k] * S, plan.walls[k + 1] * S, plan.walls[k + 2] * S, plan.walls[k + 3] * S, 1.6, S * 0.45, (i) => { if (kind[i] === K.FLOOR) kind[i] = K.WALL; });
  }
  // windows in the outer walls
  for (let k = 0; k < plan.windows.length; k += 6) {
    const w = plan.windows;
    band(w[k] * S, w[k + 1] * S, w[k + 2] * S, w[k + 3] * S, S * 1.1, 0, (i, _a, bb) => {
      if (kind[i] !== K.OUTER || !foot[i]) return;
      kind[i] = K.GLASS;
      // the inner edge is the sill
      col[i] = bb < S * 1.1 - 1.5 ? 1 : 0;
    });
  }
  // doorways: from the plan, plus any the collision raster opened
  for (const d of plan.doors) {
    const hl = (d.w * S) / 2, half = d.front ? S * 1.6 : 2.6;
    box(W, H, d.x * S, d.y * S, d.tx, d.ty, -d.ty, d.tx, hl, half, (i) => {
      if (kind[i] === K.WALL || kind[i] === K.OUTER || kind[i] === K.GLASS) kind[i] = K.SILL;
    });
  }
  for (let i = 0; i < n; i++) if ((kind[i] === K.WALL || kind[i] === K.OUTER) && texel(i) === M.DOORWAY && foot[i]) kind[i] = K.SILL;
  // door frames: wall pixels touching a doorway
  for (let i = 0; i < n; i++) {
    if (kind[i] !== K.WALL && kind[i] !== K.OUTER) continue;
    const x = i % W;
    if ((x > 0 && kind[i - 1] === K.SILL) || (x < W - 1 && kind[i + 1] === K.SILL) || (i >= W && kind[i - W] === K.SILL) || (i < n - W && kind[i + W] === K.SILL)) kind[i] = K.FRAME;
  }

  // ---- colour
  const carpet = CARPETS[b.seed % CARPETS.length];
  const ux = plan.ux, uy = plan.uy;
  for (let i = 0; i < n; i++) {
    const k = kind[i];
    if (!k) continue;
    const x = i % W, y = (i - x) / W;
    const g = hash2(x, y, b.seed) & 255;
    let c: number;
    if (k === K.FLOOR) {
      const f = floor[i];
      c = floorColor(f, carpet);
      // patterns follow the building's axis
      const pu = Math.floor(x * ux + y * uy), pv = Math.floor(-x * uy + y * ux);
      if (f === M.FLOOR_WOOD) {
        const row = pv >> 1;
        const seam = ((pu + row * 7) % 13 + 13) % 13 === 0;
        const tone = hash2(row, Math.floor((pu + row * 7) / 13), 77) & 7;
        c = mul(c, seam ? 0.78 : (pv & 1 ? 0.94 : 1) * (0.94 + tone * 0.02));
      } else if (f === M.FLOOR_TILE) {
        const grout = (pu & 3) === 0 || (pv & 3) === 0;
        c = mul(c, grout ? 0.86 : (((pu >> 2) + (pv >> 2)) & 1 ? 0.97 : 1.02));
      } else if (f === M.FLOOR_CONCRETE) {
        c = mul(c, (pu % 32 === 0 || pv % 32 === 0) ? 0.85 : 0.95 + (g & 15) / 160);
      } else if (f === M.FLOOR_STONE) {
        const row = Math.floor(pv / 6), off = row & 1 ? 4 : 0;
        c = mul(c, (pv % 6 === 0 || (pu + off) % 8 === 0) ? 0.82 : 0.96 + (hash2(Math.floor((pu + off) / 8), row, 5) & 7) / 80);
      } else {
        c = mul(c, 0.95 + (g & 15) / 160);
      }
    } else if (k === K.WALL) {
      const below = y < H - 1 ? kind[i + W] : 0, above = y > 0 ? kind[i - W] : 0;
      c = below !== K.WALL && below !== K.FRAME ? C.wallFace : above !== K.WALL && above !== K.FRAME ? C.wallHi : C.wallTop;
    } else if (k === K.OUTER) {
      const x0 = x > 0 ? kind[i - 1] : 0, x1 = x < W - 1 ? kind[i + 1] : 0, y0 = y > 0 ? kind[i - W] : 0, y1 = y < H - 1 ? kind[i + W] : 0;
      if (!x0 || !x1 || !y0 || !y1) c = C.outerEdge;
      else if (y1 === K.FLOOR) c = mul(C.outer, 0.82);
      else c = (g & 3) === 0 ? mul(C.outer, 0.95) : C.outer;
    } else if (k === K.GLASS) {
      c = col[i] ? rgb('#d8d2c4') : ((x + y) % 5 === 0 ? C.glassHi : C.glass);
    } else if (k === K.SILL) {
      c = mul(C.sill, 0.95 + (g & 7) / 80);
    } else {
      c = C.frame;
    }
    col[i] = c;
  }

  // ---- open doors swung against the wall, and doormats
  for (const d of plan.doors) {
    if (!d.leaf) continue;
    const nx = -d.ty * d.leaf, ny = d.tx * d.leaf;
    const hx = (d.x + d.tx * (d.w / 2)) * S, hy = (d.y + d.ty * (d.w / 2)) * S;
    const len = d.w * S * 0.95;
    box(W, H, hx + nx * len / 2 - d.tx * 1, hy + ny * len / 2 - d.ty * 1, nx, ny, d.tx, d.ty, len / 2, 1, (i, a, bb) => {
      if (kind[i] !== K.FLOOR) return;
      kind[i] = K.LEAF;
      col[i] = bb < 1 || a > len - 1 ? C.leafEdge : C.leaf;
    });
  }
  const front = plan.doors.find((d) => d.front);
  const items: PlanItem[] = [...plan.items];
  if (front) {
    const nx = -front.ty, ny = front.tx;
    // inward normal: towards the inside spot
    const ix = b.door.nx, iy = b.door.ny;
    const s = nx * -ix + ny * -iy > 0 ? 1 : -1;
    items.unshift({ k: 'mat', x: front.x + nx * s * 1.6, y: front.y + ny * s * 1.6, ax: front.tx, ay: front.ty, bx: nx * s, by: ny * s, l: 2.2, d: 1.3, v: 0, solid: false });
  }

  // ---- furniture: flat pieces first
  items.sort((p, q) => (p.k === 'rug' || p.k === 'mat' ? 0 : 1) - (q.k === 'rug' || q.k === 'mat' ? 0 : 1));
  for (const it of items) {
    const L = Math.max(2, Math.round(it.l * S)), D = Math.max(2, Math.round(it.d * S));
    box(W, H, it.x * S, it.y * S, it.ax, it.ay, it.bx, it.by, L / 2, D / 2, (i, a, bb) => {
      if (kind[i] !== K.FLOOR && kind[i] !== K.THING && kind[i] !== K.LEAF) return;
      const c = furniture(it.k, Math.min(L - 1, Math.floor(a)), Math.min(D - 1, Math.floor(bb)), L, D, it.v);
      if (c < 0) return;
      col[i] = c;
      kind[i] = it.solid || it.k === 'chair' ? K.THING : K.FLOOR;
    });
  }

  // ---- soft shadows to the south-east of walls and furniture
  for (let i = n - 1; i >= W + 1; i--) {
    if (kind[i] !== K.FLOOR && kind[i] !== K.LEAF) continue;
    const a = kind[i - W - 1], up = kind[i - W];
    if (a === K.WALL || a === K.THING || a === K.FRAME || a === K.OUTER || up === K.THING) col[i] = mul(col[i], 0.8);
  }

  // ---- wear: stains and litter; burnt-out shells
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const k = kind[i];
    if (!k) continue;
    let c = col[i];
    const x = i % W, y = (i - x) / W;
    if (b.burnt) {
      const soot = (hash2(x >> 3, y >> 3, b.seed) & 255) / 255;
      c = mul(c, 0.25 + soot * 0.25);
      if ((hash2(x, y, 9) & 255) < 6) c = rgb('#6b625a');
    } else if (k === K.FLOOR) {
      const blot = hash2(x >> 4, y >> 4, b.seed ^ 0x77) & 1023;
      if (blot < 6 && (hash2(x >> 1, y >> 1, 3) & 3) !== 0) c = rgb('#5a1c18');
      else if ((hash2(x, y, b.seed) & 1023) < 3) c = rgb('#d8d4c8');
    }
    const o = i * 4;
    out[o] = R8(c); out[o + 1] = G8(c); out[o + 2] = B8(c); out[o + 3] = 255;
  }
  return { w: W, h: H, data: out };
}
