// Procedural pixel-art trees, bushes, hedges and ferns, drawn on the art grid
// (1 art px = 1/4 texel, about 0.09 m) and cached as canvases. Lit from the
// north-west with three foliage tones per species and no outlines
// (docs/ART_STYLE.md sections 4, 5 and 7).

import { hash2, valueNoise } from '../core/rng';
import { VK } from '../world/vegetation';

export type FloraSprite = HTMLCanvasElement & { ax: number; ay: number };

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

interface Foliage { l: RGB; m: RGB; d: RGB; deep: RGB }
const fol = (l: string, m: string, d: string, deep: string): Foliage => ({ l: hex(l), m: hex(m), d: hex(d), deep: hex(deep) });

const FOLIAGE: Record<number, Foliage> = {
  [VK.LIME]: fol('#7fae4a', '#4f8a3a', '#2e5a2c', '#22432a'),
  [VK.PLANE]: fol('#94b955', '#62933f', '#3a6830', '#2a4c28'),
  [VK.OAK]: fol('#73a145', '#467d38', '#29542b', '#1e3f24'),
  [VK.BIRCH]: fol('#a6c862', '#79a547', '#4f7d36', '#3a5e2c'),
  [VK.PINE]: fol('#4f7f50', '#2f5a3e', '#1f4030', '#173226'),
  [VK.SPRUCE]: fol('#467a58', '#2b5442', '#1b3a30', '#142c25'),
  [VK.WILLOW]: fol('#b1c27a', '#86a35a', '#5b7a3e', '#45602f'),
  [VK.FRUIT]: fol('#8cb850', '#5a9240', '#36632e', '#284a26'),
  [VK.BUSH]: fol('#7aa846', '#4c8338', '#2d572b', '#22432a'),
  [VK.HEDGE]: fol('#6a9a40', '#437a34', '#2a5229', '#1e3f22'),
  [VK.FERN]: fol('#8cb54c', '#5f913c', '#3f6a2c', '#2e5222'),
};

interface Bark { l: RGB; m: RGB; d: RGB; mark: RGB }
const BARK: Record<number | string, Bark> = {
  default: { l: hex('#7d5a3a'), m: hex('#6b4a2f'), d: hex('#433021'), mark: hex('#3a291c') },
  [VK.BIRCH]: { l: hex('#e8e3d6'), m: hex('#cfc9ba'), d: hex('#a39d90'), mark: hex('#3a3430') },
  [VK.PINE]: { l: hex('#a8683e'), m: hex('#8a5232'), d: hex('#5a3624'), mark: hex('#4a2c1e') },
  [VK.PLANE]: { l: hex('#a59a78'), m: hex('#857a5c'), d: hex('#5e553f'), mark: hex('#bdb48e') },
  [VK.DEAD]: { l: hex('#7a6e60'), m: hex('#5f5548'), d: hex('#433b32'), mark: hex('#2f2a24') },
};
const bark = (k: number) => BARK[k] ?? BARK.default;

// Light from the north-west, above (screen y grows south).
const LX = -0.55, LY = -0.62, LZ = 0.56;

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
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = a;
}

const tinted = (c: RGB, t: RGB): RGB => [Math.min(255, c[0] * t[0]), Math.min(255, c[1] * t[1]), Math.min(255, c[2] * t[2])];
// per-tree hue shift (about ±5%)
const TINTS: RGB[] = [[1.05, 1.02, 0.92], [1, 1, 1], [0.94, 0.99, 1.06], [1.02, 0.97, 0.95]];

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

interface Blob { x: number; y: number; r: number; h: number }

/** Height field of overlapping spherical caps, and its lit, three-tone rendering. */
function shadeBlobs(img: ImageData, cx: number, cy: number, blobs: Blob[], pal: Foliage, opts: {
  seed: number; holes?: number; streaks?: boolean; accents?: RGB[]; accentRate?: number; leaf?: number; edge?: number;
}) {
  const W = img.width, H = img.height;
  const hf = new Float32Array(W * H);
  let hmax = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5 - cx, py = y + 0.5 - cy;
      let best = 0;
      for (const b of blobs) {
        const dx = px - b.x, dy = py - b.y;
        const q = 1 - (dx * dx + dy * dy) / (b.r * b.r);
        if (q <= 0) continue;
        const v = Math.sqrt(q) * b.r * b.h;
        if (v > best) best = v;
      }
      // ragged edge
      const e = (hash2(x, y, opts.seed) & 1023) / 1023;
      if (best > 0 && best < (opts.edge ?? 1.3) * e) best = 0;
      hf[y * W + x] = best;
      if (best > hmax) hmax = best;
    }
  }
  const leafS = opts.leaf ?? 2.6;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const h = hf[i];
      if (h <= 0) continue;
      const hl = x > 0 ? hf[i - 1] : 0, hr = x < W - 1 ? hf[i + 1] : 0;
      const hu = y > 0 ? hf[i - W] : 0, hd = y < H - 1 ? hf[i + W] : 0;
      let nx = -(hr - hl) / 2, ny = -(hd - hu) / 2, nz = 1;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl; ny /= nl; nz /= nl;
      const lit = nx * LX + ny * LY + nz * LZ;
      const leaf = valueNoise(x / leafS, y / leafS, opts.seed + 5);
      let v = lit * 0.75 + (h / hmax) * 0.4 + (leaf - 0.5) * 0.3;
      if (opts.streaks) {
        const a = Math.atan2(y + 0.5 - cy, x + 0.5 - cx);
        v += (valueNoise(a * 9, Math.hypot(x - cx, y - cy) / 7, opts.seed + 9) - 0.5) * 0.35;
      }
      const g = (hash2(x, y, opts.seed + 3) & 255) / 255;
      v += (g - 0.5) * 0.06;
      if (opts.holes && leaf < opts.holes && h < hmax * 0.92) continue; // see-through gaps
      let c: RGB;
      if (v > 0.86) c = pal.l;
      else if (v > 0.6) c = pal.m;
      else if (v > 0.3) c = pal.d;
      else c = pal.deep;
      if (opts.accents && g > 1 - (opts.accentRate ?? 0.04) && v > 0.5) c = opts.accents[(hash2(x, y, opts.seed + 11) >>> 3) % opts.accents.length];
      put(img, x, y, c);
    }
  }
}

function line(img: ImageData, x0: number, y0: number, x1: number, y1: number, c: RGB) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) put(img, Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c);
}

/** Canopy of radius r art px, anchored at its centre. */
function canopy(kind: number, r: number, shape: number, tint: number): FloraSprite {
  const pad = 2;
  const S = Math.ceil(r * 2.15) + pad * 2;
  const c = S / 2;
  const seed = hash2(kind * 31 + shape, r, 0x7ee);
  const rnd = new Rand(seed);
  const pal0 = FOLIAGE[kind] ?? FOLIAGE[VK.LIME];
  const t = TINTS[tint % TINTS.length];
  const pal: Foliage = { l: tinted(pal0.l, t), m: tinted(pal0.m, t), d: tinted(pal0.d, t), deep: tinted(pal0.deep, t) };
  return make(S, S, c, c, (img) => {
    if (kind === VK.DEAD) {
      const b = bark(VK.DEAD);
      const nb = 5 + Math.floor(rnd.next() * 3);
      const branch = (x: number, y: number, a: number, len: number, depth: number) => {
        const x1 = x + Math.cos(a) * len, y1 = y + Math.sin(a) * len;
        line(img, x, y, x1, y1, depth === 0 ? b.m : depth === 1 ? b.d : b.mark);
        if (depth < 2) {
          branch(x1, y1, a + rnd.range(0.25, 0.6), len * 0.55, depth + 1);
          branch(x1, y1, a - rnd.range(0.25, 0.6), len * 0.55, depth + 1);
        }
      };
      for (let i = 0; i < nb; i++) branch(c, c, (i / nb) * Math.PI * 2 + rnd.range(0, 0.6), r * rnd.range(0.4, 0.55), 0);
      // a few clinging brown leaves
      for (let i = 0; i < r; i++) {
        const a = rnd.range(0, Math.PI * 2), d = rnd.range(0.2, 0.95) * r;
        put(img, Math.round(c + Math.cos(a) * d), Math.round(c + Math.sin(a) * d), hex('#7a5e34'));
      }
      return;
    }
    if (kind === VK.SPRUCE) {
      // pointed star seen from above: a cone with spiky edges and tiers
      const spikes = 14 + Math.floor(rnd.next() * 5);
      const rot = rnd.range(0, Math.PI);
      const W = img.width;
      const hf = new Float32Array(W * W);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const dx = x + 0.5 - c, dy = y + 0.5 - c;
        const d = Math.hypot(dx, dy);
        const a = Math.atan2(dy, dx) + rot;
        const tri = Math.abs(((a * spikes) / (Math.PI * 2)) % 1 - 0.5) * 2;
        const R = r * (0.84 + 0.16 * tri) * (0.92 + 0.12 * valueNoise(a * 3, 0, seed));
        if (d < R) hf[y * W + x] = (1 - d / R) * r * 0.9 + 1;
      }
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, h = hf[i];
        if (!h) continue;
        const nx = -((x < W - 1 ? hf[i + 1] : 0) - (x > 0 ? hf[i - 1] : 0)) / 2;
        const ny = -((y < W - 1 ? hf[i + W] : 0) - (y > 0 ? hf[i - W] : 0)) / 2;
        const nl = Math.hypot(nx, ny, 1);
        const lit = (nx * LX + ny * LY + LZ) / nl;
        const d = Math.hypot(x + 0.5 - c, y + 0.5 - c) / r;
        const tier = ((d * 4.5 + valueNoise(x / 3, y / 3, seed) * 0.6) % 1) > 0.8 ? -0.18 : 0;
        const g = (hash2(x, y, seed) & 255) / 255;
        const v = lit * 0.9 + tier + (g - 0.5) * 0.18 + (1 - d) * 0.15;
        put(img, x, y, v > 0.82 ? pal.l : v > 0.55 ? pal.m : v > 0.3 ? pal.d : pal.deep);
      }
      return;
    }
    const blobs: Blob[] = [];
    if (kind === VK.PINE) {
      // Scots pine: separate dark clumps with gaps between them
      blobs.push({ x: 0, y: 0, r: r * 0.42, h: 1 });
      const n = 6 + Math.floor(rnd.next() * 4);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd.range(-0.3, 0.3), d = r * rnd.range(0.4, 0.62);
        blobs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: r * rnd.range(0.33, 0.42), h: rnd.range(0.8, 1) });
      }
    } else {
      const lobes = kind === VK.OAK ? 5 : kind === VK.BIRCH ? 5 : 3 + Math.floor(rnd.next() * 3);
      const body = kind === VK.WILLOW ? 0.75 : 0.66;
      blobs.push({ x: rnd.range(-0.05, 0.05) * r, y: rnd.range(-0.05, 0.05) * r, r: r * body, h: 1 });
      for (let i = 0; i < lobes; i++) {
        const a = (i / lobes) * Math.PI * 2 + rnd.range(-0.4, 0.4), d = r * rnd.range(0.4, 0.52);
        blobs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: (r - d) * rnd.range(0.92, 1.02), h: rnd.range(0.8, 0.95) });
      }
      // clumps on top make the crown lumpy
      const clumps = 4 + Math.floor(r / 8);
      for (let i = 0; i < clumps; i++) {
        const a = rnd.range(0, Math.PI * 2), d = r * rnd.range(0.1, 0.5);
        blobs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: r * rnd.range(0.24, 0.34), h: 2.2 });
      }
    }
    const accents = kind === VK.FRUIT
      ? (shape & 1 ? [hex('#f0ece0'), hex('#e8b4bc')] : [hex('#c4473a'), hex('#d8a03a')])
      : undefined;
    shadeBlobs(img, c, c, blobs, pal, {
      seed,
      holes: kind === VK.BIRCH ? 0.3 : kind === VK.PINE ? 0.22 : kind === VK.WILLOW ? 0.18 : undefined,
      streaks: kind === VK.WILLOW,
      accents,
      accentRate: 0.035,
      leaf: kind === VK.PINE ? 1.8 : kind === VK.BIRCH ? 1.9 : kind === VK.PLANE ? 3.4 : 2.6,
    });
  });
}

/**
 * Trunk (and roots) of visible height `vis` art px, anchored at its foot. It
 * continues up into the canopy so gaps in the leaves show wood.
 */
function trunk(kind: number, vis: number, tr: number, r: number): FloraSprite {
  const w = Math.max(3, tr * 2);
  const up = Math.round(r * 0.55);
  const H = vis + up + 1;
  const W = w + 4;
  const b = bark(kind);
  const seed = hash2(kind, vis * 64 + tr, r);
  return make(W, H, W / 2, H - 1, (img) => {
    const x0 = 2;
    for (let y = 0; y < H; y++) {
      const fromTop = y;
      const taper = fromTop < up * 0.6 ? 1 : 0; // a bit thinner up in the crown
      const flare = y >= H - 2 ? 1 : 0; // roots
      const xa = x0 + taper - flare, xb = x0 + w - 1 - taper + flare;
      for (let x = xa; x <= xb; x++) {
        let c = x === xa ? b.l : x === xb ? b.d : b.m;
        const g = hash2(x, y, seed) & 255;
        if (kind === VK.BIRCH) {
          if (g < 40 && x !== xa) c = b.mark;
        } else if (kind === VK.PLANE) {
          if (g < 50) c = b.mark;
        } else if (g < 30) c = b.mark;
        if (y >= H - 2 && x !== xa) c = b.d;
        put(img, x, y, c);
      }
    }
    // two limbs forking into the crown
    if (kind !== VK.SPRUCE) {
      const cx = x0 + w / 2;
      line(img, cx, up * 0.7, cx - r * 0.3, Math.max(0, up * 0.15), b.d);
      line(img, cx, up * 0.8, cx + r * 0.32, Math.max(0, up * 0.25), b.d);
    }
  });
}

/** Low round bush with a darker south face (the 3/4 cheat), anchored at its base centre. */
function bush(r: number, variant: number): FloraSprite {
  const fh = Math.max(2, Math.round(r * 0.55));
  const S = Math.ceil(r * 2.2) + 4;
  const H = S + fh;
  const c = S / 2;
  const seed = hash2(r, variant, 0xb05);
  const rnd = new Rand(seed);
  const t = TINTS[variant % TINTS.length];
  const p0 = FOLIAGE[VK.BUSH];
  const pal: Foliage = { l: tinted(p0.l, t), m: tinted(p0.m, t), d: tinted(p0.d, t), deep: tinted(p0.deep, t) };
  const flowers = [[hex('#e8d84a')], [hex('#e06a5a')], [hex('#f0ece0')], [hex('#9a7ad0')], [hex('#b8302a')]];
  const kindOfAccent = (variant >> 2) % 8;
  const accents = kindOfAccent < flowers.length ? flowers[kindOfAccent] : undefined;
  return make(S, H, c, c + fh * 0.5, (img) => {
    const blobs: Blob[] = [{ x: 0, y: 0, r: r * 0.7, h: 1 }];
    const n = 3 + Math.floor(rnd.next() * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd.range(-0.5, 0.5), d = r * rnd.range(0.3, 0.45);
      blobs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: (r - d) * rnd.range(0.9, 1), h: 0.9 });
    }
    // south face: the footprint swept down by fh, in the dark tones
    for (let y = 0; y < H; y++) for (let x = 0; x < S; x++) {
      for (let k = 1; k <= fh; k++) {
        const px = x + 0.5 - c, py = y + 0.5 - c - k;
        if (blobs.some((b) => (px - b.x) ** 2 + (py - b.y) ** 2 < b.r * b.r * 0.92)) {
          const g = hash2(x, y, seed) & 255;
          put(img, x, y, k > fh * 0.6 || g < 60 ? pal.deep : pal.d);
          break;
        }
      }
    }
    shadeBlobs(img, c, c, blobs, pal, { seed, accents, accentRate: 0.07, leaf: 1.7, edge: 0.9 });
  });
}

/** A fern: fronds radiating from the centre, anchored at the centre. */
function fern(r: number, variant: number): FloraSprite {
  const S = Math.ceil(r * 2) + 3;
  const c = S / 2;
  const rnd = new Rand(hash2(r, variant, 0xfe2));
  const pal = FOLIAGE[VK.FERN];
  return make(S, S, c, c, (img) => {
    const n = 6 + Math.floor(rnd.next() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd.range(-0.25, 0.25);
      const len = r * rnd.range(0.7, 1);
      const steps = Math.ceil(len);
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        const bend = f * f * 0.35;
        const x = c + Math.cos(a + bend) * len * f, y = c + Math.sin(a + bend) * len * f;
        const col = f > 0.7 ? pal.l : f > 0.3 ? pal.m : pal.d;
        put(img, Math.floor(x), Math.floor(y), col);
        if (s % 2 === 0 && f > 0.15 && f < 0.9) {
          // leaflets either side
          const nx = -Math.sin(a), ny = Math.cos(a);
          put(img, Math.floor(x + nx), Math.floor(y + ny), pal.m);
          put(img, Math.floor(x - nx), Math.floor(y - ny), Math.cos(a) + Math.sin(a) > 0 ? pal.d : pal.m);
        }
      }
    }
  });
}

function segDist(px: number, py: number, dx: number, dy: number): number {
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / l2)) : 0;
  return Math.hypot(px - dx * t, py - dy * t);
}

/** Trimmed hedge from (0,0) to (dx,dy): flat lit top, darker south face. Anchored at (0,0). */
function hedge(dx: number, dy: number, hd: number, variant: number, wild: number): FloraSprite {
  const fh = Math.max(3, Math.round(hd * 1.4));
  const minx = Math.floor(Math.min(0, dx) - hd - 2), maxx = Math.ceil(Math.max(0, dx) + hd + 2);
  const miny = Math.floor(Math.min(0, dy) - hd - fh - 2), maxy = Math.ceil(Math.max(0, dy) + hd + 2);
  const W = maxx - minx, H = maxy - miny;
  const seed = hash2(dx * 7 + dy, variant, 0x4ed);
  const t = TINTS[variant % TINTS.length];
  const p0 = FOLIAGE[VK.HEDGE];
  const pal: Foliage = { l: tinted(p0.l, t), m: tinted(p0.m, t), d: tinted(p0.d, t), deep: tinted(p0.deep, t) };
  return make(W, H, -minx, -miny, (img) => {
    const inside = (x: number, y: number) => {
      const e = (valueNoise(x / 2.2, y / 2.2, seed) - 0.5) * (1 + wild * 2);
      return segDist(x, y, dx, dy) < hd + e;
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const wx = x + minx + 0.5, wy = y + miny + 0.5;
        const g = hash2(x, y, seed) & 255;
        if (inside(wx, wy + fh)) {
          // top: NW edge highlight, leafy texture
          const edgeNW = !inside(wx - 1, wy + fh - 1);
          const edgeSE = !inside(wx + 1, wy + fh + 1);
          const n = valueNoise(wx / 1.6, wy / 1.6, seed + 2);
          let c = n > 0.62 ? pal.l : n > 0.3 ? pal.m : pal.d;
          if (edgeNW) c = pal.l;
          else if (edgeSE) c = pal.d;
          if (g < 6) c = pal.deep;
          put(img, x, y, c);
          continue;
        }
        for (let k = 0; k < fh; k++) {
          if (inside(wx, wy + k)) {
            const n = valueNoise(wx / 1.3, wy / 3, seed + 4);
            put(img, x, y, k < 2 || n < 0.35 ? pal.deep : pal.d);
            break;
          }
        }
      }
    }
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
    const shape = variant & 3, tint = (variant >> 2) & 3;
    return this.get(`c${kind},${r},${shape},${tint}`, () => canopy(kind, r, shape, tint));
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
    const w = Math.round(wild * 4);
    return this.get(`h${dx},${dy},${hd},${variant & 3},${w}`, () => hedge(dx, dy, hd, variant & 3, w / 4));
  }
}
