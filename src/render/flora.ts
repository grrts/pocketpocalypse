// Procedural arcade-style trees, bushes, hedges and ferns, drawn on the art grid
// (1 art px = 1/4 texel, about 0.09 m) and cached as canvases. Clean cel
// shading (a highlight, light, base and shadow tone per species), lit from the
// north-west, with a 1-art-px deep blue-black outline around everything that
// stands up (docs/ART_STYLE.md section 0 and 7).

import { hash2 } from '../core/rng';
import { VK } from '../world/vegetation';

export type FloraSprite = HTMLCanvasElement & { ax: number; ay: number };

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const OUTLINE = hex('#1b1a2e');

/** Cel tones: highlight, light, base, shadow. */
interface Tones { hl: RGB; l: RGB; m: RGB; d: RGB }
const tones = (hl: string, l: string, m: string, d: string): Tones => ({ hl: hex(hl), l: hex(l), m: hex(m), d: hex(d) });

const FOLIAGE: Record<number, Tones> = {
  [VK.LIME]: tones('#b6e264', '#86c84a', '#55a23c', '#2f7437'),
  [VK.PLANE]: tones('#d4ec7c', '#a8d457', '#76b041', '#4a8638'),
  [VK.OAK]: tones('#9ed65a', '#6cb646', '#418c38', '#265f34'),
  [VK.BIRCH]: tones('#dcf08a', '#b2dc5e', '#80bc46', '#52903c'), // drawn as a tall poplar
  [VK.PINE]: tones('#7cc48e', '#4f9e72', '#2f7a5c', '#1d5548'),
  [VK.SPRUCE]: tones('#68b088', '#3f8c68', '#266a52', '#18493e'),
  [VK.WILLOW]: tones('#e2f09a', '#c2dc6c', '#92bc4e', '#5f903c'),
  [VK.FRUIT]: tones('#c2e46c', '#92cc50', '#5ea63e', '#347838'),
  [VK.BUSH]: tones('#aedc66', '#7ec24c', '#4f9a3c', '#2c6c34'),
  [VK.HEDGE]: tones('#9cd060', '#72b448', '#4c923a', '#2c6634'),
  [VK.FERN]: tones('#b4dc6a', '#88c050', '#5c9a3c', '#3a722e'),
};
const BLOSSOM = tones('#fff2f6', '#ffc6d8', '#f191b4', '#c45c8c');
const AUTUMN = [tones('#ffe07a', '#ffb244', '#e8782e', '#b04a2c'), tones('#ffc870', '#f08a3a', '#cc532e', '#8e312c')];

interface Bark { l: RGB; m: RGB; d: RGB }
const BARK: Record<number | string, Bark> = {
  default: { l: hex('#a8774a'), m: hex('#7f5434'), d: hex('#573824') },
  [VK.BIRCH]: { l: hex('#f2eee2'), m: hex('#d4cdbd'), d: hex('#8e8678') },
  [VK.PINE]: { l: hex('#cc7c48'), m: hex('#a35a34'), d: hex('#6e3a26') },
  [VK.PLANE]: { l: hex('#c8b98c'), m: hex('#9e8e66'), d: hex('#6a5e44') },
  [VK.DEAD]: { l: hex('#8e8070'), m: hex('#6a5e52'), d: hex('#463e36') },
};
const bark = (k: number) => BARK[k] ?? BARK.default;

// Light from the north-west, above (screen y grows south).
const LX = -0.5, LY = -0.62, LZ = 0.6;

function make(w: number, h: number, ax: number, ay: number, fill: (img: ImageData) => void): FloraSprite {
  const c = document.createElement('canvas') as FloraSprite;
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  c.ax = ax;
  c.ay = ay;
  const g = c.getContext('2d')!;
  const img = g.createImageData(c.width, c.height);
  fill(img);
  g.putImageData(img, 0, 0);
  return c;
}

function put(img: ImageData, x: number, y: number, c: RGB, a = 255) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = a;
}

const filled = (img: ImageData, x: number, y: number) => x >= 0 && y >= 0 && x < img.width && y < img.height && img.data[(y * img.width + x) * 4 + 3] > 0;

/** Wrap every opaque shape in a 1-px outline (on transparent pixels next to it). */
function outline(img: ImageData, c: RGB = OUTLINE) {
  const W = img.width, H = img.height, d = img.data;
  const mark = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3]) continue;
    if (filled(img, x - 1, y) || filled(img, x + 1, y) || filled(img, x, y - 1) || filled(img, x, y + 1)) mark[y * W + x] = 1;
  }
  for (let i = 0; i < mark.length; i++) if (mark[i]) put(img, i % W, (i / W) | 0, c);
}

const tinted = (c: RGB, t: RGB): RGB => [Math.min(255, c[0] * t[0]), Math.min(255, c[1] * t[1]), Math.min(255, c[2] * t[2])];
const tintTones = (p: Tones, t: RGB): Tones => ({ hl: tinted(p.hl, t), l: tinted(p.l, t), m: tinted(p.m, t), d: tinted(p.d, t) });
// per-tree hue shift (about ±5%)
const TINTS: RGB[] = [[1.04, 1.02, 0.92], [1, 1, 1], [0.95, 0.99, 1.06], [1.03, 0.97, 0.96]];

class Rand {
  constructor(private s: number) {}
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
}

/** A puff: a sphere of radius r at (x, y) whose top sits at height z + r. */
interface Puff { x: number; y: number; r: number; z: number }

/**
 * Cel-shade a pile of puffs: each pixel takes the highest puff above it and is
 * lit by that sphere's normal, then snapped to four tones. The south-east side
 * of each puff falls into shadow, so the crown reads as round clumps.
 */
function celPuffs(img: ImageData, cx: number, cy: number, puffs: Puff[], pal: Tones, opts: {
  seed: number; dots?: RGB[]; dotRate?: number; bias?: number; spikes?: number;
}) {
  const W = img.width, H = img.height;
  const bias = opts.bias ?? 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5 - cx, py = y + 0.5 - cy;
      let best = -1, bz = -1e9, nx = 0, ny = 0, nz = 1;
      for (let k = 0; k < puffs.length; k++) {
        const b = puffs[k];
        const dx = px - b.x, dy = py - b.y;
        let r = b.r;
        if (opts.spikes) {
          // needle tufts: a saw-tooth rim
          const t = ((Math.atan2(dy, dx) / (Math.PI * 2)) * opts.spikes + k * 0.37) % 1;
          r *= 0.8 + 0.2 * Math.abs(t < 0 ? t + 0.5 : t - 0.5) * 2;
        }
        const q = 1 - (dx * dx + dy * dy) / (r * r);
        if (q <= 0) continue;
        const s = Math.sqrt(q);
        const z = b.z + s * r;
        if (z > bz) { bz = z; best = k; nx = dx / r; ny = dy / r; nz = s; }
      }
      if (best < 0) continue;
      const lit = nx * LX + ny * LY + nz * LZ + bias;
      let c: RGB = lit > 0.86 ? pal.hl : lit > 0.6 ? pal.l : lit > 0.22 ? pal.m : pal.d;
      if (opts.dots && lit > 0.3) {
        const g = hash2(x >> 1, y >> 1, opts.seed + 11) & 1023;
        if (g < 1024 * (opts.dotRate ?? 0.05)) c = opts.dots[(g >> 2) % opts.dots.length];
      }
      put(img, x, y, c);
    }
  }
}

function thick(img: ImageData, x0: number, y0: number, x1: number, y1: number, w: number, c: RGB) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1) * 2;
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
    for (let a = 0; a < w; a++) for (let b = 0; b < w; b++) put(img, x + a - (w >> 1), y + b - (w >> 1), c);
  }
}

/** Foliage palette of one tree: species, blossom or autumn picks, per-tree tint. */
function treeTones(kind: number, variant: number): { pal: Tones; dots?: RGB[] } {
  const tint = TINTS[(variant >> 2) & 3];
  const pick = (variant >> 4) & 15;
  if (kind === VK.FRUIT) {
    if (pick < 7) return { pal: tintTones(BLOSSOM, tint), dots: [hex('#ffffff'), hex('#ff8cb4')] };
    return { pal: tintTones(FOLIAGE[VK.FRUIT], tint), dots: pick & 1 ? [hex('#e8322e'), hex('#ffcc3a')] : [hex('#e8322e'), hex('#b8202a')] };
  }
  // one in six broadleaves is already turning
  if ((kind === VK.LIME || kind === VK.OAK || kind === VK.PLANE) && pick < 3) return { pal: tintTones(AUTUMN[pick & 1], tint) };
  if (kind === VK.WILLOW && pick < 2) return { pal: tintTones(AUTUMN[0], tint) };
  return { pal: tintTones(FOLIAGE[kind] ?? FOLIAGE[VK.LIME], tint) };
}

/** Canopy of radius r art px, anchored at its centre. */
function canopy(kind: number, r: number, variant: number): FloraSprite {
  const pad = 3;
  const tall = kind === VK.BIRCH;
  const W = Math.ceil(r * (tall ? 1.5 : 2.2)) + pad * 2;
  const up = tall ? r * 1.7 : r * 1.1, down = r * 1.05;
  const H = Math.ceil(up + down) + pad * 2;
  const cx = W / 2, cy = pad + up;
  const seed = hash2(kind * 31 + (variant & 3), r, 0x7ee);
  const rnd = new Rand(seed);
  const { pal, dots } = treeTones(kind, variant);
  return make(W, H, cx, cy, (img) => {
    if (kind === VK.DEAD) {
      const b = bark(VK.DEAD);
      const nb = 5 + Math.floor(rnd.next() * 3);
      const segs: [number, number, number, number, number][] = [];
      const branch = (x: number, y: number, a: number, len: number, depth: number) => {
        const x1 = x + Math.cos(a) * len, y1 = y + Math.sin(a) * len;
        segs.push([x, y, x1, y1, depth]);
        if (depth < 2) {
          branch(x1, y1, a + rnd.range(0.3, 0.6), len * 0.6, depth + 1);
          branch(x1, y1, a - rnd.range(0.3, 0.6), len * 0.6, depth + 1);
        }
      };
      for (let i = 0; i < nb; i++) branch(cx, cy, (i / nb) * Math.PI * 2 + rnd.range(0, 0.6), r * rnd.range(0.4, 0.55), 0);
      for (const [x0, y0, x1, y1, d] of segs) thick(img, x0, y0, x1, y1, d === 0 ? 2 : 1, d === 0 ? b.m : b.l);
      outline(img);
      return;
    }
    if (kind === VK.SPRUCE) {
      // a dark star seen from above: tiers of spiky branches round a tip
      const spikes = 9 + Math.floor(rnd.next() * 3);
      const rot = rnd.range(0, Math.PI);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const d = Math.hypot(dx, dy);
        const a = Math.atan2(dy, dx) + rot;
        const tri = Math.abs((((a * spikes) / (Math.PI * 2)) % 1 + 1) % 1 - 0.5) * 2;
        const R = r * (0.72 + 0.28 * tri);
        if (d >= R) continue;
        const f = d / R;
        // tiers: each ring is lit on its north-west side
        const ring = (d / r) * 3.2 - tri * 0.4;
        const inRing = ring - Math.floor(ring);
        const side = d > 0 ? -(dx * LX + dy * LY) / d : 1;
        let lit = side * 0.5 + 0.35 - inRing * 0.35 + (1 - f) * 0.3;
        if (d < r * 0.12) lit = 0.9;
        put(img, x, y, lit > 0.82 ? pal.hl : lit > 0.5 ? pal.l : lit > 0.18 ? pal.m : pal.d);
      }
      outline(img);
      return;
    }
    const puffs: Puff[] = [];
    if (kind === VK.PINE) {
      // Scots pine: a few separate flat clumps on bare branches
      const n = 4 + Math.floor(rnd.next() * 3);
      puffs.push({ x: 0, y: -r * 0.05, r: r * 0.42, z: r * 0.25 });
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd.range(-0.3, 0.3), d = r * rnd.range(0.48, 0.62);
        puffs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: r * rnd.range(0.32, 0.4), z: 0 });
      }
    } else if (tall) {
      // poplar: a tall narrow plume
      const n = 5;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const yy = down * 0.55 - t * (up + down * 0.45);
        const rr = r * (0.58 - Math.abs(t - 0.35) * 0.32) * rnd.range(0.95, 1.05);
        puffs.push({ x: rnd.range(-0.08, 0.08) * r, y: yy, r: rr, z: r * 0.4 * (1 - Math.abs(t - 0.4)) });
        puffs.push({ x: (i & 1 ? 1 : -1) * rr * 0.55, y: yy - rr * 0.2, r: rr * 0.6, z: r * 0.35 });
      }
    } else {
      const body = kind === VK.WILLOW ? 0.78 : 0.62;
      puffs.push({ x: 0, y: 0, r: r * body, z: 0 });
      const lobes = kind === VK.OAK ? 7 : kind === VK.PLANE ? 6 : kind === VK.WILLOW ? 8 : 5 + (variant & 1);
      for (let i = 0; i < lobes; i++) {
        const a = (i / lobes) * Math.PI * 2 + rnd.range(-0.25, 0.25), d = r * rnd.range(0.52, 0.62);
        puffs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: (r - d) * rnd.range(0.95, 1.05), z: r * 0.05 });
      }
      // a ring of puffs on top makes it read as a pile of round clumps
      const top = kind === VK.WILLOW ? 3 : 4;
      for (let i = 0; i < top; i++) {
        const a = (i / top) * Math.PI * 2 + rnd.range(0, 1), d = r * rnd.range(0.22, 0.36);
        puffs.push({ x: Math.cos(a) * d - r * 0.06, y: Math.sin(a) * d - r * 0.08, r: r * rnd.range(0.34, 0.4), z: r * 0.32 });
      }
      puffs.push({ x: -r * 0.12, y: -r * 0.16, r: r * 0.3, z: r * 0.5 });
    }
    celPuffs(img, cx, cy, puffs, pal, { seed, dots, dotRate: kind === VK.FRUIT ? 0.07 : 0, spikes: kind === VK.PINE ? 11 : 0 });
    if (kind === VK.WILLOW) {
      // drooping strands: short dark streaks hanging from the crown's lower half
      for (let i = 0; i < r * 1.2; i++) {
        const a = rnd.range(0.2, Math.PI - 0.2), d = r * rnd.range(0.35, 0.8);
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.7;
        for (let k = 0; k < 3; k++) if (filled(img, Math.floor(x), Math.floor(y + k))) put(img, x, y + k, pal.m);
      }
    }
    outline(img);
  });
}

/**
 * Trunk of visible height `vis` art px, anchored at its foot. It continues a
 * little way up into the crown.
 */
function trunk(kind: number, vis: number, tr: number, r: number): FloraSprite {
  const w = Math.max(3, Math.min(6, tr * 2));
  const up = Math.round(r * (kind === VK.PINE ? 0.5 : 0.3));
  const H = vis + up + 3;
  const W = w + 8;
  const b = bark(kind);
  const seed = hash2(kind, vis * 64 + tr, r);
  return make(W, H, W / 2, H - 2, (img) => {
    const x0 = 4;
    for (let y = 1; y < H - 1; y++) {
      const flare = y >= H - 3 ? 1 : 0; // root flare
      const xa = x0 - flare, xb = x0 + w - 1 + flare;
      for (let x = xa; x <= xb; x++) {
        let c = x <= xa ? b.l : x >= xb - (w > 4 ? 1 : 0) ? b.d : b.m;
        if (kind === VK.BIRCH && x > xa && x < xb && (hash2(x, y >> 1, seed) & 7) === 0) c = hex('#2e2a30');
        put(img, x, y, c);
      }
    }
    if (kind === VK.PINE) {
      // bare branches out to the clumps
      const cx = x0 + w / 2;
      thick(img, cx, up * 0.6, cx - r * 0.4, up * 0.15, 1, b.d);
      thick(img, cx, up * 0.7, cx + r * 0.42, up * 0.3, 1, b.d);
    }
    outline(img);
  });
}

/** Low round bush with a darker south face (the 3/4 cheat), anchored at its base centre. */
function bush(r: number, variant: number): FloraSprite {
  const fh = Math.max(2, Math.round(r * 0.45));
  const S = Math.ceil(r * 2.2) + 6;
  const H = S + fh;
  const c = S / 2;
  const seed = hash2(r, variant, 0xb05);
  const rnd = new Rand(seed);
  const t = TINTS[variant % TINTS.length];
  const pal = tintTones(FOLIAGE[VK.BUSH], t);
  const flowers = [[hex('#ffe04a'), hex('#fff6b0')], [hex('#ff5a5a'), hex('#ffb0a0')], [hex('#ffffff'), hex('#ffe0ec')], [hex('#b88cff'), hex('#e0ccff')], [hex('#e0222e'), hex('#ff6a5a')]];
  const kindOfAccent = (variant >> 2) % 8;
  const accents = kindOfAccent < flowers.length ? flowers[kindOfAccent] : undefined;
  return make(S, H, c, c + fh * 0.5, (img) => {
    const puffs: Puff[] = [{ x: 0, y: 0, r: r * 0.7, z: 0 }];
    const n = 4 + Math.floor(rnd.next() * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd.range(-0.4, 0.4), d = r * rnd.range(0.35, 0.45);
      puffs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: (r - d) * rnd.range(0.9, 1), z: 0 });
    }
    puffs.push({ x: -r * 0.15, y: -r * 0.15, r: r * 0.42, z: r * 0.3 });
    // south face: the footprint swept down by fh, in the shadow tone
    for (let y = 0; y < H; y++) for (let x = 0; x < S; x++) {
      for (let k = 1; k <= fh; k++) {
        const px = x + 0.5 - c, py = y + 0.5 - c - k;
        if (puffs.some((b) => (px - b.x) ** 2 + (py - b.y) ** 2 < b.r * b.r)) {
          put(img, x, y, pal.d);
          break;
        }
      }
    }
    celPuffs(img, c, c, puffs, pal, { seed });
    if (accents) {
      // flowers or berries in little clusters
      const nf = Math.max(3, Math.round(r * 0.6));
      for (let i = 0; i < nf; i++) {
        const a = rnd.range(0, Math.PI * 2), d = rnd.range(0.1, 0.75) * r;
        const x = Math.floor(c + Math.cos(a) * d), y = Math.floor(c + Math.sin(a) * d);
        if (!filled(img, x, y)) continue;
        put(img, x, y, accents[0]);
        if (r > 6 && filled(img, x + 1, y)) put(img, x + 1, y, accents[0]);
        if (r > 6) put(img, x, y - 1, accents[1]);
      }
    }
    outline(img);
  });
}

/** A fern: fronds radiating from the centre, anchored at the centre. */
function fern(r: number, variant: number): FloraSprite {
  const S = Math.ceil(r * 2) + 5;
  const c = S / 2;
  const rnd = new Rand(hash2(r, variant, 0xfe2));
  const pal = FOLIAGE[VK.FERN];
  return make(S, S, c, c, (img) => {
    const n = 6 + Math.floor(rnd.next() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd.range(-0.25, 0.25);
      const len = r * rnd.range(0.7, 1);
      const steps = Math.ceil(len);
      const lit = Math.cos(a) * LX + Math.sin(a) * LY > 0;
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        const bend = f * f * 0.35;
        const x = c + Math.cos(a + bend) * len * f, y = c + Math.sin(a + bend) * len * f;
        put(img, x, y, lit ? pal.l : pal.m);
        if (f > 0.15 && f < 0.85) {
          const nx = -Math.sin(a), ny = Math.cos(a);
          put(img, x + nx, y + ny, lit ? pal.hl : pal.l);
          put(img, x - nx, y - ny, pal.m);
        }
      }
    }
    outline(img);
  });
}

function segDist(px: number, py: number, dx: number, dy: number): number {
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / l2)) : 0;
  return Math.hypot(px - dx * t, py - dy * t);
}

/** Trimmed hedge from (0,0) to (dx,dy): a clean box with a flat lit top and a darker south face. Anchored at (0,0). */
function hedge(dx: number, dy: number, hd: number, variant: number, _wild: number): FloraSprite {
  const fh = Math.max(4, Math.round(hd * 1.5));
  const minx = Math.floor(Math.min(0, dx) - hd - 3), maxx = Math.ceil(Math.max(0, dx) + hd + 3);
  const miny = Math.floor(Math.min(0, dy) - hd - fh - 3), maxy = Math.ceil(Math.max(0, dy) + hd + 3);
  const W = maxx - minx, H = maxy - miny;
  const seed = hash2(dx * 7 + dy, variant, 0x4ed);
  const pal = tintTones(FOLIAGE[VK.HEDGE], TINTS[variant % TINTS.length]);
  return make(W, H, -minx, -miny, (img) => {
    const inside = (x: number, y: number) => segDist(x, y, dx, dy) < hd;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const wx = x + minx + 0.5, wy = y + miny + 0.5;
        if (inside(wx, wy + fh)) {
          // top: lit north-west rim, leafy clumps in two tones
          let c = pal.l;
          if (!inside(wx, wy + fh - 1.5) || !inside(wx - 1.5, wy + fh)) c = pal.hl;
          else if (!inside(wx + 1, wy + fh + 1)) c = pal.m;
          else {
            const g = hash2((wx / 3) | 0, (wy / 2) | 0, seed) & 7;
            if (g === 0 && ((wx | 0) + (wy | 0)) % 3 === 0) c = pal.m;
          }
          put(img, x, y, c);
          continue;
        }
        for (let k = 0; k < fh; k++) {
          if (inside(wx, wy + k)) {
            // south face, with a band of leaf texture under the top edge
            const g = hash2(x >> 1, y, seed + 4) & 7;
            put(img, x, y, k > fh - 2 && g < 4 ? pal.m : pal.d);
            break;
          }
        }
      }
    }
    outline(img);
  });
}

/** Lazily built, size-bounded cache of every flora sprite. */
export class FloraBank {
  private cache = new Map<string, FloraSprite>();
  limit = 900;

  private get(key: string, build: () => FloraSprite): FloraSprite {
    let s = this.cache.get(key);
    if (s) {
      // keep recently used entries at the back
      this.cache.delete(key);
      this.cache.set(key, s);
      return s;
    }
    s = build();
    this.cache.set(key, s);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    return s;
  }

  canopy(kind: number, r: number, variant: number): FloraSprite {
    // shape (2 bits), tint (2 bits) and a species pick (blossom / autumn, 4 bits)
    let v = variant & 15;
    const pick = (variant >> 4) & 15;
    if (kind === VK.FRUIT) v |= (pick < 7 ? 0 : 7 + (pick & 1)) << 4;
    else if (kind === VK.LIME || kind === VK.OAK || kind === VK.PLANE || kind === VK.WILLOW) v |= (pick < 3 ? pick : 15) << 4;
    else v |= 15 << 4;
    return this.get(`c${kind},${r},${v}`, () => canopy(kind, r, v));
  }

  trunk(kind: number, vis: number, tr: number, r: number): FloraSprite {
    const rb = r & ~7;
    return this.get(`t${kind},${vis},${tr},${rb}`, () => trunk(kind, vis, tr, rb));
  }

  bush(r: number, variant: number): FloraSprite {
    return this.get(`b${r},${variant & 31}`, () => bush(r, variant & 31));
  }

  fern(r: number, variant: number): FloraSprite {
    return this.get(`f${r},${variant & 3}`, () => fern(r, variant & 3));
  }

  hedge(dx: number, dy: number, hd: number, variant: number, wild: number): FloraSprite {
    return this.get(`h${dx},${dy},${hd},${variant & 3}`, () => hedge(dx, dy, hd, variant & 3, wild));
  }
}
