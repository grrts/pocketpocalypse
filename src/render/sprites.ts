// Procedurally drawn pixel-art sprites (no external art assets). Vehicles are
// drawn facing +x and rotated at render time. People, zombies and bodies are
// rasterised per heading on the 11 px/m art grid (see people.ts) and never
// rotated, so they stay crisp.

import type { CorpseKind, VehicleModel, ZombieKind } from '../world/spawnTypes';
import { ART_PPM, BODY_SCALE, renderPerson, survivorLook, zombieLook, corpseLook, type Pose, type Raster } from './people';

export type Sprite = HTMLCanvasElement;

/** An art-grid sprite with its anchor (feet for people) in canvas pixels. */
export interface PixelSprite {
  img: HTMLCanvasElement;
  ox: number;
  oy: number;
}

function fromRaster(r: Raster): PixelSprite {
  const img = document.createElement('canvas');
  img.width = r.w;
  img.height = r.h;
  img.getContext('2d')!.putImageData(new ImageData(r.rgba as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
  return { img, ox: r.ox, oy: r.oy };
}

/**
 * The people drop shadow: one solid translucent blob on the art grid, cast to
 * the south-east by the north-west sun, anchored at the feet.
 */
function shadowSprite(): PixelSprite {
  const w = 26, h = 22, ox = 7, oy = 7;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  // ellipse along the south-east diagonal, from just behind the feet to ~1.3 m out
  const L = 0.75 * ART_PPM * BODY_SCALE, Wd = 0.3 * ART_PPM * BODY_SCALE;
  const cx = ox + 0.36 * ART_PPM * BODY_SCALE, cy = oy + 0.36 * ART_PPM * BODY_SCALE;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    const u = (dx + dy) / Math.SQRT2, v = (dy - dx) / Math.SQRT2;
    if ((u / L) ** 2 + (v / Wd) ** 2 > 1) continue;
    const i = (y * w + x) * 4;
    img.data[i] = 0x1b; img.data[i + 1] = 0x1a; img.data[i + 2] = 0x2e; img.data[i + 3] = 92;
  }
  g.putImageData(img, 0, 0);
  return { img: c, ox, oy };
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

export const CAR_COLORS = ['#8c2f2a', '#2f4f7a', '#d8d8d0', '#2a2a2c', '#6d6f73', '#3f6b45', '#b0a27a', '#7a4a7a', '#c8862a', '#4a6d7a', '#9a9da2', '#5a3a2a'];

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * f) | 0, gg = Math.min(255, ((n >> 8) & 255) * f) | 0, b = Math.min(255, (n & 255) * f) | 0;
  return `rgb(${r},${gg},${b})`;
}

function vehicle(model: VehicleModel, color: string, burnt: boolean): Sprite {
  const dims: Record<VehicleModel, [number, number]> = {
    car: [24, 10], van: [28, 11], truck: [46, 13], bus: [64, 14], police: [25, 10], ambulance: [32, 12], military: [30, 12],
  };
  const [w, h] = dims[model];
  return canvas(w + 2, h + 2, (g) => {
    const body = burnt ? '#2c2826' : color;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(2, 2, w, h);
    px(g, shade(body.startsWith('#') ? body : '#2c2826', 0.6), 0, 0, w, h);
    px(g, body, 1, 1, w - 2, h - 2);
    if (model === 'truck') {
      px(g, burnt ? '#3a3330' : '#b8b4a8', 1, 1, w - 12, h - 2); // cargo box
      px(g, body, w - 11, 1, 10, h - 2);
      px(g, burnt ? '#141212' : '#25313a', w - 5, 2, 3, h - 4);
    } else if (model === 'bus') {
      for (let x = 4; x < w - 6; x += 5) px(g, burnt ? '#141212' : '#2b3a44', x, 1, 3, 1);
      for (let x = 4; x < w - 6; x += 5) px(g, burnt ? '#141212' : '#2b3a44', x, h - 2, 3, 1);
      px(g, burnt ? '#141212' : '#25313a', w - 4, 2, 2, h - 4);
    } else {
      const ws = model === 'van' || model === 'ambulance' ? w - 8 : w - 9;
      px(g, burnt ? '#141212' : '#25313a', ws, 2, 3, h - 4); // windscreen
      px(g, burnt ? '#141212' : '#2b3a44', 3, 2, 2, h - 4); // rear window
      px(g, shade(body.startsWith('#') ? body : '#2c2826', 1.15), 6, 2, ws - 7, h - 4); // roof
    }
    if (!burnt) {
      if (model === 'police') {
        px(g, '#e8e8e0', 1, 1, w - 2, 2);
        px(g, '#e8e8e0', 1, h - 3, w - 2, 2);
        px(g, '#2a4cd8', 10, 3, 2, 2);
        px(g, '#d82a2a', 10, h - 5, 2, 2);
      } else if (model === 'ambulance') {
        px(g, '#d8c22a', 1, 1, w - 2, 2);
        px(g, '#d8c22a', 1, h - 3, w - 2, 2);
        px(g, '#c42a2a', 12, 4, 4, 4);
      } else if (model === 'military') {
        px(g, '#4a4e34', 4, 3, 8, 3);
        px(g, '#3a3d28', 14, 6, 6, 3);
      }
      px(g, '#f0e6a0', w - 1, 1, 1, 2);
      px(g, '#f0e6a0', w - 1, h - 3, 1, 2);
      px(g, '#8a1f1a', 0, 1, 1, 2);
      px(g, '#8a1f1a', 0, h - 3, 1, 2);
    } else {
      // rust and soot
      for (let i = 0; i < w * h * 0.15; i++) px(g, i % 3 ? '#4a2e22' : '#121010', 1 + ((i * 7) % (w - 2)), 1 + ((i * 13) % (h - 2)));
    }
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

  private person(key: string, make: (flash: boolean) => Raster, flash: boolean, fallback?: PixelSprite): PixelSprite {
    const k = flash ? key + '!' : key;
    let s = this.people.get(k);
    if (!s) {
      if (fallback && this.budget <= 0) return fallback;
      this.budget--;
      s = fromRaster(make(flash));
      this.people.set(k, s);
      // a few thousand frames at most; drop the oldest if a long session wanders far
      if (this.people.size > 6000) this.people.delete(this.people.keys().next().value!);
    }
    return s;
  }

  /**
   * The survivor: pose, heading 0..7 (0 = east, clockwise). `flash` gives the
   * white hit-flash frame (same pose, silhouette white inside its outline).
   */
  player(pose: Pose, dir: number, flash = false): PixelSprite {
    return this.person(`p${pose.act}${pose.frame}${pose.weapon ?? ''}${dir}`, (f) => renderPerson(survivorLook(), pose, dir, { flash: f }), flash);
  }

  /** `fallback` (the frame shown last time) is returned instead when this frame's drawing budget is spent. */
  zombie(kind: ZombieKind, variant: number, pose: Pose, dir: number, flash = false, fallback?: PixelSprite): PixelSprite {
    return this.person(`z${kind}${variant}${pose.act}${pose.frame}${dir}`, (f) => renderPerson(zombieLook(kind, variant), pose, dir, { flash: f }), flash, fallback);
  }

  /** A body lying flat with a blood pool, centred on its position. */
  corpse(kind: CorpseKind | 'survivor', variant: number, dir: number): PixelSprite {
    return this.person(`c${kind}${variant % 12}${dir}`, () => renderPerson(corpseLook(kind, variant % 12), { act: 'lying', frame: 0 }, dir), false);
  }

  /** Solid drop shadow under a standing person, anchored at the feet. */
  shadow(): PixelSprite {
    let s = this.people.get('shadow');
    if (!s) this.people.set('shadow', (s = shadowSprite()));
    return s;
  }

  vehicle(model: VehicleModel, color: number, burnt: boolean): Sprite {
    return this.get(`v${model}${color}${burnt}`, () => vehicle(model, model === 'military' ? '#4f5638' : model === 'ambulance' ? '#e8e8e0' : model === 'police' ? '#e0e0d8' : model === 'bus' ? '#d8c43a' : CAR_COLORS[color % CAR_COLORS.length], burnt));
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
