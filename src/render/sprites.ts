// Procedurally drawn pixel-art sprites (no external art assets). Everything is
// drawn facing +x and rotated at render time. One sprite pixel is half a texel.

import type { CorpseKind, VehicleModel, ZombieKind } from '../world/spawnTypes';

export type Sprite = HTMLCanvasElement;

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

interface HumanLook {
  skin: string;
  shirt: string;
  hair: string;
  pants: string;
  arms: 'side' | 'forward';
  blood?: boolean;
}

/** Top-down person, 14x14, facing right. frame 0/1 = stride. */
function human(look: HumanLook, frame: number): Sprite {
  return canvas(14, 14, (g) => {
    const step = frame === 1 ? 1 : frame === 2 ? -1 : 0;
    // shadow
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(3, 4, 9, 8);
    // feet / legs
    px(g, look.pants, 5 + step, 4, 3, 2);
    px(g, look.pants, 5 - step, 8, 3, 2);
    // torso (shoulders across y)
    px(g, look.shirt, 4, 3, 5, 8);
    px(g, shade(look.shirt, 0.75), 4, 3, 1, 8);
    // arms
    if (look.arms === 'forward') {
      px(g, look.shirt, 8, 2, 3, 2);
      px(g, look.shirt, 8, 10, 3, 2);
      px(g, look.skin, 11, 2, 2, 2);
      px(g, look.skin, 11, 10, 2, 2);
    } else {
      px(g, look.shirt, 5 - step, 1, 3, 2);
      px(g, look.shirt, 5 + step, 11, 3, 2);
      px(g, look.skin, 8 - step, 1, 1, 2);
      px(g, look.skin, 8 + step, 11, 1, 2);
    }
    // head
    px(g, look.skin, 6, 5, 4, 4);
    px(g, look.hair, 5, 5, 3, 4);
    px(g, shade(look.skin, 0.8), 9, 6, 1, 2);
    if (look.blood) {
      px(g, '#6e1612', 6, 8, 2, 1);
      px(g, '#6e1612', 4, 4, 1, 2);
    }
  });
}

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

function corpse(kind: CorpseKind, variant: number): Sprite {
  const shirt = kind === 'soldier' ? '#4d5235' : kind === 'police' ? '#25304a' : ['#6a4a3a', '#3a4a6a', '#7a6a4a', '#5a3a4a'][variant % 4];
  return canvas(16, 10, (g) => {
    px(g, '#3a3434', 2, 3, 4, 4); // legs
    px(g, shirt, 6, 2, 6, 6);
    px(g, shirt, 7, 0, 2, 2);
    px(g, shirt, 9, 8, 3, 2);
    px(g, '#b89a80', 12, 3, 3, 4);
    px(g, '#3a2a20', 13, 3, 2, 4);
    px(g, '#5a1612', 6, 5, 3, 2);
  });
}

export class SpriteBank {
  private cache = new Map<string, Sprite>();

  private get(key: string, make: () => Sprite): Sprite {
    let s = this.cache.get(key);
    if (!s) this.cache.set(key, (s = make()));
    return s;
  }

  player(frame: number, armed: boolean): Sprite {
    return this.get(`p${frame}${armed}`, () => human({ skin: '#d9a77c', shirt: '#c8642a', hair: '#3a2a1e', pants: '#2f3a4a', arms: armed ? 'forward' : 'side' }, frame));
  }

  zombie(kind: ZombieKind, variant: number, frame: number): Sprite {
    return this.get(`z${kind}${variant}${frame}`, () => {
      const shirts = ['#5a4a3e', '#3e4a5a', '#6a5a3a', '#4a3a4a', '#6b6b5a', '#3a5048'];
      const shirt = kind === 'soldier' ? '#4d5235' : kind === 'police' ? '#25304a' : shirts[variant % shirts.length];
      const skin = kind === 'runner' ? '#a3a88a' : ['#8a9a7a', '#7d8c78', '#96957a'][variant % 3];
      return human({ skin, shirt, hair: '#2a2420', pants: kind === 'soldier' ? '#3e4230' : '#2e2a2a', arms: 'forward', blood: true }, frame);
    });
  }

  vehicle(model: VehicleModel, color: number, burnt: boolean): Sprite {
    return this.get(`v${model}${color}${burnt}`, () => vehicle(model, model === 'military' ? '#4f5638' : model === 'ambulance' ? '#e8e8e0' : model === 'police' ? '#e0e0d8' : model === 'bus' ? '#d8c43a' : CAR_COLORS[color % CAR_COLORS.length], burnt));
  }

  corpse(kind: CorpseKind, variant: number): Sprite {
    return this.get(`c${kind}${variant}`, () => corpse(kind, variant));
  }

  crate(): Sprite {
    return this.get('crate', () => canvas(8, 8, (g) => {
      px(g, '#3e4228', 0, 0, 8, 8);
      px(g, '#5a5f3a', 1, 1, 6, 6);
      px(g, '#3e4228', 1, 3, 6, 1);
    }));
  }

  bag(): Sprite {
    return this.get('bag', () => canvas(7, 6, (g) => {
      px(g, '#3a3226', 0, 1, 7, 5);
      px(g, '#6a5a3a', 1, 2, 5, 3);
      px(g, '#3a3226', 2, 0, 3, 1);
    }));
  }

  door(searched: boolean): Sprite {
    return this.get(`door${searched}`, () => canvas(5, 5, (g) => {
      px(g, '#1a1612', 0, 0, 5, 5);
      px(g, searched ? '#5a5650' : '#c08a3a', 1, 1, 3, 3);
    }));
  }
}
