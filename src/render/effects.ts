// Arcade effects layer: blood that stays on the ground, gore, hit flashes,
// bite telegraphs, loot sparkle, the search ring, popping pixel-font numbers
// and red arrows at the screen edge for zombies coming at you from off-screen.

import { metersPerTexel } from '../core/geo';
import type { Camera } from '../engine/camera';
import type { Container, Effect, GameWorld, Zombie } from '../game/world';
import { windupTime } from '../game/world';
import type { PixelSprite } from './sprites';

const OUTLINE = '#1b1a2e';

// ---------------------------------------------------------------- pixel font
// 3×5 glyphs, rows top to bottom, '#' = ink.
const GLYPHS: Record<string, string> = {
  '0': '###|#.#|#.#|#.#|###', '1': '.#.|##.|.#.|.#.|###', '2': '###|..#|###|#..|###', '3': '###|..#|.##|..#|###',
  '4': '#.#|#.#|###|..#|..#', '5': '###|#..|###|..#|###', '6': '###|#..|###|#.#|###', '7': '###|..#|.#.|.#.|.#.',
  '8': '###|#.#|###|#.#|###', '9': '###|#.#|###|..#|###', A: '.#.|#.#|###|#.#|#.#', B: '##.|#.#|##.|#.#|##.',
  C: '.##|#..|#..|#..|.##', D: '##.|#.#|#.#|#.#|##.', E: '###|#..|##.|#..|###', F: '###|#..|##.|#..|#..',
  G: '.##|#..|#.#|#.#|.##', H: '#.#|#.#|###|#.#|#.#', I: '###|.#.|.#.|.#.|###', J: '..#|..#|..#|#.#|.#.',
  K: '#.#|#.#|##.|#.#|#.#', L: '#..|#..|#..|#..|###', M: '#...#|##.##|#.#.#|#...#|#...#', N: '#..#|##.#|#.##|#..#|#..#',
  O: '.#.|#.#|#.#|#.#|.#.', P: '##.|#.#|##.|#..|#..', Q: '.#.|#.#|#.#|##.|.##', R: '##.|#.#|##.|#.#|#.#',
  S: '.##|#..|.#.|..#|##.', T: '###|.#.|.#.|.#.|.#.', U: '#.#|#.#|#.#|#.#|###', V: '#.#|#.#|#.#|#.#|.#.',
  W: '#...#|#...#|#.#.#|##.##|#...#', X: '#.#|#.#|.#.|#.#|#.#', Y: '#.#|#.#|.#.|.#.|.#.', Z: '###|..#|.#.|#..|###',
  '!': '#|#|#|.|#', '+': '...|.#.|###|.#.|...', '-': '...|...|###|...|...', ' ': '..|..|..|..|..', '.': '.|.|.|.|#',
  "'": '#|#|.|.|.', '×': '...|#.#|.#.|#.#|...',
};

const textCache = new Map<string, HTMLCanvasElement>();

/** Text in the 3×5 pixel font, one art pixel per font pixel, with a dark outline. */
function pixelText(text: string, color: string): HTMLCanvasElement {
  const key = text + '|' + color;
  let c = textCache.get(key);
  if (c) return c;
  const glyphs = [...text.toUpperCase()].map((ch) => (GLYPHS[ch] ?? GLYPHS[' ']).split('|'));
  const w = glyphs.reduce((a, g) => a + g[0].length + 1, 0) + 1;
  const h = 7;
  c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const ink: [number, number][] = [];
  let x = 1;
  for (const gl of glyphs) {
    for (let r = 0; r < 5; r++) for (let q = 0; q < gl[r].length; q++) if (gl[r][q] === '#') ink.push([x + q, r + 1]);
    x += gl[0].length + 1;
  }
  g.fillStyle = OUTLINE;
  for (const [px, py] of ink) g.fillRect(px - 1, py - 1, 3, 3);
  g.fillStyle = color;
  for (const [px, py] of ink) g.fillRect(px, py, 1, 1);
  if (textCache.size > 300) textCache.clear();
  textCache.set(key, c);
  return c;
}

const tintCache = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();

/** The sprite's silhouette in one flat colour (white hit flash, red wind-up). */
function tinted(img: HTMLCanvasElement, color: string): HTMLCanvasElement {
  let m = tintCache.get(img);
  if (!m) tintCache.set(img, (m = new Map()));
  let c = m.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  m.set(color, c);
  return c;
}

export interface FxView {
  ctx: CanvasRenderingContext2D;
  cam: Camera;
  /** device px per art px for people sprites */
  K: number;
  /** device px per metre */
  pxPerM: number;
  /** chest height on screen, device px */
  lift: number;
  /** the sprite a zombie was drawn with this frame */
  spriteOf: (z: Zombie) => PixelSprite | undefined;
  /** false when hidden under someone else's roof */
  visible: (x: number, y: number) => boolean;
  now: number;
}

/** Blood on the ground: drawn before anyone standing, so they walk over it. */
export function drawGroundFx(v: FxView, world: GameWorld) {
  const { ctx, cam, pxPerM } = v;
  const b = cam.bounds(20);
  for (const s of world.juice.splats) {
    if (s.x < b.x0 || s.x > b.x1 || s.y < b.y0 || s.y > b.y1) continue;
    const a = Math.min(1, (s.life - s.t) / 6) * 0.85;
    if (a <= 0) continue;
    const q = cam.worldToScreen(s.x, s.y);
    const grow = Math.min(1, s.t / 0.12);
    const r = Math.max(2, s.r * pxPerM * grow);
    ctx.globalAlpha = a;
    ctx.fillStyle = s.color;
    // a chunky blob of three to five squares, the same every frame
    let h = s.seed;
    const n = 3 + (h % 3);
    for (let i = 0; i < n; i++) {
      h = (h * 1103515245 + 12345) >>> 0;
      const ox = (((h >> 8) % 100) / 100 - 0.5) * r * 1.4;
      const oy = (((h >> 16) % 100) / 100 - 0.5) * r * 0.9;
      const rr = r * (0.45 + ((h >> 4) % 50) / 100);
      ctx.fillRect(Math.round(q.x + ox - rr / 2), Math.round(q.y + oy - rr / 3), Math.round(rr), Math.round(rr * 0.66));
    }
  }
  ctx.globalAlpha = 1;
}

function lootLeft(world: GameWorld, c: Container): boolean {
  return !world.isSearched(c) || !!c.items?.length;
}

/** Everything that pops on top of the action. */
export function drawFx(v: FxView, world: GameWorld) {
  const { ctx, cam, pxPerM, lift, K, now } = v;
  const J = world.juice;
  const t = now / 1000;
  const tpm = 1 / metersPerTexel(cam.center.y);
  const b = cam.bounds(10);
  const inView = (x: number, y: number) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
  const p = world.player;

  // loot sparkle: soft yellow glow and twinkles over anything not yet emptied
  for (const c of world.allContainers()) {
    if (c.kind === 'building' || c.kind === 'playercorpse' || !inView(c.x, c.y) || !v.visible(c.x, c.y)) continue;
    if (!lootLeft(world, c)) continue;
    const q = cam.worldToScreen(c.x, c.y);
    const ph = (c.x * 0.37 + c.y * 0.11) % 6.28;
    const pulse = 0.5 + 0.5 * Math.sin(t * 3 + ph);
    ctx.globalAlpha = 0.18 + pulse * 0.14;
    ctx.fillStyle = '#ffe14a';
    ctx.beginPath();
    ctx.ellipse(q.x, q.y, 0.75 * pxPerM, 0.45 * pxPerM, 0, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 2; i++) {
      const tw = (t * 1.3 + ph + i * 0.5) % 1;
      if (tw > 0.6) continue;
      const k = Math.sin((tw / 0.6) * Math.PI);
      const sx = q.x + Math.sin(ph * 3 + i * 2.4 + Math.floor(t * 1.3 + ph + i * 0.5)) * 0.55 * pxPerM;
      const sy = q.y - (0.2 + i * 0.35) * pxPerM - tw * 0.3 * pxPerM;
      sparkle(ctx, sx, sy, Math.max(2, Math.round(K)) * (1 + k * 1.5), k);
    }
  }
  ctx.globalAlpha = 1;

  // the simulation's own short effects, made punchier
  for (const e of world.effects) drawEffect(v, e);

  // flying blood and gore
  for (const q0 of J.parts) {
    if (!inView(q0.x, q0.y)) continue;
    const q = cam.worldToScreen(q0.x, q0.y);
    const s = Math.max(2, Math.round(q0.size * pxPerM));
    ctx.fillStyle = q0.color;
    ctx.fillRect(Math.round(q.x - s / 2), Math.round(q.y - q0.z * pxPerM * 0.88 - s / 2), s, s);
  }
  // kill rings
  for (const r of J.bursts) {
    const q = cam.worldToScreen(r.x, r.y);
    const k = r.t / r.life;
    ctx.strokeStyle = r.color;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = Math.max(2, (1 - k) * 0.25 * pxPerM);
    ctx.beginPath();
    ctx.ellipse(q.x, q.y - lift * 0.6, (0.3 + k) * r.r * pxPerM, (0.3 + k) * r.r * pxPerM * 0.8, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // hit flashes and bite telegraphs on the zombies themselves
  for (const z of world.allZombies()) {
    if ((z.flash <= 0 && z.windup <= 0) || !inView(z.x, z.y) || !v.visible(z.x, z.y)) continue;
    const s = v.spriteOf(z);
    const q = cam.worldToScreen(z.x, z.y);
    const ax = Math.round(q.x), ay = Math.round(q.y);
    if (z.windup > 0) {
      const f = Math.min(1, z.windup / windupTime(z.kind));
      // danger ring tightening under its feet
      ctx.strokeStyle = '#ff2a2a';
      ctx.lineWidth = Math.max(2, 0.08 * pxPerM);
      ctx.globalAlpha = 0.5 + 0.5 * f;
      const rr = (1.1 - f * 0.55) * pxPerM;
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, rr, rr * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (s) {
        ctx.globalAlpha = 0.25 + 0.45 * f * (0.5 + 0.5 * Math.sin(t * 40));
        drawImg(ctx, tinted(s.img, '#ff3030'), ax, ay, s, K);
      }
      ctx.globalAlpha = 1;
      const bang = pixelText('!', '#ff3a2a');
      const sc = Math.max(3 * cam.dpr, Math.round(K * 2.2));
      const by = ay - 2.25 * pxPerM - Math.abs(Math.sin(t * 18)) * 0.15 * pxPerM;
      ctx.drawImage(bang, Math.round(ax - (bang.width * sc) / 2), Math.round(by - bang.height * sc), bang.width * sc, bang.height * sc);
    }
    if (z.flash > 0 && s) {
      ctx.globalAlpha = Math.min(1, z.flash / 0.06);
      drawImg(ctx, tinted(s.img, '#ffffff'), ax, ay, s, K);
      ctx.globalAlpha = 1;
    }
  }

  // search ring over the survivor's head
  if (p.alive && (J.search || J.searchDone < 0.3)) {
    const q = cam.worldToScreen(p.x, p.y);
    const R = Math.max(13 * cam.dpr, 0.42 * pxPerM);
    const cy = q.y - 2.2 * pxPerM - R;
    const lw = Math.max(4 * cam.dpr, 0.13 * pxPerM);
    if (J.search) {
      const f = Math.min(1, J.search.t / J.search.dur);
      ctx.fillStyle = 'rgba(27,26,46,0.75)';
      ctx.beginPath();
      ctx.arc(q.x, cy, R + lw, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffe14a';
      ctx.lineWidth = lw;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.arc(q.x, cy, R, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
      ctx.stroke();
      // bouncing dots while rummaging
      const dots = pixelText('.'.repeat(1 + (Math.floor(t * 6) % 3)), '#fff3b0');
      const sc = Math.max(2 * cam.dpr, Math.round(K));
      ctx.drawImage(dots, Math.round(q.x - (dots.width * sc) / 2), Math.round(cy - (dots.height * sc) / 2 - sc), dots.width * sc, dots.height * sc);
    } else {
      const k = J.searchDone / 0.3;
      ctx.strokeStyle = '#ffe14a';
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = lw * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(q.x, cy, R * (1 + k * 1.2), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // pop-ups: damage numbers, groans, pickups
  for (const pp of J.pops) {
    if (pp.t < 0 || !inView(pp.x, pp.y)) continue;
    const k = pp.t / pp.life;
    const q = cam.worldToScreen(pp.x, pp.y);
    // pop in big, settle, arc up and sideways, fade at the end
    const punch = pp.t < 0.08 ? 1.5 - (pp.t / 0.08) * 0.5 : 1;
    // never smaller than readable on a phone, whatever the zoom
    const sc = Math.max(Math.round(2 * cam.dpr * pp.size * punch), Math.round(K * 1.2 * pp.size * punch));
    const arcY = Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5) * pp.rise * pxPerM;
    const x = q.x + pp.vx * k * pxPerM;
    const y = q.y - 2.1 * pxPerM - arcY - pp.row * 8 * Math.max(2 * cam.dpr, Math.round(K * 1.2 * pp.size));
    const img = pixelText(pp.text, pp.color);
    ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    let w = img.width * sc;
    const sw = pp.swatch ? 6 * sc : 0;
    w += sw;
    const x0 = Math.round(x - w / 2), y0 = Math.round(y - (img.height * sc) / 2);
    if (pp.swatch) {
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(x0, y0, 6 * sc - sc, 7 * sc);
      ctx.fillStyle = pp.swatch;
      ctx.fillRect(x0 + sc, y0 + sc, 6 * sc - 3 * sc, 5 * sc);
    }
    ctx.drawImage(img, x0 + sw, y0, img.width * sc, img.height * sc);
  }
  ctx.globalAlpha = 1;

  drawDangerArrows(v, world, tpm);
}

function drawImg(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, ax: number, ay: number, s: PixelSprite, K: number) {
  ctx.drawImage(img, ax - Math.round(s.ox * K), ay - Math.round(s.oy * K), Math.round(img.width * K), Math.round(img.height * K));
}

function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, a: number) {
  ctx.globalAlpha = a;
  ctx.fillStyle = '#fffbe0';
  const u = Math.max(1, Math.round(s / 3));
  const r = Math.round(s);
  x = Math.round(x);
  y = Math.round(y);
  ctx.fillRect(x - u / 2, y - r, u, r * 2);
  ctx.fillRect(x - r, y - u / 2, r * 2, u);
  ctx.globalAlpha = 1;
}

function drawEffect(v: FxView, e: Effect) {
  const { ctx, cam, pxPerM, lift } = v;
  const q = cam.worldToScreen(e.x, e.y);
  const k = 1 - e.t / e.life;
  if (e.kind === 'blood') {
    ctx.fillStyle = `rgba(200,24,20,${k})`;
    const s = Math.max(2, 0.1 * pxPerM);
    ctx.fillRect(Math.round(q.x), Math.round(q.y - lift * 0.8 + (1 - k) * 0.6 * pxPerM), s, s);
  } else if (e.kind === 'flash') {
    // a chunky four-point muzzle star
    const r = (0.35 + 0.2 * k) * pxPerM;
    ctx.fillStyle = `rgba(255,236,120,${k})`;
    ctx.beginPath();
    ctx.arc(q.x, q.y - lift, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,230,${k})`;
    const u = Math.max(2, r * 0.25);
    ctx.fillRect(q.x - r, q.y - lift - u / 2, r * 2, u);
    ctx.fillRect(q.x - u / 2, q.y - lift - r, u, r * 2);
  } else if (e.kind === 'tracer' && e.x2 !== undefined && e.y2 !== undefined) {
    const q2 = cam.worldToScreen(e.x2, e.y2);
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(255,190,60,${k * 0.6})`;
    ctx.lineWidth = Math.max(3, 0.16 * pxPerM);
    ctx.beginPath();
    ctx.moveTo(q.x, q.y - lift);
    ctx.lineTo(q2.x, q2.y - lift);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,220,${k})`;
    ctx.lineWidth = Math.max(1, 0.06 * pxPerM);
    ctx.stroke();
    ctx.lineCap = 'butt';
  } else if (e.kind === 'swing' && e.angle !== undefined) {
    // a white smear that sweeps through the arc
    const sweep = Math.min(1, e.t / (e.life * 0.5));
    const a0 = e.angle - 1.2, a1 = e.angle - 1.2 + 2.4 * sweep;
    ctx.strokeStyle = `rgba(255,255,255,${k * 0.85})`;
    ctx.lineWidth = Math.max(2, 0.18 * pxPerM * k);
    ctx.beginPath();
    ctx.ellipse(q.x, q.y - lift, 1.05 * pxPerM, 1.05 * pxPerM * 0.75, 0, a0, a1);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${k * 0.35})`;
    ctx.lineWidth = Math.max(1, 0.4 * pxPerM * k);
    ctx.beginPath();
    ctx.ellipse(q.x, q.y - lift, 0.8 * pxPerM, 0.8 * pxPerM * 0.75, 0, a0, a1);
    ctx.stroke();
  }
}

/** Red arrows at the screen edge for zombies chasing you from out of sight. */
function drawDangerArrows(v: FxView, world: GameWorld, tpm: number) {
  const { ctx, cam } = v;
  const p = world.player;
  if (!p.alive) return;
  const m = 26 * cam.dpr;
  const cx = cam.width / 2, cy = cam.height / 2;
  const t = v.now / 1000;
  let n = 0;
  for (const z of world.allZombies()) {
    if (z.state !== 'chase') continue;
    const d = Math.hypot(z.x - p.x, z.y - p.y) / tpm;
    if (d > 30) continue;
    const q = cam.worldToScreen(z.x, z.y);
    if (q.x > m * 0.5 && q.x < cam.width - m * 0.5 && q.y > m * 0.5 && q.y < cam.height - m * 0.5) continue;
    const dx = q.x - cx, dy = q.y - cy;
    // clamp the ray from the centre to the inset screen rectangle
    // (the bottom edge sits above the bars and buttons)
    const bottom = 120 * cam.dpr;
    const sx = (cam.width / 2 - m) / Math.abs(dx || 1e-6), sy = (dy > 0 ? cam.height / 2 - bottom : cam.height / 2 - m) / Math.abs(dy || 1e-6);
    const s = Math.min(sx, sy);
    const x = cx + dx * s, y = cy + dy * s;
    const a = Math.atan2(dy, dx);
    const near = 1 - Math.min(1, d / 30);
    const size = (9 + near * 9) * cam.dpr;
    const pulse = 0.55 + 0.45 * Math.sin(t * (6 + near * 8));
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.rotate(a);
    ctx.globalAlpha = 0.7 + 0.3 * pulse;
    ctx.fillStyle = z.kind === 'runner' ? '#ff7a1a' : '#ff2a2a';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = Math.max(2, cam.dpr * 1.5);
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.6, -size * 0.75);
    ctx.lineTo(-size * 0.25, 0);
    ctx.lineTo(-size * 0.6, size * 0.75);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    if (++n >= 10) break;
  }
  ctx.globalAlpha = 1;
}
