// Procedurally drawn pixel-art sprites (no external art assets). Vehicles are
// drawn facing +x and rotated at render time. People, zombies and bodies are
// rasterised per heading on the 11 px/m art grid (see people.ts) and never
// rotated, so they stay crisp.

import type { CorpseKind, VehicleModel, ZombieKind } from '../world/spawnTypes';
import { renderPerson, survivorLook, zombieLook, corpseLook, type Pose, type Raster } from './people';

export type Sprite = HTMLCanvasElement;

/** An art-grid sprite with its anchor (feet for people) in canvas pixels. */
export interface PixelSprite {
  img: HTMLCanvasElement;
  ox: number;
  oy: number;
}

function fromRaster(r: Raster, flash: boolean): PixelSprite {
  const img = document.createElement('canvas');
  img.width = r.w;
  img.height = r.h;
  const g = img.getContext('2d')!;
  g.putImageData(new ImageData(r.rgba as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
  if (flash) {
    // hurt flash: the silhouette goes pale red-white for a moment
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(246,226,218,0.78)';
    g.fillRect(0, 0, r.w, r.h);
  }
  return { img, ox: r.ox, oy: r.oy };
}

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): Sprite {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  draw(g);
  return c;
}

function px(g: CanvasRenderingContext2D, color: string, x: number, y: number, w = 1, h = 1) {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

/** Bright arcade body colours for ordinary cars and vans. */
export const CAR_COLORS = ['#e0403a', '#3a74d8', '#eeeee6', '#41425a', '#b8bcc8', '#4ca85a', '#f2c230', '#f08a30', '#2fb0b0', '#8a5ad0', '#6ab0f0', '#b83a5a'];

const INK = '#1b1a2e';
const GLASS = '#2a3b5c';
const GLINT = '#9cc8ec';

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * f) | 0, gg = Math.min(255, ((n >> 8) & 255) * f) | 0, b = Math.min(255, (n & 255) * f) | 0;
  return `rgb(${r},${gg},${b})`;
}

/** Body length x width in art px (about 11 px per metre, docs/ART_STYLE.md section 3). */
const VEHICLE_PX: Record<VehicleModel, [number, number]> = {
  car: [48, 20], police: [50, 20], van: [57, 22], ambulance: [64, 24], military: [60, 25], truck: [92, 27], bus: [130, 28],
};
/** Room either side of the body for wheels, mirrors and doors hanging open. */
const SIDE_PAD = 9;

/** Same-size canvas, so a shadow drawn with the same scale lines up with its vehicle. */
function vehicleCanvas(model: VehicleModel, draw: (g: CanvasRenderingContext2D, w: number, h: number, y0: number) => void): Sprite {
  const [w, h] = VEHICLE_PX[model];
  return canvas(w + 2, h + SIDE_PAD * 2, (g) => draw(g, w, h, SIDE_PAD));
}

/** Rectangle with its four corner pixels cut, for a rounded chunky look. */
function rounded(g: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number, under?: string) {
  px(g, color, x, y, w, h);
  for (const [cx, cy] of [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]]) {
    if (under) px(g, under, cx, cy);
    else g.clearRect(cx, cy, 1, 1);
  }
}

function line(g: CanvasRenderingContext2D, color: string, x0: number, y0: number, x1: number, y1: number, w = 1) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) px(g, color, Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), w, w);
}

/** Small stable hash for deterministic damage and rust. */
const hh = (a: number, b: number) => {
  let x = Math.imul(a * 374761393 + b * 668265263, 1274126177);
  x ^= x >>> 13;
  return (Math.imul(x, 1103515245) >>> 16) & 255;
};

/**
 * A vehicle seen from above, facing +x (front on the right). Clean body with
 * a 1-px dark outline, cabin glass, roof highlight, head- and taillights.
 * Wrecks are charred black with rust, glass gone, doors hanging open.
 * `dmg` (0..3) picks the damage of an abandoned car: a crazed windscreen or an open door.
 */
function vehicle(model: VehicleModel, color: string, burnt: boolean, dmg: number): Sprite {
  return vehicleCanvas(model, (g, w, h, y0) => {
    const x0 = 1;
    const at = (f: number) => x0 + Math.round(w * f);
    const body = burnt ? '#38302e' : color;
    const dark = burnt ? '#241e1c' : shade(color, 0.72);
    const light = burnt ? '#4a3e38' : shade(color, 1.18);
    const glass = burnt ? '#14121a' : GLASS;
    const boxy = model === 'van' || model === 'ambulance' || model === 'truck' || model === 'bus' || model === 'military';

    // wheels poke out under the body sides
    const wheels = model === 'bus' ? [0.12, 0.78] : model === 'truck' ? [0.1, 0.24, 0.8] : [0.14, 0.72];
    const ww = Math.round(Math.min(10, w * 0.15));
    for (const f of wheels) {
      const wx = at(f);
      px(g, burnt ? '#4a4440' : INK, wx, y0 - 1, ww, h + 2);
      if (!burnt) {
        px(g, '#4a4a5a', wx + 1, y0 - 1, ww - 2, 1);
        px(g, '#4a4a5a', wx + 1, y0 + h, ww - 2, 1);
      }
    }

    // outline and body
    rounded(g, INK, x0, y0, w, h);
    rounded(g, body, x0 + 1, y0 + 1, w - 2, h - 2, INK);
    px(g, dark, x0 + 2, y0 + h - 2, w - 4, 1); // side shading
    px(g, dark, x0 + 2, y0 + 1, w - 4, 1);
    px(g, light, x0 + 2, y0 + 2, w - 4, 1);
    // bumpers
    px(g, dark, x0 + 1, y0 + 2, 1, h - 4);
    px(g, dark, x0 + w - 2, y0 + 2, 1, h - 4);

    const glassBlock = (x: number, y: number, ww2: number, hh2: number, glint: boolean) => {
      px(g, glass, x, y, ww2, hh2);
      if (glint && !burnt) line(g, GLINT, x + 1, y + hh2 - 2, x + Math.min(ww2 - 1, 3), y + 1);
    };

    let roofA = 0, roofB = 0; // roof extent for lights / damage
    if (model === 'car' || model === 'police') {
      // sedan: trunk, cabin glass ring, roof, bonnet
      const c0 = at(0.22), c1 = at(0.76);
      rounded(g, INK, c0, y0 + 2, c1 - c0, h - 4);
      glassBlock(c0 + 1, y0 + 3, c1 - c0 - 2, h - 6, false);
      roofA = at(0.33); roofB = at(0.62);
      rounded(g, body, roofA, y0 + 4, roofB - roofA, h - 8, glass);
      px(g, light, roofA + 1, y0 + 4, roofB - roofA - 2, 2); // roof highlight
      px(g, dark, roofA + 1, y0 + h - 5, roofB - roofA - 2, 1);
      // windscreen glint
      if (!burnt) line(g, GLINT, roofB + 2, y0 + h - 6, roofB + 4, y0 + 5);
      if (!burnt) line(g, GLINT, c0 + 2, y0 + h - 6, c0 + 3, y0 + 6);
      // bonnet crease
      px(g, light, at(0.8), y0 + Math.floor(h / 2) - 1, at(0.94) - at(0.8), 1);
      if (model === 'police' && !burnt) {
        // Dutch police: white with blue and orange stripes, blue light bar
        px(g, '#2a4cc8', x0 + 2, y0 + 3, w - 4, 2);
        px(g, '#2a4cc8', x0 + 2, y0 + h - 5, w - 4, 2);
        px(g, '#ff7a2a', x0 + 2, y0 + 5, at(0.22) - x0 - 2, 1);
        px(g, '#ff7a2a', x0 + 2, y0 + h - 6, at(0.22) - x0 - 2, 1);
        px(g, '#ff7a2a', at(0.76), y0 + 5, w - (at(0.76) - x0) - 2, 1);
        px(g, '#ff7a2a', at(0.76), y0 + h - 6, w - (at(0.76) - x0) - 2, 1);
        const lb = at(0.47);
        px(g, INK, lb - 1, y0 + 4, 5, h - 8);
        px(g, '#3a7aff', lb, y0 + 5, 3, Math.floor((h - 10) / 2));
        px(g, '#9cc0ff', lb, y0 + 5, 1, 1);
        px(g, '#3a7aff', lb, y0 + h - 5 - Math.floor((h - 10) / 2), 3, Math.floor((h - 10) / 2));
        px(g, '#ffffff', lb, y0 + Math.floor(h / 2) - 1, 3, 2);
      }
    } else if (model === 'van' || model === 'ambulance') {
      // box body, short bonnet, windscreen at the front
      const ws0 = at(0.74), ws1 = at(0.86);
      px(g, INK, ws0, y0 + 2, ws1 - ws0, h - 4);
      glassBlock(ws0 + 1, y0 + 3, ws1 - ws0 - 2, h - 6, true);
      roofA = x0 + 2; roofB = ws0 - 1;
      rounded(g, model === 'ambulance' && !burnt ? '#f4f2ea' : body, roofA, y0 + 2, roofB - roofA, h - 4, INK);
      px(g, model === 'ambulance' && !burnt ? '#ffffff' : light, roofA + 1, y0 + 3, roofB - roofA - 2, 1);
      for (let x = roofA + 6; x < roofB - 2; x += 7) px(g, model === 'ambulance' && !burnt ? '#d8d6ce' : dark, x, y0 + 3, 1, h - 6); // roof ribs
      px(g, dark, x0 + 2, y0 + Math.floor(h / 2), 1, 1); // rear door split
      if (model === 'ambulance' && !burnt) {
        // yellow body, blue-and-yellow check band along the sides, blue lights, star of life
        for (let x = x0 + 2, k = 0; x < ws0 - 1; x += 4, k++) {
          px(g, k & 1 ? '#2a5ad8' : '#ffe04a', x, y0 + 1, 4, 1);
          px(g, k & 1 ? '#ffe04a' : '#2a5ad8', x, y0 + h - 2, 4, 1);
        }
        px(g, INK, ws0 - 4, y0 + 2, 3, h - 4);
        px(g, '#3a7aff', ws0 - 3, y0 + 3, 1, h - 6);
        px(g, '#ffffff', ws0 - 3, y0 + Math.floor(h / 2) - 1, 1, 2);
        const sx = at(0.38), sy = y0 + Math.floor(h / 2);
        px(g, '#2a5ad8', sx - 4, sy - 1, 9, 3);
        px(g, '#2a5ad8', sx - 1, sy - 4, 3, 9);
        px(g, '#ffffff', sx, sy - 3, 1, 7);
      }
    } else if (model === 'military') {
      // canvas-covered load bed, olive cab
      const cab = at(0.68);
      roofA = x0 + 2; roofB = cab - 1;
      rounded(g, burnt ? '#2e2824' : '#7c7a4e', roofA, y0 + 1, roofB - roofA, h - 2, INK);
      for (let x = roofA + 4; x < roofB - 1; x += 6) px(g, burnt ? '#1a1614' : '#5e5c3a', x, y0 + 2, 1, h - 4);
      px(g, burnt ? '#3e3430' : '#94925e', roofA + 1, y0 + 2, roofB - roofA - 2, 1);
      px(g, INK, cab - 1, y0 + 1, 1, h - 2);
      const ws0 = at(0.8);
      px(g, INK, ws0, y0 + 3, 4, h - 6);
      glassBlock(ws0 + 1, y0 + 4, 2, h - 8, false);
      if (!burnt) {
        // camo blotches on the cab
        px(g, '#3f4a28', cab + 2, y0 + 3, 4, 3);
        px(g, '#8a7d4e', cab + 4, y0 + h - 7, 4, 3);
        px(g, '#3f4a28', at(0.9), y0 + 6, 3, 4);
        px(g, '#f2f0e0', at(0.72), y0 + Math.floor(h / 2) - 1, 3, 2); // white star-ish marking
      }
    } else if (model === 'truck') {
      // white cargo box with ribs, coloured cab
      const cab = at(0.79);
      roofA = x0 + 1; roofB = cab - 1;
      px(g, INK, roofB, y0, 2, h);
      rounded(g, burnt ? '#2e2824' : '#ecebe2', roofA, y0 + 1, roofB - roofA, h - 2, INK);
      px(g, burnt ? '#3e3430' : '#ffffff', roofA + 1, y0 + 2, roofB - roofA - 2, 2);
      for (let x = roofA + 6; x < roofB - 2; x += 8) px(g, burnt ? '#1a1614' : '#cfcdc2', x, y0 + 2, 1, h - 4);
      if (!burnt) px(g, color, roofA + 4, y0 + h - 4, roofB - roofA - 8, 2); // company stripe
      const ws0 = at(0.9);
      px(g, INK, ws0, y0 + 2, 5, h - 4);
      glassBlock(ws0 + 1, y0 + 3, 3, h - 6, true);
      px(g, light, cab + 2, y0 + 3, ws0 - cab - 3, 2);
    } else if (model === 'bus') {
      // light roof with vents, window strips down both sides
      roofA = x0 + 3; roofB = x0 + w - 6;
      // window strips down both sides, then a light roof with vents
      px(g, INK, x0 + 3, y0 + 3, w - 9, h - 6);
      for (let x = x0 + 4; x < x0 + w - 7; x += 10) {
        glassBlock(x, y0 + 3, 9, 3, false);
        glassBlock(x, y0 + h - 6, 9, 3, false);
        if (!burnt) px(g, GLINT, x + 1, y0 + 3, 3, 1);
      }
      rounded(g, burnt ? '#2e2824' : '#ecebe4', x0 + 4, y0 + 7, w - 11, h - 14, INK);
      px(g, burnt ? '#3e3430' : '#ffffff', x0 + 5, y0 + 7, w - 13, 1);
      for (const f of [0.25, 0.55]) {
        px(g, burnt ? '#1a1614' : '#9a9cac', at(f), y0 + 10, 14, h - 20);
        px(g, burnt ? '#1a1614' : '#c8cad2', at(f), y0 + 10, 14, 1);
      }
      px(g, INK, x0 + w - 5, y0 + 2, 4, h - 4);
      glassBlock(x0 + w - 4, y0 + 3, 2, h - 6, false);
      if (!burnt) px(g, '#ff9a2a', x0 + w - 6, y0 + 5, 1, h - 10); // destination sign
    }

    // lights
    if (!burnt) {
      const lh = Math.max(2, Math.round(h * 0.16));
      px(g, '#fff3a8', x0 + w - 2, y0 + 2, 1, lh);
      px(g, '#fff3a8', x0 + w - 2, y0 + h - 2 - lh, 1, lh);
      px(g, '#ffffff', x0 + w - 2, y0 + 2, 1, 1);
      px(g, '#e8302a', x0 + 1, y0 + 2, 1, lh);
      px(g, '#e8302a', x0 + 1, y0 + h - 2 - lh, 1, lh);
    } else {
      px(g, '#5a1e1a', x0 + 1, y0 + 2, 1, 2);
      px(g, '#5a1e1a', x0 + 1, y0 + h - 4, 1, 2);
    }

    // side mirrors
    if (!boxy || model === 'van' || model === 'ambulance') {
      const mx = model === 'car' || model === 'police' ? at(0.66) : at(0.76);
      px(g, INK, mx, y0 - 1, 2, 1);
      px(g, INK, mx, y0 + h, 2, 1);
    }

    // doors hanging open from their front hinge
    const door = (side: number, hingeF: number, len: number) => {
      // swung wide open: a clean panel standing out from the side (stays crisp when rotated)
      const hx = at(hingeF);
      const y = side < 0 ? y0 - len : y0 + h;
      px(g, INK, hx - 4, y - (side < 0 ? 1 : 0), 4, len + 1);
      px(g, body, hx - 3, y, 2, len - 1);
      if (!burnt) px(g, GLASS, hx - 3, side < 0 ? y + 1 : y + 2, 1, Math.max(1, len - 4));
    };

    if (burnt) {
      // a few big rust blotches and soot patches, a glint of broken glass
      const blot = (cx: number, cy: number, r: number, outer: string, inner: string) => {
        for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
          const d = x * x + y * y;
          if (d > r * r + 1) continue;
          const gx = cx + x, gy = cy + y;
          if (gx < x0 + 2 || gx > x0 + w - 3 || gy < y0 + 2 || gy > y0 + h - 3) continue;
          px(g, d < (r - 1.2) * (r - 1.2) ? inner : outer, gx, gy);
        }
      };
      const n = 4 + Math.round(w / 22);
      for (let i = 0; i < n; i++) {
        const v = hh(i, model.length * 13 + dmg * 5), u = hh(i + 40, dmg + 3);
        const bx = x0 + 3 + Math.floor((v / 256) * (w - 6)), by = y0 + 3 + Math.floor((u / 256) * (h - 6));
        if (i % 3 === 2) blot(bx, by, 2 + (v & 1), '#141010', '#0c0a0a');
        else blot(bx, by, 3 + (u & 1), '#8a4426', '#b8622e');
      }
      for (let i = 0; i < 4; i++) px(g, '#b8c8d4', x0 + 3 + ((hh(i, 77 + dmg) / 256) * (w - 6)) | 0, y0 + 3 + ((hh(i, 99) / 256) * (h - 6)) | 0);
      // scorched paint left at the ends shows what it was
      if (model === 'police') px(g, '#5a6890', x0 + 3, y0 + 3, 4, 1);
      if (model === 'ambulance') px(g, '#8a7a2a', x0 + 3, y0 + 1, 6, 1);
      if (dmg & 1) door(-1, model === 'car' || model === 'police' ? 0.62 : 0.86, Math.round(Math.min(9, h * 0.45)));
      if (dmg & 2) door(1, model === 'car' || model === 'police' ? 0.44 : 0.86, Math.round(Math.min(9, h * 0.45)));
    } else if (dmg === 1 && (model === 'car' || model === 'police' || model === 'van')) {
      // crazed windscreen
      const cx = model === 'van' ? at(0.8) : at(0.7), cy = y0 + Math.floor(h / 2);
      for (const [dx, dy] of [[-2, -4], [2, -3], [-1, 4], [3, 3], [0, -5]]) line(g, '#dfe8f0', cx, cy, cx + dx, cy + dy);
    } else if (dmg === 2 && model !== 'bus' && model !== 'truck') {
      door(-1, model === 'car' || model === 'police' ? 0.62 : 0.86, Math.round(Math.min(9, h * 0.45)));
      px(g, dark, at(0.1), y0 + h - 3, 4, 1); // dent
    }
  });
}

/** Translucent south-east drop shadow of a vehicle, the same size as its sprite. */
function vehicleShadow(model: VehicleModel): Sprite {
  return vehicleCanvas(model, (g, w, h, y0) => {
    g.fillStyle = 'rgba(27,26,46,0.38)';
    g.fillRect(1, y0, w, h);
  });
}

export class SpriteBank {
  private cache = new Map<string, Sprite>();
  private people = new Map<string, PixelSprite>();
  /** new person frames we may still rasterise this frame (each is ~0.3-1.5 ms) */
  private budget = 0;

  /** Call once per rendered frame: spreads first-time rasterising over frames. */
  beginFrame() {
    this.budget = 8;
  }

  private get(key: string, make: () => Sprite): Sprite {
    let s = this.cache.get(key);
    if (!s) this.cache.set(key, (s = make()));
    return s;
  }

  private person(key: string, make: () => Raster, flash: boolean, fallback?: PixelSprite): PixelSprite {
    const k = flash ? key + '!' : key;
    let s = this.people.get(k);
    if (!s) {
      if (fallback && this.budget <= 0) return fallback;
      this.budget--;
      s = fromRaster(make(), flash);
      this.people.set(k, s);
      // a few thousand frames at most; drop the oldest if a long session wanders far
      if (this.people.size > 6000) this.people.delete(this.people.keys().next().value!);
    }
    return s;
  }

  /** The survivor: pose, heading 0..7 (0 = east, clockwise), hurt flash. */
  player(pose: Pose, dir: number, flash = false): PixelSprite {
    return this.person(`p${pose.act}${pose.frame}${pose.weapon ?? ''}${dir}`, () => renderPerson(survivorLook(), pose, dir), flash);
  }

  /** `fallback` (the frame shown last time) is returned instead when this frame's drawing budget is spent. */
  zombie(kind: ZombieKind, variant: number, pose: Pose, dir: number, flash = false, fallback?: PixelSprite): PixelSprite {
    return this.person(`z${kind}${variant}${pose.act}${pose.frame}${dir}`, () => renderPerson(zombieLook(kind, variant), pose, dir), flash, fallback);
  }

  /** A body lying flat with a blood pool, centred on its position. */
  corpse(kind: CorpseKind | 'survivor', variant: number, dir: number): PixelSprite {
    return this.person(`c${kind}${variant % 12}${dir}`, () => renderPerson(corpseLook(kind, variant % 12), { act: 'lying', frame: 0 }, dir), false);
  }

  /** `variant` (any integer, e.g. a hash of the vehicle id) picks its damage. */
  vehicle(model: VehicleModel, color: number, burnt: boolean, variant = 0): Sprite {
    const dmg = variant & 3;
    const body = model === 'military' ? '#5d6b3a' : model === 'ambulance' ? '#ffd21f' : model === 'police' ? '#f4f4ee'
      : model === 'bus' ? (color & 1 ? '#e2342e' : '#f2c230') : CAR_COLORS[color % CAR_COLORS.length];
    return this.get(`v${model}${color}${burnt}${dmg}`, () => vehicle(model, body, burnt, dmg));
  }

  vehicleShadow(model: VehicleModel): Sprite {
    return this.get(`vs${model}`, () => vehicleShadow(model));
  }

  /** Army supply crate, 0.8 m square with a 0.4 m lid face (11 px/m, anchored at its base centre). */
  crate(): PixelSprite {
    return this.pixel('crate', 11, 13, 5.5, 12, (g) => {
      px(g, '#5a5f3a', 1, 1, 9, 6); // lid
      px(g, '#6c7246', 1, 1, 9, 1); // lit north edge
      px(g, '#4a4e30', 1, 3, 9, 1); // lid slats
      px(g, '#4a4e30', 1, 5, 9, 1);
      px(g, '#454a2c', 1, 7, 9, 4); // south face
      px(g, '#353a22', 1, 10, 9, 1);
      px(g, '#2f3320', 9, 1, 1, 10); // shade edge
      px(g, '#c8c09a', 4, 8, 3, 1); // stencil
    });
  }

  /** A dropped sports bag, about 0.6 x 0.3 m. */
  bag(): PixelSprite {
    return this.pixel('bag', 9, 7, 4.5, 6, (g) => {
      px(g, '#6a5a3a', 1, 2, 7, 3);
      px(g, '#7e6c48', 1, 2, 7, 1);
      px(g, '#4e422c', 1, 5, 7, 1);
      px(g, '#4e422c', 7, 2, 1, 4);
      px(g, '#3a3226', 3, 1, 3, 1); // handle
      px(g, '#c8a24a', 4, 3, 1, 1); // zip pull
    });
  }

  private pixel(key: string, w: number, h: number, ox: number, oy: number, draw: (g: CanvasRenderingContext2D) => void): PixelSprite {
    let s = this.people.get(key);
    if (!s) this.people.set(key, (s = { img: canvas(w, h, draw), ox, oy }));
    return s;
  }

  door(searched: boolean): Sprite {
    return this.get(`door${searched}`, () => canvas(5, 5, (g) => {
      px(g, '#1a1612', 0, 0, 5, 5);
      px(g, searched ? '#5a5650' : '#c08a3a', 1, 1, 3, 3);
    }));
  }
}
