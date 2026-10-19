// People, zombies and corpses, built as a tiny 3D rig of ellipsoids and
// capsules and rasterised straight onto the art-pixel grid (11 px per metre,
// docs/ART_STYLE.md section 3) for each of 8 headings. Nothing is rotated at
// draw time, so pixels stay crisp in every direction.
//
// Projection is the game's top-down view with a 3/4 cheat: a point at ground
// position (x, y) and height z lands on screen at (x, y - CHEAT * z). Each
// screen pixel casts a ray into the rig and keeps the nearest surface, which
// gives correct overlap (arm in front of torso, head over shoulders) and a
// per-pixel normal for NW sun shading. Pure code: returns RGBA buffers.

export const ART_PPM = 11;
/** How far up the screen one metre of height is drawn. */
export const CHEAT = 0.88;

export type Heading = number; // 0..7, 0 = east, 2 = south (screen y down), clockwise

type V3 = [number, number, number]; // body frame: forward, right, up (metres)

interface Mat {
  col: number; // 0xRRGGBB
  /** clothing that can be torn/bloodied, skin that can be bloodied */
  cloth?: boolean;
  skin?: boolean;
}

type Part =
  | { k: 'ell'; c: V3; r: V3; m: Mat }
  | { k: 'cap'; a: V3; b: V3; ra: number; rb: number; m: Mat }
  | { k: 'dot'; c: V3; m: Mat };

export type WeaponKind = 'knife' | 'machete' | 'hammer' | 'crowbar' | 'bat' | 'hockey' | 'axe' | 'pistol' | 'rifle';

export const WEAPON_OF_ITEM: Record<string, WeaponKind> = {
  kitchen_knife: 'knife', machete: 'machete', hammer: 'hammer', crowbar: 'crowbar', bat: 'bat',
  hockey_stick: 'hockey', fire_axe: 'axe', pistol: 'pistol', rifle: 'rifle',
};

export interface Look {
  skin: number;
  hair: number;
  top: number;
  pants: number;
  shoes: number;
  /** backpack colour */
  pack?: number;
  hat?: { kind: 'cap' | 'helmet'; col: number };
  vest?: number;
  /** slung rifle on the back */
  sling?: boolean;
  zombie: boolean;
  /** 0 upright .. 1 hunched */
  lean: number;
  /** shoulder width factor */
  build: number;
  blood: number;
  torn: number;
  seed: number;
}

export type Act = 'idle' | 'walk' | 'run' | 'attack' | 'hit' | 'death' | 'shamble' | 'lunge' | 'feed' | 'lying';

export interface Pose {
  act: Act;
  frame: number;
  weapon?: WeaponKind | null;
}

export interface Raster {
  w: number;
  h: number;
  /** anchor (feet / body centre) in canvas pixels */
  ox: number;
  oy: number;
  rgba: Uint8ClampedArray;
}

// ---------------------------------------------------------------- rig

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const scale = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];

function weaponParts(kind: WeaponKind, hand: V3, dir: V3, out: Part[]) {
  const d = norm(dir);
  const at = (t: number) => add(hand, scale(d, t));
  const wood = { col: 0x8a6440 }, steel = { col: 0xb4bac2 }, dark = { col: 0x34363a }, grip = { col: 0x2e2622 };
  switch (kind) {
    case 'knife':
      out.push({ k: 'cap', a: at(-0.04), b: at(0.06), ra: 0.03, rb: 0.03, m: grip });
      out.push({ k: 'cap', a: at(0.07), b: at(0.24), ra: 0.03, rb: 0.02, m: steel });
      break;
    case 'machete':
      out.push({ k: 'cap', a: at(-0.05), b: at(0.07), ra: 0.03, rb: 0.03, m: grip });
      out.push({ k: 'cap', a: at(0.08), b: at(0.5), ra: 0.035, rb: 0.04, m: steel });
      break;
    case 'hammer':
      out.push({ k: 'cap', a: at(-0.06), b: at(0.28), ra: 0.03, rb: 0.03, m: wood });
      out.push({ k: 'cap', a: add(at(0.3), [0, -0.06, 0]), b: add(at(0.3), [0, 0.07, 0]), ra: 0.04, rb: 0.04, m: dark });
      break;
    case 'crowbar':
      out.push({ k: 'cap', a: at(-0.1), b: at(0.62), ra: 0.03, rb: 0.03, m: { col: 0x9a2e28 } });
      out.push({ k: 'cap', a: at(0.62), b: add(at(0.66), [0, 0.06, -0.04]), ra: 0.03, rb: 0.03, m: { col: 0x9a2e28 } });
      break;
    case 'bat':
      out.push({ k: 'cap', a: at(-0.08), b: at(0.78), ra: 0.03, rb: 0.055, m: { col: 0xc09464 } });
      break;
    case 'hockey':
      out.push({ k: 'cap', a: at(-0.1), b: at(0.8), ra: 0.03, rb: 0.03, m: { col: 0x3a6ab0 } });
      out.push({ k: 'cap', a: at(0.8), b: add(at(0.84), [0.08, 0.08, 0]), ra: 0.04, rb: 0.04, m: { col: 0x3a6ab0 } });
      break;
    case 'axe':
      out.push({ k: 'cap', a: at(-0.08), b: at(0.7), ra: 0.032, rb: 0.032, m: wood });
      out.push({ k: 'ell', c: add(at(0.66), [0, 0.07, 0]), r: [0.05, 0.08, 0.06], m: { col: 0xc43b2e } });
      break;
    case 'pistol':
      out.push({ k: 'cap', a: at(0), b: at(0.17), ra: 0.035, rb: 0.03, m: dark });
      break;
    case 'rifle':
      out.push({ k: 'cap', a: at(-0.28), b: at(0.55), ra: 0.035, rb: 0.03, m: { col: 0x3d4030 } });
      break;
  }
}

const TWO_HANDED = new Set<WeaponKind>(['bat', 'hockey', 'axe', 'crowbar']);

/** A standing rig in body frame (forward, right, up). Anchor is between the feet. */
function standing(look: Look, pose: Pose): Part[] {
  const out: Part[] = [];
  const { act, frame } = pose;
  const weapon = pose.weapon ?? null;
  const skin: Mat = { col: look.skin, skin: true };
  const top: Mat = { col: look.top, cloth: true };
  const pants: Mat = { col: look.pants, cloth: true };
  const shoes: Mat = { col: look.shoes };
  const W = look.build;

  let lean = look.lean;
  let stride = 0, lift = 0, bob = 0, sway = 0;
  let footL: V3 = [0.02, -0.1, 0.05], footR: V3 = [-0.02, 0.1, 0.05];
  let hip = 0.88;
  const ph = (frame % 4) * (Math.PI / 2);
  if (act === 'walk' || act === 'run' || act === 'shamble') {
    stride = act === 'run' ? 0.3 : act === 'shamble' ? 0.17 : 0.2;
    lift = act === 'run' ? 0.16 : act === 'shamble' ? 0.03 : 0.08;
    const sL = Math.sin(ph), cL = Math.cos(ph);
    footL = [stride * sL, -0.1, 0.05 + lift * Math.max(0, cL)];
    footR = [-stride * sL, 0.1, 0.05 + lift * Math.max(0, -cL)];
    if (act === 'shamble') {
      // one leg drags: the right foot barely lifts and trails
      footR = [-stride * 0.6 * sL - 0.06, 0.12, 0.05];
      sway = 0.04 * Math.cos(ph);
    }
    bob = -0.03 * Math.abs(sL);
    if (act === 'run') lean += 0.2;
  }
  if (act === 'idle') bob = frame % 2 ? -0.025 : 0;
  if (act === 'hit') lean -= 0.25;
  if (act === 'lunge') lean += [0.0, 0.55, 0.45][frame % 3];

  const fwd = (z: number) => lean * 0.32 * Math.max(0, z - 0.85) + (act === 'lunge' && frame % 3 ? 0.08 : 0);
  const hipZ = hip + bob;
  const at = (f: number, s: number, z: number): V3 => [f + fwd(z), s + sway * (z / 1.6), z + bob - Math.max(0, lean) * 0.12 * Math.max(0, z - 1.0)];

  // legs and shoes
  const hipL = at(0, -0.09, hipZ), hipR = at(0, 0.09, hipZ);
  out.push({ k: 'cap', a: hipL, b: footL, ra: 0.085, rb: 0.07, m: pants });
  out.push({ k: 'cap', a: hipR, b: footR, ra: 0.085, rb: 0.07, m: pants });
  out.push({ k: 'ell', c: add(footL, [0.05, 0, -0.01]), r: [0.1, 0.055, 0.045], m: shoes });
  out.push({ k: 'ell', c: add(footR, [0.05, 0, -0.01]), r: [0.1, 0.055, 0.045], m: shoes });
  // pelvis, torso
  out.push({ k: 'ell', c: at(0, 0, hipZ + 0.04), r: [0.12, 0.17 * W, 0.1], m: pants });
  const chest = at(0, 0, 1.22);
  out.push({ k: 'ell', c: chest, r: [0.16, 0.21 * W, 0.26], m: top });
  if (look.vest !== undefined) out.push({ k: 'ell', c: at(0.005, 0, 1.24), r: [0.15, 0.205 * W, 0.17], m: { col: look.vest, cloth: true } });
  if (look.pack !== undefined) {
    out.push({ k: 'ell', c: at(-0.18, 0, 1.24), r: [0.09, 0.15, 0.2], m: { col: look.pack } });
    out.push({ k: 'ell', c: at(-0.2, 0, 1.43), r: [0.07, 0.13, 0.05], m: { col: shadeHex(look.pack, 0.8) } });
    // shoulder straps seen from the front
    for (const s of [-0.1, 0.1]) for (const z of [1.38, 1.3, 1.22]) out.push({ k: 'dot', c: at(0.125, s * W, z), m: { col: shadeHex(look.pack, 0.7) } });
  }
  if (look.sling) out.push({ k: 'cap', a: at(-0.15, 0.2, 1.45), b: at(-0.15, -0.18, 0.9), ra: 0.03, rb: 0.03, m: { col: 0x2f3226 } });
  // head
  const headLean = look.zombie ? 0.14 + lean * 0.1 : 0.02;
  const head = at(headLean, 0, 1.6 - (look.zombie ? 0.05 + lean * 0.06 : 0));
  out.push({ k: 'ell', c: head, r: [0.125, 0.12, 0.13], m: skin });
  if (look.hat?.kind === 'helmet') {
    out.push({ k: 'ell', c: add(head, [-0.02, 0, 0.05]), r: [0.14, 0.135, 0.1], m: { col: look.hat.col } });
  } else {
    out.push({ k: 'ell', c: add(head, [-0.03, 0, 0.04]), r: [0.12, 0.125, 0.105], m: { col: look.hair } });
    if (look.hat) {
      out.push({ k: 'ell', c: add(head, [-0.01, 0, 0.09]), r: [0.12, 0.12, 0.06], m: { col: look.hat.col } });
      out.push({ k: 'ell', c: add(head, [0.11, 0, 0.07]), r: [0.06, 0.09, 0.02], m: { col: shadeHex(look.hat.col, 0.7) } });
    }
  }
  // eyes (and a zombie's dark mouth)
  const eye = look.zombie ? 0x3a1612 : 0x2a201c;
  out.push({ k: 'dot', c: add(head, [0.11, -0.05, 0.0]), m: { col: eye } });
  out.push({ k: 'dot', c: add(head, [0.11, 0.05, 0.0]), m: { col: eye } });
  if (look.zombie) out.push({ k: 'dot', c: add(head, [0.11, 0, -0.08]), m: { col: 0x5a1a16 } });

  // arms
  const shL = at(0.0, -0.23 * W, 1.4), shR = at(0.0, 0.23 * W, 1.4);
  let hL: V3, hR: V3;
  let wDir: V3 | null = null;
  const swing = Math.sin(ph) * (act === 'run' ? 0.22 : 0.13);
  if (look.zombie) {
    const reach = act === 'lunge' ? [0.25, 0.62, 0.52][frame % 3] : 0.44;
    const bobA = act === 'shamble' ? 0.04 * Math.sin(ph) : 0;
    const zA = act === 'lunge' && frame % 3 === 0 ? 1.5 : 1.3;
    hL = at(reach + bobA, -0.14 + (act === 'lunge' && frame % 3 === 2 ? 0.07 : 0), zA + bobA);
    hR = at(reach - bobA, 0.14 - (act === 'lunge' && frame % 3 === 2 ? 0.07 : 0), zA - 0.04 - bobA);
    if (act === 'hit') {
      hL = at(0.15, -0.3, 1.45);
      hR = at(0.1, 0.32, 1.5);
    }
  } else if (act === 'hit') {
    hL = at(0.12, -0.32, 1.45);
    hR = at(0.12, 0.32, 1.45);
  } else if (act === 'attack') {
    const f = frame % 3;
    if (!weapon) {
      hL = at(0.22, -0.16, 1.32);
      hR = [at(-0.05, 0.24, 1.25), at(0.52, 0.06, 1.38), at(0.32, 0.12, 1.28)][f];
    } else if (weapon === 'pistol') {
      const k = f === 0 ? -0.06 : 0;
      hL = at(0.4 + k, -0.02, 1.36 + -k);
      hR = at(0.42 + k, 0.04, 1.36 + -k);
      wDir = [1, 0, f === 0 ? 0.3 : 0];
    } else if (weapon === 'rifle') {
      const k = f === 0 ? -0.06 : 0;
      hR = at(0.16 + k, 0.12, 1.34);
      hL = at(0.46 + k, -0.02, 1.36);
      wDir = [1, -0.12, f === 0 ? 0.1 : 0];
    } else {
      hR = [at(-0.08, 0.3, 1.5), at(0.42, 0.06, 1.3), at(0.24, -0.26, 1.06)][f];
      wDir = [[-0.35, 0.45, 0.85], [1, -0.08, 0.06], [0.4, -0.85, -0.35]][f] as V3;
      hL = TWO_HANDED.has(weapon) ? add(hR, scale(norm(wDir), -0.12)) : at(0.15, -0.24, 1.0);
    }
  } else if (weapon === 'pistol') {
    hL = at(0.38, -0.02, 1.32);
    hR = at(0.4, 0.04, 1.32);
    wDir = [1, 0, 0];
  } else if (weapon === 'rifle') {
    hR = at(0.16, 0.12, 1.3);
    hL = at(0.44, -0.03, 1.32);
    wDir = [1, -0.12, 0];
  } else {
    hL = at(-swing, -0.28 * W, 0.98);
    hR = at(swing, 0.28 * W, 0.98);
    if (act === 'run') {
      hL = at(-swing + 0.08, -0.22, 1.12);
      hR = at(swing + 0.08, 0.22, 1.12);
    }
    if (weapon) {
      hR = at(0.16 + swing * 0.3, 0.24, 1.05);
      // long weapons rest back over the shoulder, short ones point ahead
      wDir = TWO_HANDED.has(weapon) ? [-0.45, 0.12, 0.85] : [0.8, 0.05, 0.25];
      if (TWO_HANDED.has(weapon)) hR = at(0.14 + swing * 0.3, 0.22, 1.2);
    }
  }
  const elbow = (sh: V3, h: V3, side: number): V3 => {
    const m = lerp3(sh, h, 0.5);
    return [m[0] - 0.04, m[1] + side * 0.04, m[2] - 0.04];
  };
  const eL = elbow(shL, hL, -1), eR = elbow(shR, hR, 1);
  const sleeve = look.zombie && look.torn > 0.4 ? skin : top;
  out.push({ k: 'cap', a: shL, b: eL, ra: 0.065, rb: 0.06, m: top });
  out.push({ k: 'cap', a: eL, b: hL, ra: 0.06, rb: 0.055, m: sleeve });
  out.push({ k: 'cap', a: shR, b: eR, ra: 0.065, rb: 0.06, m: top });
  out.push({ k: 'cap', a: eR, b: hR, ra: 0.06, rb: 0.055, m: top });
  out.push({ k: 'ell', c: hL, r: [0.055, 0.05, 0.05], m: skin });
  out.push({ k: 'ell', c: hR, r: [0.055, 0.05, 0.05], m: skin });
  if (weapon && wDir) weaponParts(weapon, hR, wDir, out);
  return out;
}

function feeding(look: Look, frame: number): Part[] {
  const out: Part[] = [];
  const skin: Mat = { col: look.skin, skin: true }, top: Mat = { col: look.top, cloth: true }, pants: Mat = { col: look.pants, cloth: true };
  const dip = frame % 2 ? 0.06 : 0;
  for (const s of [-0.1, 0.1]) {
    const hip: V3 = [0, s, 0.45], knee: V3 = [0.28, s * 1.2, 0.08], foot: V3 = [-0.22, s, 0.05];
    out.push({ k: 'cap', a: hip, b: knee, ra: 0.075, rb: 0.07, m: pants });
    out.push({ k: 'cap', a: knee, b: foot, ra: 0.07, rb: 0.06, m: pants });
    out.push({ k: 'ell', c: [-0.26, s, 0.05], r: [0.09, 0.055, 0.045], m: { col: look.shoes } });
  }
  out.push({ k: 'ell', c: [0.18, 0, 0.62 - dip], r: [0.2, 0.19 * look.build, 0.17], m: top });
  const head: V3 = [0.42, 0, 0.55 - dip * 1.5];
  out.push({ k: 'ell', c: head, r: [0.115, 0.11, 0.12], m: skin });
  out.push({ k: 'ell', c: add(head, [-0.04, 0, 0.05]), r: [0.1, 0.115, 0.09], m: { col: look.hair } });
  for (const s of [-1, 1]) {
    const sh: V3 = [0.28, s * 0.19, 0.72 - dip], h: V3 = [0.55, s * 0.12, 0.12 + (s > 0 ? dip : 0)];
    out.push({ k: 'cap', a: sh, b: h, ra: 0.065, rb: 0.055, m: top });
    out.push({ k: 'ell', c: h, r: [0.055, 0.05, 0.05], m: skin });
  }
  return out;
}

/** Tip the whole rig over backwards (angle > 0) or forwards (< 0) about the feet. */
function fall(parts: Part[], angle: number, lift = 0): Part[] {
  const c = Math.cos(angle), s = Math.sin(angle), a = Math.abs(s);
  const rot = (p: V3): V3 => [p[0] * c - p[2] * s, p[1], p[0] * s + p[2] * c + lift * a];
  const rr = (r: V3): V3 => [r[0] + (r[2] - r[0]) * a, r[1], r[2] + (r[0] - r[2]) * a];
  return parts.map((p) =>
    p.k === 'ell' ? { ...p, c: rot(p.c), r: rr(p.r) } : p.k === 'cap' ? { ...p, a: rot(p.a), b: rot(p.b) } : { ...p, c: rot(p.c) },
  );
}

/** Flatten anything that sank below ground onto it. */
function floor(parts: Part[], minZ: number): Part[] {
  const f = (p: V3): V3 => [p[0], p[1], Math.max(minZ, p[2])];
  return parts.map((p) => (p.k === 'ell' ? { ...p, c: f(p.c) } : p.k === 'cap' ? { ...p, a: f(p.a), b: f(p.b) } : { ...p, c: f(p.c) }));
}

function shift(parts: Part[], d: V3): Part[] {
  return parts.map((p) => (p.k === 'ell' ? { ...p, c: add(p.c, d) } : p.k === 'cap' ? { ...p, a: add(p.a, d), b: add(p.b, d) } : { ...p, c: add(p.c, d) }));
}

export function rig(look: Look, pose: Pose): Part[] {
  if (pose.act === 'feed') return feeding(look, pose.frame);
  if (pose.act === 'death' || pose.act === 'lying') {
    // zombies go down face first, the living fall back
    const dir = look.zombie ? -1 : 1;
    const t = pose.act === 'lying' ? 3 : Math.min(3, pose.frame);
    const base = standing(look, { act: 'hit', frame: 0, weapon: null });
    const a = [0.35, 0.8, 1.25, Math.PI / 2][t] * dir;
    let parts = fall(base, a, t === 3 ? 0.12 : 0.06);
    if (t >= 2) parts = floor(parts, 0.06);
    if (pose.act === 'lying') parts = shift(parts, [dir * 0.85, 0, 0]);
    return parts;
  }
  return standing(look, pose);
}

// ---------------------------------------------------------------- raster

function shadeHex(c: number, f: number): number {
  const r = Math.min(255, ((c >> 16) & 255) * f) | 0, g = Math.min(255, ((c >> 8) & 255) * f) | 0, b = Math.min(255, (c & 255) * f) | 0;
  return (r << 16) | (g << 8) | b;
}

function hash3(x: number, y: number, z: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise3(x: number, y: number, z: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf), sz = zf * zf * (3 - 2 * zf);
  let v = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz);
    v += w * hash3(xi + dx, yi + dy, zi + dz, s);
  }
  return v;
}

const LIGHT: V3 = norm([-0.55, -0.45, 0.8]);
const BLOOD_FRESH = 0x8a1c1c, BLOOD_DRY = 0x4e1a16;

interface Prim {
  // world-frame ellipsoid, yawed by `yaw`
  cx: number; cy: number; cz: number;
  a: number; b: number; h: number;
  m: Mat;
  // body-frame centre, for stable stain patterns across headings
  bf: V3;
}

export interface RenderOpts {
  w: number;
  h: number;
  ox: number;
  oy: number;
  /** blood pool decal under a body: radius in metres, centre in body frame */
  pool?: { c: V3; r: number };
}

/** Rasterise a rig at heading `dir` (0..7). */
export function rasterise(parts: Part[], dir: number, look: Look, opts: RenderOpts): Raster {
  const { w, h, ox, oy } = opts;
  const yaw = (dir * Math.PI) / 4;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const toWorld = (p: V3): V3 => [p[0] * cy - p[1] * sy, p[0] * sy + p[1] * cy, p[2]];
  const minR = 0.72 / ART_PPM;

  const prims: Prim[] = [];
  const dots: { p: V3; m: Mat }[] = [];
  for (const p of parts) {
    if (p.k === 'ell') {
      const c = toWorld(p.c);
      prims.push({ cx: c[0], cy: c[1], cz: c[2], a: Math.max(minR, p.r[0]), b: Math.max(minR, p.r[1]), h: Math.max(minR, p.r[2]), m: p.m, bf: p.c });
    } else if (p.k === 'cap') {
      const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]);
      const n = Math.max(1, Math.ceil(len / (0.35 / ART_PPM)));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const q = lerp3(p.a, p.b, t);
        const c = toWorld(q);
        const r = Math.max(minR, p.ra + (p.rb - p.ra) * t);
        prims.push({ cx: c[0], cy: c[1], cz: c[2], a: r, b: r, h: r, m: p.m, bf: q });
      }
    } else dots.push({ p: toWorld(p.c), m: p.m });
  }

  const N = w * h;
  const depth = new Float32Array(N).fill(-Infinity);
  const col = new Int32Array(N).fill(-1);
  const C = CHEAT;
  for (const pr of prims) {
    const R = Math.max(pr.a, pr.b);
    const sx0 = Math.floor(ox + (pr.cx - R) * ART_PPM), sx1 = Math.ceil(ox + (pr.cx + R) * ART_PPM);
    const sy0 = Math.floor(oy + (pr.cy - C * pr.cz - R - C * pr.h) * ART_PPM), sy1 = Math.ceil(oy + (pr.cy - C * pr.cz + R + C * pr.h) * ART_PPM);
    const isSphere = pr.a === pr.b;
    const cyaw = isSphere ? 1 : cy, syaw = isSphere ? 0 : sy;
    const ia2 = 1 / (pr.a * pr.a), ib2 = 1 / (pr.b * pr.b), ih2 = 1 / (pr.h * pr.h);
    for (let py = Math.max(0, sy0); py < Math.min(h, sy1); py++) {
      const y = (py + 0.5 - oy) / ART_PPM;
      for (let px = Math.max(0, sx0); px < Math.min(w, sx1); px++) {
        const x = (px + 0.5 - ox) / ART_PPM;
        const dx = x - pr.cx;
        const e = y + C * pr.cz - pr.cy;
        const U0 = dx * cyaw + e * syaw, Us = C * syaw;
        const V0 = -dx * syaw + e * cyaw, Vs = C * cyaw;
        const A = Us * Us * ia2 + Vs * Vs * ib2 + ih2;
        const B = 2 * (U0 * Us * ia2 + V0 * Vs * ib2);
        const Cq = U0 * U0 * ia2 + V0 * V0 * ib2 - 1;
        const disc = B * B - 4 * A * Cq;
        if (disc < 0) continue;
        const t = (-B + Math.sqrt(disc)) / (2 * A);
        const Z = pr.cz + t, Y = y + C * Z;
        const d = C * Y + Z;
        const i = py * w + px;
        if (d <= depth[i]) continue;
        depth[i] = d;
        // normal
        const u = U0 + t * Us, v = V0 + t * Vs;
        const nu = u * ia2, nv = v * ib2, nz = t * ih2;
        const nx = nu * cyaw - nv * syaw, ny = nu * syaw + nv * cyaw;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const lam = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / nl;
        let c = pr.m.col;
        if (look.blood > 0 || look.torn > 0) c = stain(pr, look, x, Y, Z, yaw, c);
        const tone = lam > 0.6 ? 1.12 : lam > 0.25 ? 1 : lam > -0.1 ? 0.86 : 0.72;
        col[i] = shadeHex(c, tone);
      }
    }
  }
  // single-pixel details sit on whatever surface is in front of them
  for (const d of dots) {
    const px = Math.floor(ox + d.p[0] * ART_PPM), py = Math.floor(oy + (d.p[1] - C * d.p[2]) * ART_PPM);
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const i = py * w + px;
    const dd = C * d.p[1] + d.p[2];
    if (dd >= depth[i] - 0.06) col[i] = d.m.col;
  }

  const rgba = new Uint8ClampedArray(N * 4);
  if (opts.pool) {
    const pc = toWorld(opts.pool.c);
    const r = opts.pool.r;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const x = (px + 0.5 - ox) / ART_PPM - pc[0], y = (py + 0.5 - oy) / ART_PPM - pc[1];
      const n = noise3(x * 5, y * 5, 0, look.seed + 7);
      const dist = Math.hypot(x / 1.15, y) / r;
      if (dist < 0.55 + n * 0.6) {
        const i = (py * w + px) * 4;
        const dry = dist > 0.75 + n * 0.2;
        const c = dry ? BLOOD_DRY : n > 0.75 ? 0x9a2a24 : BLOOD_FRESH;
        rgba[i] = c >> 16; rgba[i + 1] = (c >> 8) & 255; rgba[i + 2] = c & 255; rgba[i + 3] = dry ? 200 : 235;
      }
    }
  }
  const op = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && col[y * w + x] >= 0;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const k = py * w + px;
    let c = col[k];
    if (c < 0) continue;
    // a 1-px darker edge on the shadow (south-east) side, a lit edge to the north-west
    if (!op(px + 1, py) || !op(px, py + 1)) c = shadeHex(c, 0.74);
    else if (!op(px - 1, py) || !op(px, py - 1)) c = shadeHex(c, 1.1);
    const i = k * 4;
    rgba[i] = c >> 16; rgba[i + 1] = (c >> 8) & 255; rgba[i + 2] = c & 255; rgba[i + 3] = 255;
  }
  return { w, h, ox, oy, rgba };
}

/** Blood and torn cloth, patterned in the body frame so stains stay put as people turn. */
function stain(pr: Prim, look: Look, x: number, Y: number, Z: number, yaw: number, c: number): number {
  // back to body frame
  const wx = x, wy = Y;
  const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
  const f = wx * cy - wy * sy, s = wx * sy + wy * cy;
  const n = noise3(f * 14, s * 14, Z * 14, look.seed);
  const front = f > (pr.bf[0] + 0.02) ? 0.22 : 0;
  const chest = Z > 1.0 && Z < 1.55 ? 0.12 : 0;
  if (pr.m.cloth && n + front + chest > 1.15 - look.blood * 0.4) return n > 0.66 ? BLOOD_DRY : BLOOD_FRESH;
  // on skin, mostly around the mouth and hands
  if (pr.m.skin && n + front * 1.5 > 1.3 - look.blood * 0.3) return BLOOD_FRESH;
  if (pr.m.cloth && look.torn > 0) {
    const t = noise3(f * 20 + 31, s * 20, Z * 20, look.seed + 3);
    if (t > 1 - look.torn * 0.3) return look.skin;
    if (t < look.torn * 0.12) return shadeHex(c, 0.78);
  }
  return c;
}

// ---------------------------------------------------------------- looks

const CIV_TOPS = [0x7a8fa8, 0xa8574a, 0xc2b07a, 0x6f8a5c, 0x8a6e9c, 0xcfcabc, 0x5a6670, 0xb07a4a];
const CIV_PANTS = [0x3e4f6c, 0x4a4440, 0x6a6252, 0x2e3440, 0x5a4a3c];
const HAIR = [0x2a2018, 0x5a3a22, 0x9a8458, 0x6a6660, 0x2e2a28, 0x7a4a2a];
const Z_SKIN = [0xa3b38e, 0xb0b59a, 0x9cac90, 0xa8b092];

export function survivorLook(): Look {
  return {
    skin: 0xd9a77c, hair: 0x4a3020, top: 0x2f86b0, pants: 0x34465e, shoes: 0x3a2e28,
    pack: 0xc8742e, zombie: false, lean: 0, build: 1, blood: 0, torn: 0, seed: 1,
  };
}

export type BodyKind = 'civilian' | 'soldier' | 'police' | 'runner' | 'survivor';

export function zombieLook(kind: BodyKind, variant: number): Look {
  const v = variant;
  const base: Look = {
    skin: kind === 'runner' ? 0xb3b6a0 : Z_SKIN[v % Z_SKIN.length],
    hair: HAIR[(v * 7 + 1) % HAIR.length],
    top: dirty(CIV_TOPS[(v * 5 + 2) % CIV_TOPS.length]),
    pants: CIV_PANTS[(v * 3) % CIV_PANTS.length],
    shoes: 0x2e2824, zombie: true, lean: 0.75, build: 1, blood: 0.55 + (v % 3) * 0.12, torn: 0.5 + (v % 2) * 0.3, seed: 11 + v * 17,
  };
  if (kind === 'runner') return { ...base, lean: 1.0, build: 0.82, torn: 0.9, top: dirty(CIV_TOPS[(v * 3 + 6) % CIV_TOPS.length]) };
  if (kind === 'soldier') return { ...base, top: 0x56603a, pants: 0x4c5434, shoes: 0x2a2620, hat: { kind: 'helmet', col: 0x4a5232 }, vest: 0x646a44, sling: v % 2 === 0, torn: 0.3, lean: 0.6 };
  if (kind === 'police') return { ...base, top: 0x2b3a5c, pants: 0x25304a, shoes: 0x1e1e22, hat: v % 2 ? { kind: 'cap', col: 0x232c44 } : undefined, vest: v % 3 === 0 ? undefined : 0xbfc43e, torn: 0.35 };
  if (kind === 'survivor') return survivorLook();
  return base;
}

export function corpseLook(kind: BodyKind, variant: number): Look {
  if (kind === 'survivor') return { ...survivorLook(), skin: 0xb8a088, blood: 0.5, seed: 5 };
  const z = zombieLook(kind, variant);
  // the long dead: greyer skin, not as torn as walkers
  return { ...z, zombie: false, skin: 0xa89c88, torn: z.torn * 0.4, blood: 0.6 };
}

function dirty(c: number): number {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const l = (r + g + b) / 3;
  const k = 0.7;
  return (((r * k + l * (1 - k)) * 0.9) << 16) | (((g * k + l * (1 - k)) * 0.88) << 8) | ((b * k + l * (1 - k)) * 0.8);
}

/** Standing figure frames: 32 x 28 art px (16 x 24 figure frame plus room for weapons), feet at (16, 25). */
export const FIGURE = { w: 32, h: 28, ox: 16, oy: 25 };
/** Bodies lying flat: 36 x 30 px, centred. */
export const LYING = { w: 36, h: 30, ox: 18, oy: 17 };
/** Falling over: room for a 1.8 m body in any direction from the feet. */
export const FALLING = { w: 44, h: 42, ox: 22, oy: 23 };

export function renderPerson(look: Look, pose: Pose, dir: number): Raster {
  const parts = rig(look, pose);
  if (pose.act === 'lying') return rasterise(parts, dir, look, { ...LYING, pool: { c: [0.1, 0.05, 0], r: 0.5 } });
  if (pose.act === 'death') {
    const back = look.zombie ? 1 : -1;
    return rasterise(parts, dir, look, { ...FALLING, pool: pose.frame >= 3 ? { c: [back * 0.75, 0.05, 0], r: 0.4 } : undefined });
  }
  return rasterise(parts, dir, look, FIGURE);
}

/** Snap a heading angle (radians, screen space) to one of 8 directions. */
export function headingIndex(angle: number): number {
  return ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
}
