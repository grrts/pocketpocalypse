// Material ids, their pixel-art palette and procedural texturing, plus how each
// one behaves for movement. One table drives both rendering and collision.

import { hash2f, valueNoise } from '../core/rng';
import { IS_GROUND, refineGround, shadeGround } from './ground';
import { PALETTE } from './palette';
import type { IdRaster } from './raster';

export const M = {
  SEA: 0, LAND: 1, GRASS: 2, FARM: 3, FOREST: 4, SCRUB: 5, WETLAND: 6, SAND: 7, RESIDENTIAL: 8, COMMERCIAL: 9,
  INDUSTRIAL: 10, PARK: 11, CEMETERY: 12, MILITARY: 13, RAILGROUND: 14, PARKING: 15, PITCH: 16, WATER: 17, FLOOD: 18,
  ROAD: 19, ROAD_MINOR: 20, PATH: 21, CYCLE: 22, RAIL: 23, ROOF_RED: 24, ROOF_BROWN: 25, ROOF_GRAY: 26,
  ROOF_FLAT: 27, ROOF_METAL: 28, ROOF_SLATE: 29, GLASS: 30, ROOF_BURNT: 31, WALL: 32, BRIDGE: 33, MOTORWAY: 34,
  FARMYARD: 35, ORCHARD: 36, BEACH: 37, CONSTRUCTION: 38, ALLOTMENT: 39, URBAN: 40, SIDEWALK: 41, MARKING: 42,
  RUBBLE: 43, SANDBAG: 44, ROOF_DARK: 45, TRACK: 46, OV_MOTORWAY: 47, OV_ROAD: 48, OV_RAIL: 49,
  FLOOR_WOOD: 50, FLOOR_TILE: 51, FLOOR_CARPET: 52, FLOOR_CONCRETE: 53, INNER_WALL: 54, FURNITURE: 55, FLOOR_STONE: 56,
  // street-level ground detail
  ROAD_BRICK: 80, PARK_BAY: 81, RAIL_STEEL: 82,
  // building insides (60-69)
  OUTER_WALL: 60, DOORWAY: 61,
  // the ground a building stands on; the building itself is drawn as geometry (render/buildingDraw.ts)
  FOOTPRINT: 62,
} as const;

/** Movement classes stored in the collision grid. */
export const C = { WALK: 0, SOLID: 1, DEEP: 2, SLOW: 3, ROUGH: 4 } as const;

type RGB = [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// The shared arcade palette lives in palette.ts (so ground.ts can use it at load
// time without an import cycle) and is published from here.
export { PALETTE, SHADOW_ALPHA, rgbOf } from './palette';

const P = PALETTE;

interface MatDef {
  color: RGB;
  col: number;
  roof?: boolean;
}

const T: Record<number, MatDef> = {
  [M.SEA]: { color: hex(P.sea), col: C.DEEP },
  [M.LAND]: { color: hex(P.meadow), col: C.WALK },
  [M.GRASS]: { color: hex(P.grass), col: C.WALK },
  [M.FARM]: { color: hex(P.meadow), col: C.WALK },
  [M.FOREST]: { color: hex(P.forest), col: C.ROUGH },
  // 70: forest floor under real trees (src/world/vegetation.ts FOREST_FLOOR)
  70: { color: hex(P.forest), col: C.WALK },
  [M.SCRUB]: { color: hex(P.scrub), col: C.ROUGH },
  [M.WETLAND]: { color: hex(P.wetland), col: C.SLOW },
  [M.SAND]: { color: hex(P.sand), col: C.WALK },
  // the overview map shows towns as a warm light tint; street level paints gardens over it
  [M.RESIDENTIAL]: { color: hex('#cfd0a2'), col: C.WALK },
  [M.COMMERCIAL]: { color: hex(P.pavers), col: C.WALK },
  [M.INDUSTRIAL]: { color: hex(P.slabs), col: C.WALK },
  [M.PARK]: { color: hex(P.grass), col: C.WALK },
  [M.CEMETERY]: { color: hex(P.grassDark), col: C.WALK },
  [M.MILITARY]: { color: hex(P.meadow), col: C.WALK },
  [M.RAILGROUND]: { color: hex(P.ballast), col: C.WALK },
  [M.PARKING]: { color: hex(P.parking), col: C.WALK },
  [M.PITCH]: { color: hex(P.grass), col: C.WALK },
  [M.WATER]: { color: hex(P.water), col: C.DEEP },
  [M.FLOOD]: { color: hex(P.flood), col: C.SLOW },
  [M.ROAD]: { color: hex(P.asphalt), col: C.WALK },
  [M.ROAD_MINOR]: { color: hex(P.asphalt), col: C.WALK },
  [M.PATH]: { color: hex(P.path), col: C.WALK },
  [M.CYCLE]: { color: hex(P.cycle), col: C.WALK },
  [M.RAIL]: { color: hex(P.sleeper), col: C.WALK },
  [M.ROOF_RED]: { color: hex(P.roofRed), col: C.SOLID, roof: true },
  [M.ROOF_BROWN]: { color: hex(P.roofBrown), col: C.SOLID, roof: true },
  [M.ROOF_GRAY]: { color: hex(P.roofGray), col: C.SOLID, roof: true },
  [M.ROOF_FLAT]: { color: hex(P.roofFlat), col: C.SOLID, roof: true },
  [M.ROOF_METAL]: { color: hex(P.roofMetal), col: C.SOLID, roof: true },
  [M.ROOF_SLATE]: { color: hex(P.roofSlate), col: C.SOLID, roof: true },
  [M.GLASS]: { color: hex(P.glass), col: C.SOLID, roof: true },
  [M.ROOF_BURNT]: { color: hex(P.roofBurnt), col: C.SOLID, roof: true },
  [M.ROOF_DARK]: { color: hex(P.roofDark), col: C.SOLID, roof: true },
  [M.WALL]: { color: hex(P.wall), col: C.SOLID, roof: true },
  [M.FOOTPRINT]: { color: hex(P.slabs), col: C.SOLID, roof: true },
  [M.BRIDGE]: { color: hex(P.bridge), col: C.WALK },
  [M.MOTORWAY]: { color: hex(P.motorway), col: C.WALK },
  [M.FARMYARD]: { color: hex(P.yard), col: C.WALK },
  [M.ORCHARD]: { color: hex(P.meadow), col: C.WALK },
  [M.BEACH]: { color: hex(P.beach), col: C.WALK },
  [M.CONSTRUCTION]: { color: hex(P.construction), col: C.WALK },
  [M.ALLOTMENT]: { color: hex(P.grass), col: C.WALK },
  [M.URBAN]: { color: hex(P.urban), col: C.WALK },
  [M.SIDEWALK]: { color: hex(P.sidewalk), col: C.WALK },
  [M.MARKING]: { color: hex(P.marking), col: C.WALK },
  [M.RUBBLE]: { color: hex(P.rubble), col: C.ROUGH },
  [M.SANDBAG]: { color: hex(P.sandbag), col: C.SOLID },
  [M.TRACK]: { color: hex(P.track), col: C.WALK },
  [M.OV_MOTORWAY]: { color: hex('#f0b24a'), col: C.WALK },
  [M.OV_ROAD]: { color: hex('#e6e1d4'), col: C.WALK },
  [M.OV_RAIL]: { color: hex('#5a5468'), col: C.WALK },
  // klinker streets, parking bays and rails (textured in ground.ts)
  [M.ROAD_BRICK]: { color: hex(P.brick), col: C.WALK },
  [M.PARK_BAY]: { color: hex(P.bay), col: C.WALK },
  [M.RAIL_STEEL]: { color: hex(P.steel), col: C.WALK },
  // building interiors, seen only once you step inside
  [M.FLOOR_WOOD]: { color: hex('#a0764a'), col: C.WALK },
  [M.FLOOR_TILE]: { color: hex('#c8c2b4'), col: C.WALK },
  [M.FLOOR_CARPET]: { color: hex('#6e6a78'), col: C.WALK },
  [M.FLOOR_CONCRETE]: { color: hex('#8e8b85'), col: C.WALK },
  [M.FLOOR_STONE]: { color: hex('#9a9180'), col: C.WALK },
  [M.INNER_WALL]: { color: hex('#e4ddcf'), col: C.SOLID },
  [M.FURNITURE]: { color: hex('#5a3f2c'), col: C.SOLID },
  [M.OUTER_WALL]: { color: hex('#b9ae9c'), col: C.SOLID },
  [M.DOORWAY]: { color: hex('#7a5a3c'), col: C.WALK },
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
  /**
   * 2: this is pass 1 of a 2x street-level render; follow with refineRaster.
   * Ground pixels then carry hints for pass 2 in their alpha.
   */
  scale?: number;
  /** Set by shadeRaster in detail mode: 1 where a building casts its drop shadow. */
  shadow?: Uint8Array;
}

/**
 * Smooth noise sampled on a coarse lattice and bilinearly interpolated, which is
 * much cheaper than evaluating value noise per pixel. Computed on first use.
 */
export class NoiseGrid {
  private data: Float32Array | null = null;
  private cols: number;
  private inv: number;
  constructor(private wx0: number, private wy0: number, w: number, private h: number, private tpp: number,
    private scale: number, private step: number, private seed: number) {
    this.cols = Math.ceil(w / step) + 2;
    this.inv = 1 / step;
  }
  private build(): Float32Array {
    const rows = Math.ceil(this.h / this.step) + 2;
    const d = new Float32Array(this.cols * rows);
    const k = (this.step * this.tpp) / this.scale;
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < this.cols; gx++) {
        d[gy * this.cols + gx] = valueNoise(this.wx0 / this.scale + gx * k, this.wy0 / this.scale + gy * k, this.seed);
      }
    }
    return (this.data = d);
  }
  at(x: number, y: number): number {
    const d = this.data ?? this.build();
    const fx = x * this.inv, fy = y * this.inv;
    const ix = fx | 0, iy = fy | 0;
    const ax = fx - ix, ay = fy - iy;
    const c = this.cols, i = iy * c + ix;
    const top = d[i] + (d[i + 1] - d[i]) * ax;
    const bot = d[i + c] + (d[i + c + 1] - d[i + c]) * ax;
    return top + (bot - top) * ay;
  }
}

// 256x256 tile of per-texel random values ("grain"); repeats every ~95 m, which is invisible
export const GRAIN = new Float32Array(256 * 256);
for (let i = 0; i < GRAIN.length; i++) GRAIN[i] = hash2f(i & 255, i >> 8, 7);

/** Turn a material-id raster into RGBA pixels with procedural texture. */
export function shadeRaster(r: IdRaster, out: Uint8ClampedArray, ctx: ShadeContext): void {
  const { w, h, ids, aux } = r;
  const { wx0, wy0, tpp, detail } = ctx;
  const grid = (scale: number, step: number, seed: number) => new NoiseGrid(wx0, wy0, w, h, tpp, scale, step, seed);
  const nOverview = grid(40, 8, 2);
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
    ctx.shadow = shadow;
    // grass, paving, water and the rest of the ground
    shadeGround(r, out, ctx, shadow);
  }
  for (let y = 0; y < h; y++) {
    const wy = Math.floor(wy0 + y * tpp);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const id = ids[i];
      if (detail && IS_GROUND[id]) continue;
      const wx = Math.floor(wx0 + x * tpp);
      let cr = BASE[id * 3], cg = BASE[id * 3 + 1], cb = BASE[id * 3 + 2];
      const g = GRAIN[((wy & 255) << 8) | (wx & 255)];
      let f = 1 + (g - 0.5) * (detail ? 0.08 : 0.04);
      if (detail) {
        switch (id) {
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

/**
 * Pass 2 of a 2x render: from the pass-1 pixels (shadeRaster with scale 2, plus
 * any decals) to a (2w x 2h) RGBA image with sub-texel ground detail.
 */
export function refineRaster(r: IdRaster, base: Uint8ClampedArray, ctx: ShadeContext): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 16);
  refineGround(r, base, out, ctx);
  return out;
}

/** Collision grid from a material raster. */
export function collisionFrom(r: IdRaster): Uint8Array {
  const out = new Uint8Array(r.ids.length);
  for (let i = 0; i < out.length; i++) out[i] = COLLISION[r.ids[i]];
  return out;
}
