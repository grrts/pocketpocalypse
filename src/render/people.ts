// People, zombies and corpses, built as a tiny 3D rig of ellipsoids and
// capsules and rasterised straight onto the art-pixel grid (11 px per metre,
// docs/ART_STYLE.md section 3) for each of 8 headings. Nothing is rotated at
// draw time, so pixels stay crisp in every direction.
//
// Arcade look (ART_STYLE.md section 0): figures are built at real proportions
// with a slightly big head and chunky limbs, then blown up by BODY_SCALE
// (1.25x) so they read on a phone. Shading is flat cel tones (light, base,
// shadow) and every figure gets a 1-art-pixel #1b1a2e outline, with inner
// lines where a limb crosses in front of the body.
//
// Projection is the game's top-down view with a 3/4 cheat: a point at ground
// position (x, y) and height z lands on screen at (x, y - CHEAT * z). Each
// screen pixel casts a ray into the rig and keeps the nearest surface, which
// gives correct overlap (arm in front of torso, head over shoulders) and a
// per-pixel normal for the north-west sun. Pure code: returns RGBA buffers.

export const ART_PPM = 11;
/** How far up the screen one metre of height is drawn. */
export const CHEAT = 0.88;
/** People are drawn this much bigger than life so they read on a phone. */
export const BODY_SCALE = 1.25;
/** Outline colour for everything that stands up. */
export const OUTLINE = 0x1b1a2e;

export type Heading = number; // 0..7, 0 = east, 2 = south (screen y down), clockwise

type V3 = [number, number, number]; // body frame: forward, right, up (metres)

interface Mat {
  col: number; // 0xRRGGBB
  /** clothing that can be torn/bloodied, skin that can be bloodied */
  cloth?: boolean;
  skin?: boolean;
  /** drawn flat, no light/shade (eyes, glow) */
  flat?: boolean;
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
  hat?: { kind: 'cap' | 'helmet' | 'band'; col: number };
  vest?: number;
  /** a stripe across the vest (police) */
  stripe?: number;
  /** slung rifle on the back */
  sling?: boolean;
  /** bare shins (runners in shorts) */
  shorts?: boolean;
  /** eye colour; zombies glow */
  eyes?: number;
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
  const wood = { col: 0xb07a44 }, steel = { col: 0xd4dce6 }, dark = { col: 0x3a3c48 }, grip = { col: 0x3a2a26 };
  switch (kind) {
    case 'knife':
      out.push({ k: 'cap', a: at(-0.04), b: at(0.06), ra: 0.035, rb: 0.035, m: grip });
      out.push({ k: 'cap', a: at(0.07), b: at(0.28), ra: 0.04, rb: 0.025, m: steel });
      break;
    case 'machete':
      out.push({ k: 'cap', a: at(-0.05), b: at(0.07), ra: 0.035, rb: 0.035, m: grip });
      out.push({ k: 'cap', a: at(0.08), b: at(0.55), ra: 0.04, rb: 0.05, m: steel });
      break;
    case 'hammer':
      out.push({ k: 'cap', a: at(-0.06), b: at(0.3), ra: 0.035, rb: 0.035, m: wood });
      out.push({ k: 'cap', a: add(at(0.32), [0, -0.07, 0]), b: add(at(0.32), [0, 0.08, 0]), ra: 0.055, rb: 0.055, m: dark });
      break;
    case 'crowbar':
      out.push({ k: 'cap', a: at(-0.1), b: at(0.62), ra: 0.035, rb: 0.035, m: { col: 0xd8372c } });
      out.push({ k: 'cap', a: at(0.62), b: add(at(0.66), [0, 0.07, -0.05]), ra: 0.035, rb: 0.035, m: { col: 0xd8372c } });
      break;
    case 'bat':
      out.push({ k: 'cap', a: at(-0.08), b: at(0.8), ra: 0.035, rb: 0.07, m: { col: 0xd8a868 } });
      break;
    case 'hockey':
      out.push({ k: 'cap', a: at(-0.1), b: at(0.8), ra: 0.035, rb: 0.035, m: { col: 0x3a7ae0 } });
      out.push({ k: 'cap', a: at(0.8), b: add(at(0.84), [0.09, 0.09, 0]), ra: 0.05, rb: 0.05, m: { col: 0x3a7ae0 } });
      break;
    case 'axe':
      out.push({ k: 'cap', a: at(-0.08), b: at(0.7), ra: 0.035, rb: 0.035, m: wood });
      out.push({ k: 'ell', c: add(at(0.66), [0, 0.08, 0]), r: [0.06, 0.1, 0.075], m: { col: 0xe0402e } });
      break;
    case 'pistol':
      out.push({ k: 'cap', a: at(0), b: at(0.2), ra: 0.045, rb: 0.04, m: dark });
      break;
    case 'rifle':
      out.push({ k: 'cap', a: at(-0.28), b: at(0.12), ra: 0.05, rb: 0.04, m: { col: 0x6a4a2e } });
      out.push({ k: 'cap', a: at(0.12), b: at(0.6), ra: 0.04, rb: 0.035, m: dark });
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
  let stride = 0, lift = 0, bob = 0, sway = 0, step = 0, twist = 0;
  let footL: V3 = [0.02, -0.11, 0.06], footR: V3 = [-0.02, 0.11, 0.06];
  const hip = 0.8;
  const ph = (frame % 4) * (Math.PI / 2) + Math.PI / 4;
  if (act === 'walk' || act === 'run' || act === 'shamble') {
    stride = act === 'run' ? 0.36 : act === 'shamble' ? 0.2 : 0.25;
    lift = act === 'run' ? 0.2 : act === 'shamble' ? 0.04 : 0.1;
    const sL = Math.sin(ph), cL = Math.cos(ph);
    footL = [stride * sL, -0.11, 0.06 + lift * Math.max(0, cL)];
    footR = [-stride * sL, 0.11, 0.06 + lift * Math.max(0, -cL)];
    if (act === 'shamble') {
      // one leg drags: the right foot barely lifts and trails
      footR = [-stride * 0.6 * sL - 0.08, 0.13, 0.06];
      sway = 0.07 * Math.cos(ph);
    }
    bob = act === 'run' ? 0.05 * Math.abs(cL) - 0.04 : -0.035 * Math.abs(sL);
    if (act === 'walk') sway = 0.035 * cL;
    if (act === 'run') lean += 0.3;
  }
  if (act === 'idle') bob = frame % 2 ? -0.03 : 0;
  if (act === 'hit') {
    lean -= 0.45;
    bob = 0.03;
    footL = [0.12, -0.13, 0.06];
  }
  if (act === 'lunge') {
    lean += [0.05, 0.7, 0.55][frame % 3];
    step = [-0.06, 0.16, 0.12][frame % 3];
    footL = [0.22 * (frame % 3 ? 1 : 0), -0.12, 0.06];
  }
  if (act === 'attack' && weapon !== 'pistol' && weapon !== 'rifle') {
    // a big readable swing: lean back on the wind-up, step into the hit
    const f = frame % 3;
    lean += [-0.25, 0.35, 0.2][f];
    step = [-0.05, 0.12, 0.08][f];
    twist = [0.12, -0.06, -0.12][f];
    footL = [[0.0, 0.26, 0.22][f], -0.12, 0.06];
  }

  const fwd = (z: number) => lean * 0.34 * Math.max(0, z - 0.85) + step * Math.min(1, z / 0.9);
  const hipZ = hip + bob;
  const at = (f: number, s: number, z: number): V3 => {
    const tw = twist * Math.max(0, (z - 0.9) / 0.6);
    return [f + fwd(z) - s * tw, s + sway * (z / 1.6) + f * tw, z + bob - Math.max(0, lean) * 0.12 * Math.max(0, z - 1.0)];
  };

  // legs: thigh and shin, knees bend forward
  const shin: Mat = look.shorts ? skin : pants;
  for (const [hp, ft] of [[at(0, -0.1, hipZ), footL], [at(0, 0.1, hipZ), footR]] as [V3, V3][]) {
    const m = lerp3(hp, ft, 0.5);
    const knee: V3 = [m[0] + 0.05 + (ft[2] - 0.06) * 0.6, m[1], m[2] + (ft[2] - 0.06) * 0.4];
    out.push({ k: 'cap', a: hp, b: knee, ra: 0.1, rb: 0.085, m: pants });
    out.push({ k: 'cap', a: knee, b: ft, ra: 0.08, rb: 0.075, m: shin });
    out.push({ k: 'ell', c: add(ft, [0.06, 0, -0.01]), r: [0.11, 0.065, 0.055], m: shoes });
  }
  // pelvis, torso
  out.push({ k: 'ell', c: at(0, 0, hipZ + 0.05), r: [0.13, 0.18 * W, 0.11], m: pants });
  const chest = at(0, 0, 1.2);
  out.push({ k: 'ell', c: chest, r: [0.17, 0.23 * W, 0.27], m: top });
  if (look.vest !== undefined) {
    out.push({ k: 'ell', c: at(0, 0, 1.24), r: [0.18, 0.24 * W, 0.22], m: { col: look.vest, cloth: true } });
    if (look.stripe !== undefined) out.push({ k: 'ell', c: at(0, 0, 1.12), r: [0.185, 0.245 * W, 0.04], m: { col: look.stripe } });
  }
  if (look.pack !== undefined) {
    out.push({ k: 'ell', c: at(-0.21, 0, 1.24), r: [0.11, 0.17, 0.22], m: { col: look.pack } });
    out.push({ k: 'ell', c: at(-0.23, 0, 1.45), r: [0.08, 0.15, 0.06], m: { col: shadeHex(look.pack, 0.78) } });
    out.push({ k: 'ell', c: at(-0.3, 0, 1.18), r: [0.04, 0.12, 0.09], m: { col: shadeHex(look.pack, 0.82) } });
    // shoulder straps seen from the front
    for (const s of [-0.11, 0.11]) for (const z of [1.4, 1.32, 1.24, 1.16]) out.push({ k: 'dot', c: at(0.14, s * W, z), m: { col: shadeHex(look.pack, 0.7) } });
  }
  if (look.sling) out.push({ k: 'cap', a: at(-0.17, 0.22, 1.45), b: at(-0.17, -0.2, 0.92), ra: 0.035, rb: 0.035, m: { col: 0x2f3226 } });
  // head: a bit big, like every arcade hero
  const headLean = look.zombie ? 0.12 + lean * 0.1 : 0.02;
  const head = at(headLean, 0, 1.63 - (look.zombie ? 0.05 + lean * 0.06 : 0));
  const HR: V3 = [0.165, 0.16, 0.17];
  out.push({ k: 'ell', c: head, r: HR, m: skin });
  if (look.hat?.kind === 'helmet') {
    out.push({ k: 'ell', c: add(head, [-0.02, 0, 0.06]), r: [0.185, 0.18, 0.13], m: { col: look.hat.col } });
  } else {
    // zombies' hair is thin and pushed back so the green scalp shows
    if (look.zombie) {
      if (look.seed % 2) out.push({ k: 'ell', c: add(head, [-0.09, 0, 0.03]), r: [0.1, 0.145, 0.11], m: { col: look.hair } });
    } else out.push({ k: 'ell', c: add(head, [-0.05, 0, 0.045]), r: [0.15, 0.165, 0.14], m: { col: look.hair } });
    if (look.hat?.kind === 'cap') {
      out.push({ k: 'ell', c: add(head, [-0.06, 0, 0.12]), r: [0.12, 0.145, 0.07], m: { col: look.hat.col } });
      out.push({ k: 'ell', c: add(head, [0.07, 0, 0.15]), r: [0.07, 0.11, 0.022], m: { col: shadeHex(look.hat.col, 0.75) } });
    } else if (look.hat?.kind === 'band') {
      out.push({ k: 'ell', c: add(head, [0, 0, 0.06]), r: [0.155, 0.152, 0.03], m: { col: look.hat.col } });
    }
  }
  // eyes (and a zombie's gory mouth)
  const eye = look.eyes ?? 0x2a2038;
  out.push({ k: 'dot', c: add(head, [0.155, -0.06, 0.0]), m: { col: eye, flat: true } });
  out.push({ k: 'dot', c: add(head, [0.155, 0.06, 0.0]), m: { col: eye, flat: true } });
  if (look.zombie) out.push({ k: 'dot', c: add(head, [0.13, 0, -0.1]), m: { col: 0x8a0f1a, flat: true } });

  // arms
  const shL = at(0.0, -0.25 * W, 1.38), shR = at(0.0, 0.25 * W, 1.38);
  let hL: V3, hR: V3;
  let wDir: V3 | null = null;
  const swing = Math.sin(ph) * (act === 'run' ? 0.3 : 0.18);
  if (look.zombie) {
    const reach = act === 'lunge' ? [0.2, 0.7, 0.6][frame % 3] : 0.48;
    const bobA = act === 'shamble' ? 0.06 * Math.sin(ph) : 0;
    const zA = act === 'lunge' ? [1.55, 1.36, 1.22][frame % 3] : 1.3;
    const spread = act === 'lunge' ? [0.26, 0.2, 0.08][frame % 3] : 0.15;
    hL = at(reach + bobA, -spread, zA + bobA);
    hR = at(reach - bobA, spread, zA - 0.05 - bobA);
    if (act === 'run') {
      // runners sprint with arms flung back, then claw forward
      hL = at(-swing * 1.2 + 0.1, -0.24, 1.1);
      hR = at(swing * 1.2 + 0.1, 0.24, 1.1);
    }
    if (act === 'hit') {
      hL = at(0.05, -0.4, 1.55);
      hR = at(0.0, 0.42, 1.6);
    }
  } else if (act === 'hit') {
    hL = at(0.05, -0.4, 1.55);
    hR = at(0.05, 0.4, 1.55);
  } else if (act === 'attack') {
    const f = frame % 3;
    if (!weapon) {
      // a haymaker
      hL = at(0.22, -0.18, 1.34);
      hR = [at(-0.12, 0.28, 1.3), at(0.62, 0.04, 1.4), at(0.38, -0.08, 1.28)][f];
    } else if (weapon === 'pistol') {
      const k = f === 0 ? -0.08 : 0;
      hL = at(0.44 + k, -0.03, 1.38 - k);
      hR = at(0.46 + k, 0.05, 1.38 - k);
      wDir = [1, 0, f === 0 ? 0.45 : 0];
    } else if (weapon === 'rifle') {
      const k = f === 0 ? -0.08 : 0;
      hR = at(0.16 + k, 0.13, 1.36);
      hL = at(0.48 + k, -0.03, 1.38);
      wDir = [1, -0.12, f === 0 ? 0.18 : 0];
    } else {
      // wind-up high behind the shoulder, smash straight ahead, follow through low across
      hR = [at(-0.18, 0.34, 1.62), at(0.55, 0.06, 1.32), at(0.3, -0.32, 1.0)][f];
      wDir = [[-0.55, 0.35, 0.8], [1, -0.05, 0.02], [0.35, -0.85, -0.45]][f] as V3;
      hL = TWO_HANDED.has(weapon) ? add(hR, scale(norm(wDir), -0.14)) : at(0.12, -0.28, 1.05);
    }
  } else if (weapon === 'pistol') {
    hL = at(0.4, -0.03, 1.32);
    hR = at(0.42, 0.05, 1.32);
    wDir = [1, 0, 0];
  } else if (weapon === 'rifle') {
    hR = at(0.16, 0.13, 1.3);
    hL = at(0.46, -0.03, 1.32);
    wDir = [1, -0.12, 0];
  } else {
    hL = at(-swing, -0.3 * W, 0.98);
    hR = at(swing, 0.3 * W, 0.98);
    if (act === 'run') {
      hL = at(-swing + 0.1, -0.24, 1.14);
      hR = at(swing + 0.1, 0.24, 1.14);
    }
    if (weapon) {
      hR = at(0.18 + swing * 0.3, 0.26, 1.05);
      // long weapons rest back over the shoulder, short ones point ahead
      wDir = TWO_HANDED.has(weapon) ? [-0.45, 0.12, 0.85] : [0.8, 0.05, 0.25];
      if (TWO_HANDED.has(weapon)) hR = at(0.16 + swing * 0.3, 0.24, 1.2);
    }
  }
  const elbow = (sh: V3, h: V3, side: number): V3 => {
    const m = lerp3(sh, h, 0.5);
    return [m[0] - 0.04, m[1] + side * 0.05, m[2] - 0.04];
  };
  const eL = elbow(shL, hL, -1), eR = elbow(shR, hR, 1);
  // zombies show green arms: forearms always bare, the whole arm when badly torn
  const sleeve = look.zombie ? skin : top;
  const upper = look.zombie && look.torn > 0.6 ? skin : top;
  out.push({ k: 'cap', a: shL, b: eL, ra: 0.085, rb: 0.075, m: upper });
  out.push({ k: 'cap', a: eL, b: hL, ra: 0.075, rb: 0.068, m: sleeve });
  out.push({ k: 'cap', a: shR, b: eR, ra: 0.085, rb: 0.075, m: upper });
  out.push({ k: 'cap', a: eR, b: hR, ra: 0.075, rb: 0.068, m: sleeve });
  out.push({ k: 'ell', c: hL, r: [0.07, 0.065, 0.065], m: skin });
  out.push({ k: 'ell', c: hR, r: [0.07, 0.065, 0.065], m: skin });
  if (weapon && wDir) weaponParts(weapon, hR, wDir, out);
  return out;
}

function feeding(look: Look, frame: number): Part[] {
  const out: Part[] = [];
  const skin: Mat = { col: look.skin, skin: true }, top: Mat = { col: look.top, cloth: true }, pants: Mat = { col: look.pants, cloth: true };
  const dip = frame % 2 ? 0.09 : 0;
  for (const s of [-0.11, 0.11]) {
    const hip: V3 = [0, s, 0.45], knee: V3 = [0.3, s * 1.2, 0.09], foot: V3 = [-0.22, s, 0.06];
    out.push({ k: 'cap', a: hip, b: knee, ra: 0.095, rb: 0.085, m: pants });
    out.push({ k: 'cap', a: knee, b: foot, ra: 0.085, rb: 0.075, m: look.shorts ? skin : pants });
    out.push({ k: 'ell', c: [-0.27, s, 0.06], r: [0.11, 0.065, 0.055], m: { col: look.shoes } });
  }
  out.push({ k: 'ell', c: [0.18, 0, 0.64 - dip], r: [0.21, 0.22 * look.build, 0.19], m: top });
  if (look.vest !== undefined) out.push({ k: 'ell', c: [0.19, 0, 0.66 - dip], r: [0.205, 0.215 * look.build, 0.14], m: { col: look.vest, cloth: true } });
  const head: V3 = [0.45, 0, 0.58 - dip * 1.5];
  out.push({ k: 'ell', c: head, r: [0.145, 0.14, 0.15], m: skin });
  if (look.hat?.kind === 'helmet') out.push({ k: 'ell', c: add(head, [-0.04, 0, 0.06]), r: [0.16, 0.16, 0.11], m: { col: look.hat.col } });
  else out.push({ k: 'ell', c: add(head, [-0.05, 0, 0.06]), r: [0.13, 0.145, 0.11], m: { col: look.hair } });
  for (const s of [-1, 1]) {
    const sh: V3 = [0.28, s * 0.21, 0.74 - dip], h: V3 = [0.58, s * 0.14, 0.14 + (s > 0 ? dip * 1.5 : 0)];
    out.push({ k: 'cap', a: sh, b: h, ra: 0.08, rb: 0.07, m: look.zombie ? skin : top });
    out.push({ k: 'ell', c: h, r: [0.07, 0.065, 0.065], m: skin });
  }
  // what they're eating: a red mess under the hands
  out.push({ k: 'ell', c: [0.62, 0, 0.04], r: [0.16, 0.2, 0.04], m: { col: 0xb81c26 } });
  out.push({ k: 'dot', c: [0.6, -0.1, 0.09], m: { col: 0xf0e2d0, flat: true } });
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
    const base = standing({ ...look, lean: 0 }, { act: 'hit', frame: 0, weapon: null });
    const a = [0.45, 1.0, Math.PI / 2 + 0.1, Math.PI / 2][t] * dir;
    let parts = fall(base, a, t >= 2 ? 0.14 : 0.06);
    if (t >= 2) parts = floor(parts, 0.07);
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

function mixHex(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t;
  const g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t;
  const bl = (a & 255) * (1 - t) + (b & 255) * t;
  return ((r | 0) << 16) | ((g | 0) << 8) | (bl | 0);
}

/** Cel tones: a warm light, the base, and a cool violet-tinged shadow. */
const lightTone = (c: number) => mixHex(c, 0xfff6dc, 0.28);
const shadowTone = (c: number) => mixHex(shadeHex(c, 0.78), 0x2a2250, 0.16);

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
/** Arcade gore: bright red with a dark core, much louder than real blood. */
const GORE = 0xd0202c, GORE_DARK = 0x7e0e1c, GORE_WET = 0xf0483e;
const POOL = 0xb0161f, POOL_DARK = 0x6e0c16, POOL_RIM = 0x4a0a14;

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
  /** white hit flash: the whole figure inside its outline goes white */
  flash?: boolean;
  /** size factor (BODY_SCALE by default) */
  scale?: number;
}

/** Rasterise a rig at heading `dir` (0..7). */
export function rasterise(parts: Part[], dir: number, look: Look, opts: RenderOpts): Raster {
  const { w, h, ox, oy } = opts;
  const S = opts.scale ?? BODY_SCALE;
  const yaw = (dir * Math.PI) / 4;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const toWorld = (p: V3): V3 => [(p[0] * cy - p[1] * sy) * S, (p[0] * sy + p[1] * cy) * S, p[2] * S];
  const minR = 0.72 / ART_PPM;

  const prims: Prim[] = [];
  const dots: { p: V3; m: Mat }[] = [];
  for (const p of parts) {
    if (p.k === 'ell') {
      const c = toWorld(p.c);
      prims.push({ cx: c[0], cy: c[1], cz: c[2], a: Math.max(minR, p.r[0] * S), b: Math.max(minR, p.r[1] * S), h: Math.max(minR, p.r[2] * S), m: p.m, bf: p.c });
    } else if (p.k === 'cap') {
      const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) * S;
      const n = Math.max(1, Math.ceil(len / (0.5 / ART_PPM)));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const q = lerp3(p.a, p.b, t);
        const c = toWorld(q);
        const r = Math.max(minR, (p.ra + (p.rb - p.ra) * t) * S);
        prims.push({ cx: c[0], cy: c[1], cz: c[2], a: r, b: r, h: r, m: p.m, bf: q });
      }
    } else dots.push({ p: toWorld(p.c), m: p.m });
  }

  const N = w * h;
  const depth = new Float32Array(N).fill(-Infinity);
  const col = new Int32Array(N).fill(-1);
  // the nearest surface per pixel: which primitive, its height, and a cel tone;
  // colours (and the costly stain noise) are worked out once per pixel afterwards
  const win = new Int32Array(N).fill(-1);
  const hitZ = new Float32Array(N), tone = new Uint8Array(N);
  const C = CHEAT;
  for (let pi = 0; pi < prims.length; pi++) {
    const pr = prims[pi];
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
        win[i] = pi;
        hitZ[i] = Z;
        if (pr.m.flat) {
          tone[i] = 1;
          continue;
        }
        // normal
        const u = U0 + t * Us, v = V0 + t * Vs;
        const nu = u * ia2, nv = v * ib2, nz = t * ih2;
        const nx = nu * cyaw - nv * syaw, ny = nu * syaw + nv * cyaw;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const lam = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / nl;
        tone[i] = lam > 0.55 ? 0 : lam > -0.05 ? 1 : 2;
      }
    }
  }
  const stained = look.blood > 0 || look.torn > 0;
  for (let i = 0; i < N; i++) {
    if (win[i] < 0) continue;
    const pr = prims[win[i]];
    let c = pr.m.col;
    if (!pr.m.flat && stained) {
      const Z = hitZ[i];
      const x = ((i % w) + 0.5 - ox) / ART_PPM, Y = (Math.floor(i / w) + 0.5 - oy) / ART_PPM + C * Z;
      c = stain(pr, look, x / S, Y / S, Z / S, yaw, c);
    }
    const t = tone[i];
    col[i] = t === 0 ? lightTone(c) : t === 1 ? c : shadowTone(c);
  }
  // single-pixel details sit on whatever surface is in front of them
  for (const d of dots) {
    const px = Math.floor(ox + d.p[0] * ART_PPM), py = Math.floor(oy + (d.p[1] - C * d.p[2]) * ART_PPM);
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const i = py * w + px;
    const dd = C * d.p[1] + d.p[2];
    if (dd >= depth[i] - 0.08 * S) col[i] = d.m.col;
  }

  const rgba = new Uint8ClampedArray(N * 4);
  const put = (k: number, c: number, a = 255) => {
    const i = k * 4;
    rgba[i] = c >> 16; rgba[i + 1] = (c >> 8) & 255; rgba[i + 2] = c & 255; rgba[i + 3] = a;
  };
  if (opts.pool) {
    // a chunky pool: bright red, a darker core, a dark rim
    const pc = toWorld(opts.pool.c);
    const r = opts.pool.r * S;
    const inPool = (px: number, py: number) => {
      const x = (px + 0.5 - ox) / ART_PPM - pc[0], y = (py + 0.5 - oy) / ART_PPM - pc[1];
      const n = noise3(x * 3.2, y * 3.2, 0, look.seed + 7);
      const dist = Math.hypot(x / 1.2, y) / r;
      return dist < 0.6 + n * 0.55 ? (dist < 0.3 + n * 0.2 ? 2 : 1) : 0;
    };
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const v = inPool(px, py);
      if (v) {
        const edge = !inPool(px + 1, py) || !inPool(px, py + 1) || !inPool(px - 1, py) || !inPool(px, py - 1);
        put(py * w + px, edge ? POOL_RIM : v === 2 ? POOL_DARK : POOL, 235);
      }
    }
  }
  const op = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && col[y * w + x] >= 0;
  // inner lines where a nearer part crosses in front of a much deeper one
  const jump = 0.22 * S;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const k = py * w + px;
    let c = col[k];
    if (c < 0) {
      // the outline: any empty pixel touching the figure (4-neighbour, so corners round off)
      if (op(px - 1, py) || op(px + 1, py) || op(px, py - 1) || op(px, py + 1)) put(k, OUTLINE);
      continue;
    }
    const d = depth[k];
    let inner = false;
    if (py > 0 && col[k - w] >= 0 && depth[k - w] - d > jump) inner = true;
    else if (px > 0 && col[k - 1] >= 0 && depth[k - 1] - d > jump) inner = true;
    else if (px < w - 1 && col[k + 1] >= 0 && depth[k + 1] - d > jump) inner = true;
    else if (py < h - 1 && col[k + w] >= 0 && depth[k + w] - d > jump) inner = true;
    if (inner) c = mixHex(OUTLINE, c, 0.3);
    if (opts.flash) c = inner ? mixHex(OUTLINE, 0xfff8f0, 0.55) : 0xfffaf2;
    put(k, c);
  }
  return { w, h, ox, oy, rgba };
}

/** Blood and torn cloth, patterned in the body frame so stains stay put as people turn. */
function stain(pr: Prim, look: Look, x: number, Y: number, Z: number, yaw: number, c: number): number {
  // back to body frame
  const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
  const f = x * cy - Y * sy, s = x * sy + Y * cy;
  // big blobs (about 2-3 art px) so gore reads as shapes, not grain
  const n = noise3(f * 7, s * 7, Z * 7, look.seed);
  const front = f > pr.bf[0] + 0.02 ? 0.2 : 0;
  const chest = Z > 1.0 && Z < 1.5 ? 0.14 : 0;
  if (pr.m.cloth && n + front + chest > 1.12 - look.blood * 0.42) return n > 0.72 ? GORE_DARK : n < 0.45 ? GORE_WET : GORE;
  if (pr.m.skin) {
    // chin and hands get it worst
    const mouth = Z > 1.4 && Z < 1.6 && f > pr.bf[0] + 0.04 ? 0.35 : 0;
    const hand = Z < 1.4 && Z > 0.8 && pr.bf[2] > 0.8 ? 0.12 : 0;
    if (n + front + mouth + hand > 1.25 - look.blood * 0.35) return n > 0.6 ? GORE : GORE_DARK;
  }
  if (pr.m.cloth && look.torn > 0) {
    const t = noise3(f * 9 + 31, s * 9, Z * 9, look.seed + 3);
    if (t > 1 - look.torn * 0.28) return look.skin;
    if (t < look.torn * 0.1) return shadeHex(c, 0.72);
  }
  return c;
}

// ---------------------------------------------------------------- looks

const CIV_TOPS = [0xe0503c, 0x3d86e0, 0xf2c23a, 0x9a5ad6, 0xf08a32, 0x34bfae, 0xe6e0cc, 0xe8649c, 0x5ab84a, 0x7a8aa8];
const CIV_PANTS = [0x4a6ac0, 0x7a5a8e, 0x9a7a50, 0x4a5a8a, 0xa08a62, 0x5e5e70];
const HAIR = [0x2a1e18, 0x6a3e1e, 0xd8b058, 0x8a8478, 0x3a2a28, 0xa8502a];
/** Bright, sickly zombie greens. */
const Z_SKIN = [0x8ccf4a, 0x9ed45a, 0x7cc25e, 0xa8d84e];
const Z_EYES = [0xfff26a, 0xf4ffd0];

export function survivorLook(): Look {
  return {
    skin: 0xf0b88a, hair: 0x4a2e1c, top: 0x2b8ff2, pants: 0x3c5290, shoes: 0xeae4d8,
    pack: 0xf5a82a, hat: { kind: 'cap', col: 0xe8463a }, eyes: 0x2a2038,
    zombie: false, lean: 0, build: 1.04, blood: 0, torn: 0, seed: 1,
  };
}

export type BodyKind = 'civilian' | 'soldier' | 'police' | 'runner' | 'survivor';

export function zombieLook(kind: BodyKind, variant: number): Look {
  const v = variant;
  const base: Look = {
    skin: Z_SKIN[v % Z_SKIN.length],
    hair: HAIR[(v * 7 + 1) % HAIR.length],
    top: dirty(CIV_TOPS[(v * 5 + 2) % CIV_TOPS.length]),
    pants: CIV_PANTS[(v * 3) % CIV_PANTS.length],
    shoes: 0x3a2e2a, eyes: Z_EYES[v % 2],
    zombie: true, lean: 0.75, build: 1.05, blood: 0.6 + (v % 3) * 0.12, torn: 0.5 + (v % 2) * 0.3, seed: 11 + v * 17,
  };
  // runners: lean, pale-lime and fast, in sports kit, with burning red eyes
  if (kind === 'runner') return {
    ...base, skin: 0xc4e070, eyes: 0xff3a2a, lean: 1.0, build: 0.84, torn: 0.7, shorts: true,
    top: [0xff5ab0, 0x2ee6d0, 0xffd23a, 0xff7a2a][v % 4], pants: 0x2a2e48, shoes: 0xeae4d8,
    hat: v % 2 ? { kind: 'band', col: 0xf2f0e6 } : undefined,
  };
  if (kind === 'soldier') return {
    ...base, top: 0xb89a5e, pants: 0x9a7e4a, shoes: 0x3a2e22, hat: { kind: 'helmet', col: 0x7a6a3a }, vest: 0x8a7240,
    sling: v % 2 === 0, torn: 0.3, lean: 0.6, build: 1.12, eyes: 0xf4ffd0,
  };
  if (kind === 'police') return {
    // Dutch politie: navy with a yellow high-vis vest and a blue band
    ...base, top: 0x2f4fa8, pants: 0x26387a, shoes: 0x1e1e28, hat: v % 2 ? { kind: 'cap', col: 0x1e2c62 } : undefined,
    vest: v % 3 === 2 ? undefined : 0xf0e03a, stripe: 0x2a5ae0, torn: 0.35, eyes: 0xf4ffd0,
  };
  if (kind === 'survivor') return survivorLook();
  return base;
}

export function corpseLook(kind: BodyKind, variant: number): Look {
  if (kind === 'survivor') return { ...survivorLook(), skin: 0xd8a888, blood: 0.6, seed: 5 };
  const z = zombieLook(kind, variant);
  // the long dead: a grey-green, still bloody
  return { ...z, zombie: false, skin: mixHex(z.skin, 0xa8a48c, 0.55), torn: z.torn * 0.4, blood: 0.7, eyes: 0x3a2a30 };
}

function dirty(c: number): number {
  // a touch grubbier, but zombies keep bright clothes so they read on the street
  return mixHex(c, 0x7a7060, 0.18);
}

/** Standing figure frames: room for a 1.25x figure, a swung weapon and the outline; feet at (ox, oy). */
export const FIGURE = { w: 62, h: 62, ox: 31, oy: 46 };
/** Bodies lying flat, centred. */
export const LYING = { w: 52, h: 48, ox: 26, oy: 26 };
/** Falling over: room for a 2.25 m body in any direction from the feet. */
export const FALLING = { w: 70, h: 70, ox: 35, oy: 37 };

export interface PersonOpts {
  /** white hit flash */
  flash?: boolean;
}

export function renderPerson(look: Look, pose: Pose, dir: number, o: PersonOpts = {}): Raster {
  const parts = rig(look, pose);
  const flash = !!o.flash;
  if (pose.act === 'lying') return rasterise(parts, dir, look, { ...LYING, pool: { c: [0.15, 0.05, 0], r: 0.55 }, flash });
  if (pose.act === 'death') {
    const back = look.zombie ? 1 : -1;
    return rasterise(parts, dir, look, { ...FALLING, pool: pose.frame >= 3 ? { c: [back * 0.75, 0.05, 0], r: 0.45 } : undefined, flash });
  }
  return rasterise(parts, dir, look, { ...FIGURE, flash });
}

/** Snap a heading angle (radians, screen space) to one of 8 directions. */
export function headingIndex(angle: number): number {
  return ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
}
