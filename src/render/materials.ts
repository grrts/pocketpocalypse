// Material ids, their pixel-art palette and procedural texturing, plus how each
// one behaves for movement. One table drives both rendering and collision.

import { hash2f, valueNoise } from '../core/rng';
import type { IdRaster } from './raster';

export const M = {
  SEA: 0, LAND: 1, GRASS: 2, FARM: 3, FOREST: 4, SCRUB: 5, WETLAND: 6, SAND: 7, RESIDENTIAL: 8, COMMERCIAL: 9,
  INDUSTRIAL: 10, PARK: 11, CEMETERY: 12, MILITARY: 13, RAILGROUND: 14, PARKING: 15, PITCH: 16, WATER: 17, FLOOD: 18,
  ROAD: 19, ROAD_MINOR: 20, PATH: 21, CYCLE: 22, RAIL: 23, ROOF_RED: 24, ROOF_BROWN: 25, ROOF_GRAY: 26,
  ROOF_FLAT: 27, ROOF_METAL: 28, ROOF_SLATE: 29, GLASS: 30, ROOF_BURNT: 31, WALL: 32, BRIDGE: 33, MOTORWAY: 34,
  FARMYARD: 35, ORCHARD: 36, BEACH: 37, CONSTRUCTION: 38, ALLOTMENT: 39, URBAN: 40, SIDEWALK: 41, MARKING: 42,
  RUBBLE: 43, SANDBAG: 44, ROOF_DARK: 45, TRACK: 46, OV_MOTORWAY: 47, OV_ROAD: 48, OV_RAIL: 49,
  FLOOR_WOOD: 50, FLOOR_TILE: 51, FLOOR_CARPET: 52, FLOOR_CONCRETE: 53, INNER_WALL: 54, FURNITURE: 55, FLOOR_STONE: 56,
} as const;

/** Movement classes stored in the collision grid. */
export const C = { WALK: 0, SOLID: 1, DEEP: 2, SLOW: 3, ROUGH: 4 } as const;

type RGB = [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

interface MatDef {
  color: RGB;
  col: number;
  roof?: boolean;
}

const T: Record<number, MatDef> = {
  [M.SEA]: { color: hex('#1d364d'), col: C.DEEP },
  [M.LAND]: { color: hex('#66733f'), col: C.WALK },
  [M.GRASS]: { color: hex('#5b7a39'), col: C.WALK },
  [M.FARM]: { color: hex('#86864a'), col: C.WALK },
  [M.FOREST]: { color: hex('#2f4b2b'), col: C.ROUGH },
  [M.SCRUB]: { color: hex('#58693a'), col: C.ROUGH },
  [M.WETLAND]: { color: hex('#4a5f4e'), col: C.SLOW },
  [M.SAND]: { color: hex('#bfae7e'), col: C.WALK },
  [M.RESIDENTIAL]: { color: hex('#6d7556'), col: C.WALK },
  [M.COMMERCIAL]: { color: hex('#86847b'), col: C.WALK },
  [M.INDUSTRIAL]: { color: hex('#73716a'), col: C.WALK },
  [M.PARK]: { color: hex('#527636'), col: C.WALK },
  [M.CEMETERY]: { color: hex('#58693f'), col: C.WALK },
  [M.MILITARY]: { color: hex('#5c613f'), col: C.WALK },
  [M.RAILGROUND]: { color: hex('#6b645a'), col: C.WALK },
  [M.PARKING]: { color: hex('#58585a'), col: C.WALK },
  [M.PITCH]: { color: hex('#4c7837'), col: C.WALK },
  [M.WATER]: { color: hex('#2a4d64'), col: C.DEEP },
  [M.FLOOD]: { color: hex('#46625f'), col: C.SLOW },
  [M.ROAD]: { color: hex('#3d3e41'), col: C.WALK },
  [M.ROAD_MINOR]: { color: hex('#48494b'), col: C.WALK },
  [M.PATH]: { color: hex('#8b8173'), col: C.WALK },
  [M.CYCLE]: { color: hex('#743d37'), col: C.WALK },
  [M.RAIL]: { color: hex('#574e46'), col: C.WALK },
  [M.ROOF_RED]: { color: hex('#86493a'), col: C.SOLID, roof: true },
  [M.ROOF_BROWN]: { color: hex('#674838'), col: C.SOLID, roof: true },
  [M.ROOF_GRAY]: { color: hex('#5a5d64'), col: C.SOLID, roof: true },
  [M.ROOF_FLAT]: { color: hex('#7a776f'), col: C.SOLID, roof: true },
  [M.ROOF_METAL]: { color: hex('#868c92'), col: C.SOLID, roof: true },
  [M.ROOF_SLATE]: { color: hex('#474c57'), col: C.SOLID, roof: true },
  [M.GLASS]: { color: hex('#93adb3'), col: C.SOLID, roof: true },
  [M.ROOF_BURNT]: { color: hex('#2b2725'), col: C.SOLID, roof: true },
  [M.ROOF_DARK]: { color: hex('#3c3a3b'), col: C.SOLID, roof: true },
  [M.WALL]: { color: hex('#2a2624'), col: C.SOLID, roof: true },
  [M.BRIDGE]: { color: hex('#57534d'), col: C.WALK },
  [M.MOTORWAY]: { color: hex('#343538'), col: C.WALK },
  [M.FARMYARD]: { color: hex('#776d55'), col: C.WALK },
  [M.ORCHARD]: { color: hex('#627c3c'), col: C.WALK },
  [M.BEACH]: { color: hex('#d3c597'), col: C.WALK },
  [M.CONSTRUCTION]: { color: hex('#86724f'), col: C.WALK },
  [M.ALLOTMENT]: { color: hex('#6b7b41'), col: C.WALK },
  [M.URBAN]: { color: hex('#727766'), col: C.WALK },
  [M.SIDEWALK]: { color: hex('#87827c'), col: C.WALK },
  [M.MARKING]: { color: hex('#bdb9aa'), col: C.WALK },
  [M.RUBBLE]: { color: hex('#675f57'), col: C.ROUGH },
  [M.SANDBAG]: { color: hex('#8a7b58'), col: C.SOLID },
  [M.TRACK]: { color: hex('#7c6c52'), col: C.WALK },
  [M.OV_MOTORWAY]: { color: hex('#c49a52'), col: C.WALK },
  [M.OV_ROAD]: { color: hex('#a39d8e'), col: C.WALK },
  [M.OV_RAIL]: { color: hex('#4e4446'), col: C.WALK },
  // building interiors, seen only once you step inside
  [M.FLOOR_WOOD]: { color: hex('#8a6a48'), col: C.WALK },
  [M.FLOOR_TILE]: { color: hex('#a9a59a'), col: C.WALK },
  [M.FLOOR_CARPET]: { color: hex('#5d5f6e'), col: C.WALK },
  [M.FLOOR_CONCRETE]: { color: hex('#7d7a74'), col: C.WALK },
  [M.FLOOR_STONE]: { color: hex('#9a9180'), col: C.WALK },
  [M.INNER_WALL]: { color: hex('#e2d9c6'), col: C.SOLID },
  [M.FURNITURE]: { color: hex('#5a3f2c'), col: C.SOLID },
};

export const COLLISION = new Uint8Array(256);
export const IS_ROOF = new Uint8Array(256);
const BASE = new Uint8Array(256 * 3);
for (const [id, d] of Object.entries(T)) {
  const i = Number(id);
  COLLISION[i] = d.col;
  IS_ROOF[i] = d.roof ? 1 : 0;
  BASE.set(d.color, i * 3);
}
COLLISION[255] = C.SOLID;

export function materialColor(id: number): RGB {
  return [BASE[id * 3], BASE[id * 3 + 1], BASE[id * 3 + 2]];
}

/** Surface class (from OSM or the overview pack) -> material. */
export const SURFACE_MATERIAL: Record<string, number> = {
  land: M.LAND, farm: M.FARM, farmyard: M.FARMYARD, orchard: M.ORCHARD, grass: M.GRASS, residential: M.RESIDENTIAL,
  commercial: M.COMMERCIAL, industrial: M.INDUSTRIAL, construction: M.CONSTRUCTION, military: M.MILITARY,
  rail: M.RAILGROUND, allotments: M.ALLOTMENT, scrub: M.SCRUB, wetland: M.WETLAND, sand: M.SAND, beach: M.BEACH,
  forest: M.FOREST, cemetery: M.CEMETERY, park: M.PARK, pitch: M.PITCH, parking: M.PARKING, urban: M.URBAN,
  water: M.WATER,
};

export const ROAD_MATERIAL: Record<string, number> = {
  motorway: M.MOTORWAY, trunk: M.MOTORWAY, primary: M.ROAD, secondary: M.ROAD, tertiary: M.ROAD, link: M.ROAD,
  minor: M.ROAD_MINOR, residential: M.ROAD_MINOR, service: M.ROAD_MINOR, pedestrian: M.PATH, footway: M.PATH,
  path: M.TRACK, track: M.TRACK, cycleway: M.CYCLE,
};

export interface ShadeContext {
  /** world texel of raster pixel (0,0) */
  wx0: number;
  wy0: number;
  /** world texels per raster pixel */
  tpp: number;
  /** 0..1 how wrecked the area is */
  damage: number;
  /** 0..1 how far nature has reclaimed paved surfaces */
  overgrowth: number;
  /** Detailed street-level shading (shadows, roof tiles, cracks) */
  detail: boolean;
}

/**
 * Smooth noise sampled on a coarse lattice and bilinearly interpolated, which is
 * much cheaper than evaluating value noise per pixel. Computed on first use.
 */
class NoiseGrid {
  private data: Float32Array | null = null;
  private cols: number;
  constructor(private wx0: number, private wy0: number, w: number, private h: number, private tpp: number,
    private scale: number, private step: number, private seed: number) {
    this.cols = Math.ceil(w / step) + 2;
  }
  at(x: number, y: number): number {
    if (!this.data) {
      const rows = Math.ceil(this.h / this.step) + 2;
      this.data = new Float32Array(this.cols * rows);
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < this.cols; gx++) {
          this.data[gy * this.cols + gx] = valueNoise((this.wx0 + gx * this.step * this.tpp) / this.scale, (this.wy0 + gy * this.step * this.tpp) / this.scale, this.seed);
        }
      }
    }
    const fx = x / this.step, fy = y / this.step;
    const ix = fx | 0, iy = fy | 0;
    const ax = fx - ix, ay = fy - iy;
    const d = this.data, c = this.cols, i = iy * c + ix;
    return (d[i] * (1 - ax) + d[i + 1] * ax) * (1 - ay) + (d[i + c] * (1 - ax) + d[i + c + 1] * ax) * ay;
  }
}

// 256x256 tile of per-texel random values ("grain"); repeats every ~95 m, which is invisible
const GRAIN = new Float32Array(256 * 256);
for (let i = 0; i < GRAIN.length; i++) GRAIN[i] = hash2f(i & 255, i >> 8, 7);

/** Turn a material-id raster into RGBA pixels with procedural texture. */
export function shadeRaster(r: IdRaster, out: Uint8ClampedArray, ctx: ShadeContext): void {
  const { w, h, ids, aux } = r;
  const { wx0, wy0, tpp, detail } = ctx;
  const grid = (scale: number, step: number, seed: number) => new NoiseGrid(wx0, wy0, w, h, tpp, scale, step, seed);
  const nGrass = grid(18, 4, 3), nPitch = grid(30, 8, 4), nFarmDir = grid(400, 32, 9), nFarm = grid(60, 8, 5);
  const nCanopyA = grid(4, 1, 11), nCanopyB = grid(11, 3, 12), nCrack = grid(14, 2, 21), nOverview = grid(40, 8, 2);
  // Building drop shadows towards the south-east, cast from each roof pixel
  let shadow: Uint8Array | null = null;
  if (detail) {
    shadow = new Uint8Array(w * h);
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x;
        if (!IS_ROOF[ids[i]]) continue;
        // interior roof pixels shadow only other roof pixels; skip them quickly
        if (IS_ROOF[ids[i + w + 1]] && aux[i + w + 1] >= aux[i]) continue;
        const len = aux[i];
        for (let k = 1; k <= len && x + k < w && y + k < h; k++) {
          const j = i + k * (w + 1);
          if (!IS_ROOF[ids[j]]) shadow[j] = 1;
        }
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const wy = Math.floor(wy0 + y * tpp);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const id = ids[i];
      const wx = Math.floor(wx0 + x * tpp);
      let cr = BASE[id * 3], cg = BASE[id * 3 + 1], cb = BASE[id * 3 + 2];
      const g = GRAIN[((wy & 255) << 8) | (wx & 255)];
      let f = 1 + (g - 0.5) * 0.08;
      if (detail) {
        switch (id) {
          case M.GRASS: case M.PARK: case M.LAND: case M.RESIDENTIAL: case M.CEMETERY: case M.ALLOTMENT: case M.ORCHARD: {
            f *= 0.9 + nGrass.at(x, y) * 0.2;
            if (g > 0.985) { cr += 18; cg += 22; }
            if (id === M.ORCHARD && (wx % 12 < 4) && (wy % 12 < 4)) f *= 0.75;
            if (id === M.CEMETERY && wx % 7 === 0 && wy % 4 === 0) { cr = cg = cb = 150; }
            break;
          }
          case M.PITCH:
            if ((wx % 64 === 0) || (wy % 96 === 0)) { cr += 40; cg += 40; cb += 40; }
            f *= 0.95 + nPitch.at(x, y) * 0.1;
            break;
          case M.FARM: {
            const dir = nFarmDir.at(x, y) > 0.5;
            const stripe = ((dir ? wx : wy) >> 1) & 1;
            f *= stripe ? 0.93 : 1.04;
            f *= 0.92 + nFarm.at(x, y) * 0.16;
            break;
          }
          case M.FOREST: case M.SCRUB: {
            const n = nCanopyA.at(x, y) * 0.6 + nCanopyB.at(x, y) * 0.4;
            f *= n > 0.62 ? 1.25 : n < 0.38 ? 0.72 : 1;
            break;
          }
          case M.WATER: case M.SEA: case M.FLOOD:
            if (g > 0.6 && (wx + ((wy >> 1) * 5)) % 13 === 0) { cr += 14; cg += 18; cb += 22; }
            break;
          case M.ROAD: case M.ROAD_MINOR: case M.MOTORWAY: case M.PARKING: case M.BRIDGE: {
            const crack = Math.abs(nCrack.at(x, y) - 0.5);
            if (crack < 0.018 * (0.4 + ctx.damage)) f *= 0.65;
            if (g < ctx.overgrowth * 0.06) { cr = 74; cg = 98; cb = 52; }
            break;
          }
          case M.PATH: case M.SIDEWALK:
            if (((wx >> 1) + (wy >> 1)) & 1) f *= 0.94;
            if (g < ctx.overgrowth * 0.08) { cr = 80; cg = 104; cb = 56; }
            break;
          case M.CYCLE:
            if (g < ctx.overgrowth * 0.05) { cr = 80; cg = 100; cb = 56; }
            break;
          case M.RAIL:
            if ((wx + wy) % 3 === 0) f *= 0.85;
            break;
          case M.ROOF_RED: case M.ROOF_BROWN: case M.ROOF_SLATE: case M.ROOF_GRAY: case M.ROOF_DARK:
            if (wy % 3 === 0) f *= 0.84;
            break;
          case M.ROOF_FLAT: case M.ROOF_METAL:
            if (g > 0.97) f *= 0.8;
            if (id === M.ROOF_METAL && wx % 4 === 0) f *= 0.88;
            break;
          case M.ROOF_BURNT:
            if (g > 0.8) { cr += 30; cg += 14; }
            else if (g < 0.2) f *= 0.6;
            break;
          case M.GLASS:
            if (wx % 5 === 0 || wy % 5 === 0) f *= 0.8;
            break;
          case M.RUBBLE:
            f *= 0.75 + g * 0.5;
            break;
          case M.FLOOR_WOOD:
            // planks: long boards with a seam every few texels
            if (wy % 2 === 0 && (wx + (wy >> 1) * 3) % 7 === 0) f *= 0.8;
            else f *= (wy & 1) ? 0.95 : 1.03;
            break;
          case M.FLOOR_TILE: case M.FLOOR_STONE:
            if (wx % 2 === 0 || wy % 2 === 0) f *= 0.9;
            if (g < ctx.damage * 0.05) { cr = 110; cg = 40; cb = 34; }
            break;
          case M.FLOOR_CARPET:
            if (g < ctx.damage * 0.05) { cr = 90; cg = 30; cb = 26; }
            break;
          case M.INNER_WALL:
            f *= 0.97 + g * 0.06;
            break;
          case M.FURNITURE:
            if ((wx + wy) % 3 === 0) f *= 0.85;
            break;
        }
        if (shadow![i]) f *= 0.72;
      } else if (id === M.FOREST) {
        // overview tiles: gentle large-scale variation only
        f *= 0.9 + nOverview.at(x, y) * 0.2;
      }
      // Uint8ClampedArray clamps and rounds on its own
      const o = i * 4;
      out[o] = cr * f;
      out[o + 1] = cg * f;
      out[o + 2] = cb * f;
      out[o + 3] = 255;
    }
  }
}

/** Collision grid from a material raster. */
export function collisionFrom(r: IdRaster): Uint8Array {
  const out = new Uint8Array(r.ids.length);
  for (let i = 0; i < out.length; i++) out[i] = COLLISION[r.ids[i]];
  return out;
}
