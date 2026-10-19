// Street-level ground texturing in the arcade style (docs/ART_STYLE.md section 0):
// flat, saturated colour areas with two or three cel tones each, crisp edges
// between materials and pattern only where it reads as a thing: klinker
// herringbone, tile joints, clean grass tufts and flowers, wave highlights on
// water. Edges come from the id raster: a bright curb with a crisp gutter
// shadow along streets, a pale quay with a dark wall line along canals, a foam
// line along green banks. Decay shows as clear green weeds and clean cracks,
// never as greying.
//
// Only used in detail mode; the overview map keeps its flat cartographic look.
// Everything is a pure function of world position, so chunks tile seamlessly.

import { hash2f } from '../core/rng';
import type { IdRaster } from './raster';
import { GRAIN, IS_ROOF, M, NoiseGrid, type ShadeContext } from './materials';
import { PALETTE, SHADOW_ALPHA, rgbOf } from './palette';

// Groups: how a material is textured
const G_GRASS = 1, G_FARM = 2, G_FOREST = 3, G_SCRUB = 4, G_WETLAND = 5, G_SAND = 6, G_WATER = 7,
  G_ASPHALT = 8, G_BRICK = 9, G_BAY = 10, G_SIDEWALK = 11, G_PATH = 12, G_CYCLE = 13, G_TRACK = 14, G_BALLAST = 15,
  G_RAIL = 16, G_STEEL = 17, G_MARKING = 18, G_PAVERS = 19, G_SLABS = 20, G_YARD = 21, G_RUBBLE = 22, G_SANDBAG = 23,
  G_URBAN = 24;

// Edge classes, and the bits a pixel gets when one of them is next to it (adjacent) or two texels away (near)
const K_OTHER = 0, K_ROOF = 1, K_WATER = 2, K_VEG = 3, K_PAVE = 4;
const ROOF_ADJ = 1, ROOF_NEAR = 2, WATER_ADJ = 4, WATER_NEAR = 8, VEG_ADJ = 16, VEG_NEAR = 32, PAVE_ADJ = 64,
  PAVE_NEAR = 128, OTHER_ADJ = 256, OTHER_NEAR = 512;
const ADJ_BIT = [OTHER_ADJ, ROOF_ADJ, WATER_ADJ, VEG_ADJ, PAVE_ADJ];
const NEAR_BIT = [OTHER_NEAR, ROOF_NEAR, WATER_NEAR, VEG_NEAR, PAVE_NEAR];

// Hints a pass-1 pixel carries in its alpha for pass 2 (refineGround)
const MK_PLAIN = 255, MK_FLOWER = 254, MK_CURB = 253, MK_COURT = 252, MK_QUAY = 251, MK_BED = 250;
const MK_GUTTER_N = 249, MK_GUTTER_W = 248, MK_GUTTER_NW = 247, MK_CRACK = 246;
/** grass: 200 + length * 40 */
const MK_GRASS = 200;

/** Ground materials this module textures (1) in detail mode. */
export const IS_GROUND = new Uint8Array(256);
const GROUP = new Uint8Array(256);
const EDGE = new Uint8Array(256);
/** grass: how long it is by default (0 mown .. 1 wild), how many flowers */
const GLEN = new Float32Array(256);
const GFLOWER = new Float32Array(256);
/** the road-like materials a sidewalk curb faces */
const ROADLIKE = new Uint8Array(256);
let ready = false;

function init() {
  ready = true;
  const g = (ids: number[], group: number, edge: number) => {
    for (const id of ids) { GROUP[id] = group; EDGE[id] = edge; IS_GROUND[id] = 1; }
  };
  g([M.GRASS, M.PARK, M.LAND, M.RESIDENTIAL, M.CEMETERY, M.ALLOTMENT, M.ORCHARD, M.PITCH, M.MILITARY], G_GRASS, K_VEG);
  g([M.FARM], G_FARM, K_VEG);
  g([M.FOREST], G_FOREST, K_VEG);
  g([M.SCRUB], G_SCRUB, K_VEG);
  g([M.WETLAND], G_WETLAND, K_VEG);
  g([M.SAND, M.BEACH, M.CONSTRUCTION], G_SAND, K_OTHER);
  g([M.WATER, M.SEA, M.FLOOD], G_WATER, K_WATER);
  g([M.ROAD, M.ROAD_MINOR, M.MOTORWAY, M.BRIDGE], G_ASPHALT, K_PAVE);
  g([M.ROAD_BRICK], G_BRICK, K_PAVE);
  g([M.PARK_BAY], G_BAY, K_PAVE);
  g([M.SIDEWALK], G_SIDEWALK, K_PAVE);
  g([M.PATH], G_PATH, K_PAVE);
  g([M.CYCLE], G_CYCLE, K_PAVE);
  g([M.TRACK], G_TRACK, K_OTHER);
  g([M.RAILGROUND], G_BALLAST, K_OTHER);
  g([M.RAIL], G_RAIL, K_OTHER);
  g([M.RAIL_STEEL], G_STEEL, K_OTHER);
  g([M.MARKING], G_MARKING, K_PAVE);
  g([M.PARKING, M.COMMERCIAL], G_PAVERS, K_PAVE);
  g([M.INDUSTRIAL], G_SLABS, K_PAVE);
  g([M.FARMYARD], G_YARD, K_OTHER);
  g([M.RUBBLE], G_RUBBLE, K_OTHER);
  g([M.SANDBAG], G_SANDBAG, K_OTHER);
  g([M.URBAN], G_URBAN, K_VEG);
  for (let i = 0; i < 256; i++) if (IS_ROOF[i]) EDGE[i] = K_ROOF;
  const len: [number, number, number][] = [
    [M.GRASS, 0.45, 0.5], [M.PARK, 0.15, 1], [M.LAND, 0.75, 0.3], [M.RESIDENTIAL, 0.25, 0.6], [M.CEMETERY, 0.2, 0.5],
    [M.ALLOTMENT, 0.5, 0.8], [M.ORCHARD, 0.35, 0.5], [M.PITCH, 0, 0], [M.MILITARY, 0.7, 0.1], [M.URBAN, 0.35, 0.4],
    [M.FARM, 0.55, 0.15],
  ];
  for (const [id, l, f] of len) { GLEN[id] = l; GFLOWER[id] = f; }
  for (const id of [M.ROAD, M.ROAD_MINOR, M.MOTORWAY, M.ROAD_BRICK, M.PARK_BAY, M.CYCLE, M.MARKING, M.BRIDGE]) ROADLIKE[id] = 1;
}

// A second, independent grain table
const GRAIN2 = new Float32Array(256 * 256);
for (let i = 0; i < GRAIN2.length; i++) GRAIN2[i] = hash2f(i & 255, i >> 8, 1301);

// Palette tones, unpacked once
const P = PALETTE;
const c = rgbOf;
const GRASS = [c(P.grassLight), c(P.grass), c(P.grassDark)];
const DEEP = c(P.grassDeep), MEADOW = c(P.meadow), CROP = c(P.crop), WHEAT = c(P.wheat), WHEAT_D = c(P.wheatDark);
const SOIL = c(P.soil), SOIL_D = c(P.soilDark), BED = c(P.bed);
const FOREST = c(P.forest), FOREST_D = c(P.forestDark), LITTER = c(P.litter), SCRUB = c(P.scrub), SCRUB_D = c(P.scrubDark);
const WETLAND = c(P.wetland), POOL = c(P.pool);
const FLOWERS = [c(P.flowerYellow), c(P.flowerRed), c(P.flowerWhite), c(P.flowerPurple)];
const WATER = c(P.water), WATER_DEEP = c(P.waterDeep), WATER_LIGHT = c(P.waterLight), FOAM = c(P.foam), SEA = c(P.sea);
const FLOOD = c(P.flood), QUAY = c(P.quay);
const ASPH = c(P.asphalt), ASPH_L = c(P.asphaltLight), CRACK = c(P.crack), MOTORWAY = c(P.motorway);
const BRIDGE = c(P.bridge), MARKING = c(P.marking);
const BRICK = c(P.brick), BAY = c(P.bay);
const SIDEWALK = c(P.sidewalk), CURB = c(P.curb), PATH = c(P.path), CYCLE = c(P.cycle), TRACK = c(P.track);
const PAVERS = c(P.pavers), PARKING = c(P.parking), SLABS = c(P.slabs), YARD = c(P.yard), CONSTR = c(P.construction);
const URBAN = c(P.urban), SAND = c(P.sand), SAND_L = c(P.sandLight), BEACH = c(P.beach);
const BALLAST = c(P.ballast), BALLAST_D = c(P.ballastDark), SLEEPER = c(P.sleeper), STEEL = c(P.steel), RUST = c(P.rust);
const RUBBLE = c(P.rubble), RUBBLE_D = c(P.rubbleDark), SANDBAG = c(P.sandbag), STONE = c(P.quay);
const SH = c(P.shadow);
const SHK = 1 - SHADOW_ALPHA, SHR = SH[0] * SHADOW_ALPHA, SHG = SH[1] * SHADOW_ALPHA, SHB = SH[2] * SHADOW_ALPHA;

/** A per-cell hash in 0..1 from the second grain table. */
const cellHash = (cx: number, cy: number, salt: number) => GRAIN2[(((cy + salt * 7) & 255) << 8) | ((cx + salt * 13) & 255)];

/**
 * Shade every ground pixel of a detail raster into out. Pixels of other
 * materials (roofs, walls, floors) are left for the caller.
 */
export function shadeGround(r: IdRaster, out: Uint8ClampedArray, ctx: ShadeContext, shadow: Uint8Array | null): void {
  if (!ready) init();
  const { w, h, ids, aux } = r;
  const { wx0, wy0, tpp } = ctx;
  const over = ctx.overgrowth, dmg = ctx.damage;
  // fine: this is pass 1 of a 2x render; leave sub-texel patterns to refineGround and pass hints in alpha
  const fine = (ctx.scale ?? 1) > 1;
  const GR = GRAIN, G2 = GRAIN2;
  const grid = (scale: number, step: number, seed: number) => new NoiseGrid(wx0, wy0, w, h, tpp, scale, step, seed);
  const nGrass = grid(22, 4, 3), nPatch = grid(45, 8, 32), nFlower = grid(26, 8, 33);
  const nGarden = grid(10, 4, 35), nWear = grid(30, 6, 37), nCrack = grid(14, 3, 21);
  const nForest = grid(9, 3, 39), nWet = grid(16, 4, 40);
  // weeds come up in clear clumps as nature returns
  const weedP = over * 0.22, weedT = 0.76 - over * 0.2;
  // output as packed little-endian RGBA words: one store per pixel
  const out32 = new Uint32Array(out.buffer, out.byteOffset, out.length >> 2);
  const unit = tpp === 1 && wx0 === Math.floor(wx0);

  // Edge pass: for each pixel, which kinds of material are 1 and 2 texels away
  const E = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const p = ids[i];
      // most neighbours share the material: compare ids before looking up classes
      if (x + 1 < w && ids[i + 1] !== p) {
        const a = EDGE[p], b = EDGE[ids[i + 1]];
        if (a !== b) {
          E[i] |= ADJ_BIT[b]; E[i + 1] |= ADJ_BIT[a];
          if (x > 0) E[i - 1] |= NEAR_BIT[b];
          if (x + 2 < w) E[i + 2] |= NEAR_BIT[a];
        }
      }
      if (y + 1 < h && ids[i + w] !== p) {
        const a = EDGE[p], b = EDGE[ids[i + w]];
        if (a !== b) {
          E[i] |= ADJ_BIT[b]; E[i + w] |= ADJ_BIT[a];
          if (y > 0) E[i - w] |= NEAR_BIT[b];
          if (y + 2 < h) E[i + 2 * w] |= NEAR_BIT[a];
        }
      }
    }
  }

  for (let y = 0; y < h; y++) {
    const wy = Math.floor(wy0 + y * tpp);
    const rowG = (wy & 255) << 8;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const id = ids[i];
      if (!IS_GROUND[id]) continue;
      const wx = unit ? wx0 + x : Math.floor(wx0 + x * tpp);
      const gx = wx & 255;
      const g = GR[rowG | gx], g2 = G2[rowG | gx];
      const e = E[i];
      const grp = GROUP[id];
      const weeds = g2 < weedP && grp >= G_ASPHALT && nPatch.at(x, y) > weedT;
      let col = GRASS[1];
      let f = 1;
      let built = false;
      let done = false;
      let mark = MK_PLAIN;

      // Where land meets water: a pale quay along paved banks, a dark grass edge along green ones
      if (e & WATER_ADJ && grp !== G_WATER) {
        const ek = EDGE[id];
        if (ek === K_PAVE || grp === G_URBAN || grp === G_SLABS || id === M.RESIDENTIAL) {
          col = QUAY; mark = MK_QUAY; built = true; done = true;
        } else if (ek === K_VEG) {
          col = DEEP; done = true;
        }
      }

      if (!done) switch (grp) {
        case G_GRASS: case G_URBAN: {
          // Urban fill: tiled yards between scruffy lawns
          if (grp === G_URBAN && nPatch.at(x, y) < 0.6) {
            col = URBAN;
            if (!fine && ((wx + ((wy >> 1) & 1)) & 1) === 0 && (wy & 1)) f = 0.92;
            mark = MK_COURT;
            if (weeds) col = GRASS[2];
            built = true;
            break;
          }
          // Gardens: flower beds between the lawns
          if (id === M.RESIDENTIAL && nGarden.at(x, y) > 0.82) {
            // planted in tidy rows, one kind of flower per bed
            col = BED; mark = MK_BED;
            if (wy % 3 === 1) {
              const fl = cellHash((wx / 8) | 0, (wy / 8) | 0, 3);
              col = (wx & 1) === 0 && fl > over * 0.6 ? FLOWERS[(fl * 977) & 3] : GRASS[2];
              if (col !== GRASS[2]) mark = MK_FLOWER;
            }
            break;
          }
          if (id === M.CEMETERY) {
            const mx = wx % 6, my = wy % 9;
            if (mx < 2 && my === 3) { col = STONE; built = true; break; }
            if (mx < 2 && my === 4) { col = DEEP; break; }
          }
          if (id === M.ALLOTMENT) {
            const ax = wx % 18, ay = wy % 12;
            if (ax !== 0 && ay !== 0) {
              const plot = G2[(((wy / 12) | 0) & 255) << 8 | (((wx / 18) | 0) & 255)];
              if (plot < 0.7 - over * 0.5) {
                col = (wy & 1) === 0 && plot > 0.25 ? CROP : SOIL;
                mark = MK_BED;
                break;
              }
            }
          }
          const av = aux[i];
          let len = GLEN[id] + over * 0.4 + (av ? ((av >> 2) & 7) / 7 - 0.5 : 0) * 0.3;
          if (len < 0) len = 0; else if (len > 1) len = 1;
          // three flat tones in big clean patches: light (mown), base, dark (long)
          const n = nGrass.at(x, y);
          col = n > 0.74 - len * 0.1 ? GRASS[2] : n < 0.45 && nGarden.at(x, y) < 0.2 + (1 - len) * 0.06 ? GRASS[0] : GRASS[1];
          if (id === M.LAND || id === M.MILITARY) col = col === GRASS[0] ? MEADOW : col;
          if (id === M.PITCH) {
            col = ((wx >> 3) & 1) ? GRASS[0] : GRASS[1];
            if (wx % 64 === 0 || wy % 96 === 0) { col = MARKING; built = true; break; }
          }
          if (id === M.ORCHARD && wx % 14 < 2) col = GRASS[2];
          if (fine) mark = MK_GRASS + Math.round(len * 40);
          else {
            // a tuft: dark blade with a light tip above it, one per 5x5 cell at most
            const cx = (wx / 5) | 0, cy = (wy / 5) | 0;
            const hc = cellHash(cx, cy, 1);
            if (hc < 0.08 + len * 0.3) {
              const tx = cx * 5 + 1 + ((hc * 31) | 0) % 3, ty = cy * 5 + 1 + ((hc * 97) | 0) % 3;
              if (wx === tx && wy === ty) col = DEEP;
              else if (wx === tx && wy === ty - 1) col = GRASS[0];
            }
          }
          // flowers in patches
          const fd = GFLOWER[id] * (nFlower.at(x, y) - 0.45);
          if (fd > 0 && g2 > 1 - fd * 0.04) {
            col = FLOWERS[(g * 977) & 3];
            mark = MK_FLOWER;
          }
          break;
        }
        case G_FARM: {
          // each field has its own crop, rows run along its long axis
          const av = aux[i];
          const type = av ? (av >> 2) / 64 : 0;
          const d = av & 3;
          const u = d === 0 ? wy : d === 1 ? wx : d === 2 ? wx - wy : wx + wy;
          const stripe = (u >> 1) & 1;
          if (type < 0.48) {
            // meadow (most Dutch farmland is pasture)
            const n = nGrass.at(x, y);
            col = n > 0.7 ? GRASS[2] : n < 0.28 ? GRASS[0] : MEADOW;
            if (fine) mark = MK_GRASS + 22;
            else if (g > 0.985) col = DEEP;
          } else if (type < 0.66) {
            // green crop rows over soil, rows get ragged as weeds take over
            col = stripe && g > over * 0.3 ? SOIL : CROP;
          } else if (type < 0.82) {
            // ripe grain
            col = stripe ? WHEAT_D : WHEAT;
            if (g2 < over * 0.05) col = GRASS[2];
          } else {
            // ploughed earth
            col = stripe ? SOIL_D : SOIL;
            if (g2 < over * 0.1) col = GRASS[2];
          }
          break;
        }
        case G_FOREST: {
          // forest floor: deep green with darker hollows and patches of leaf litter
          const n = nForest.at(x, y);
          col = n > 0.66 ? FOREST_D : n < 0.22 ? LITTER : FOREST;
          if (fine && col !== LITTER) mark = MK_GRASS + 30;
          break;
        }
        case G_SCRUB: {
          col = nGrass.at(x, y) > 0.55 ? SCRUB_D : SCRUB;
          if (fine) mark = MK_GRASS + 36;
          break;
        }
        case G_WETLAND: {
          if (nWet.at(x, y) > 0.66) { col = POOL; break; }
          col = WETLAND;
          if (fine) mark = MK_GRASS + 36;
          break;
        }
        case G_SAND: {
          if (id === M.CONSTRUCTION) {
            col = nWet.at(x, y) > 0.7 ? SOIL : CONSTR;
            if (((wx + (wy >> 2)) % 9) === 0) f = 0.9; // tyre tracks
            built = true;
            break;
          }
          col = id === M.BEACH ? BEACH : SAND;
          // clean wind ripples
          if ((wy + (wx >> 3)) % 6 === 0) col = SAND_L;
          // marram grass on the dunes
          if (id === M.SAND && nPatch.at(x, y) > 0.62 && g2 > 0.8) col = SCRUB_D;
          break;
        }
        case G_WATER: {
          if (id === M.FLOOD) { col = g > 0.97 ? GRASS[1] : FLOOD; break; }
          col = id === M.SEA ? SEA : WATER;
          // a dark line under quay walls and buildings; a light foam line along soft banks
          if (e & (ROOF_ADJ | PAVE_ADJ)) col = WATER_DEEP, f = 0.82;
          else if (e & (VEG_ADJ | OTHER_ADJ)) col = id === M.SEA && e & OTHER_ADJ ? FOAM : WATER_LIGHT;
          else if (id === M.SEA && e & OTHER_NEAR) col = WATER_LIGHT;
          else if (!fine) {
            // a wave crest: two light texels in a 7x5 cell
            const cx = (wx / 7) | 0, cy = (wy / 5) | 0;
            const hc = cellHash(cx, cy, 2);
            if (hc < 0.4) {
              const tx = cx * 7 + 1 + ((hc * 53) | 0) % 4, ty = cy * 5 + 1 + ((hc * 89) | 0) % 3;
              if (wy === ty && (wx === tx || wx === tx + 1)) col = WATER_LIGHT;
            }
          }
          break;
        }
        case G_ASPHALT: {
          col = id === M.MOTORWAY ? MOTORWAY : id === M.BRIDGE ? BRIDGE : ASPH;
          if (id !== M.BRIDGE) {
            const wear = nWear.at(x, y);
            if (wear > 0.8) col = ASPH_L;
          }
          // the odd clean crack, which weeds take over
          const crack = Math.abs(nCrack.at(x, y) - 0.5);
          if (crack < 0.012 * (0.3 + dmg + over * 0.5) && nPatch.at(x, y) > 0.45) {
            col = g2 < over * 0.6 ? GRASS[2] : CRACK;
            mark = MK_CRACK;
          }
          built = true;
          break;
        }
        case G_BRICK: {
          // klinkers in herringbone: 2x1 bricks alternating horizontal and vertical
          col = BRICK;
          if (weeds && g < 0.5) { col = GRASS[2]; built = true; break; }
          if (!fine) {
            const d = (wx - wy) & 3;
            if (d >= 2) f = 0.88;
            if (d === 1 || d === 2) f *= 0.95;
          }
          built = true;
          break;
        }
        case G_BAY: {
          col = BAY;
          if (weeds) col = GRASS[2];
          else if (!fine && (wy & 1)) f = 0.92;
          built = true;
          break;
        }
        case G_SIDEWALK: {
          // stoeptegels with a bright curb along the road
          const curb = (x > 0 && ROADLIKE[ids[i - 1]]) || (x + 1 < w && ROADLIKE[ids[i + 1]]) ||
            (y > 0 && ROADLIKE[ids[i - w]]) || (y + 1 < h && ROADLIKE[ids[i + w]]);
          if (curb) { col = CURB; mark = MK_CURB; }
          else {
            col = SIDEWALK;
            if (!fine && (wx % 3 === 2 || wy % 3 === 2)) f = 0.94;
            if (weeds) col = GRASS[2];
          }
          built = true;
          break;
        }
        case G_PATH: {
          col = weeds ? GRASS[2] : PATH;
          if (!fine && !weeds && ((wx & 3) === 3 || (wy & 3) === 3)) f = 0.93;
          built = true;
          break;
        }
        case G_CYCLE: {
          col = CYCLE;
          const road = (x > 0 && GROUP[ids[i - 1]] === G_ASPHALT) || (x + 1 < w && GROUP[ids[i + 1]] === G_ASPHALT) ||
            (y > 0 && GROUP[ids[i - w]] === G_ASPHALT) || (y + 1 < h && GROUP[ids[i + w]] === G_ASPHALT);
          if (road && ((wx + wy) % 6) < 4) col = MARKING;
          built = true;
          break;
        }
        case G_TRACK: {
          col = TRACK;
          if (nGrass.at(x, y) + (g2 - 0.5) * 0.1 > 0.72 - over * 0.2) col = GRASS[2];
          break;
        }
        case G_BALLAST: {
          col = BALLAST;
          if (g < 0.15) col = BALLAST_D;
          if (g2 < over * 0.15) col = GRASS[2];
          break;
        }
        case G_RAIL: {
          col = (wx + wy) % 3 === 0 ? SLEEPER : BALLAST;
          if (g2 < over * 0.08) col = GRASS[2];
          break;
        }
        case G_STEEL: {
          col = g2 < over * 0.6 ? RUST : STEEL;
          break;
        }
        case G_MARKING: {
          col = MARKING;
          if (g < dmg * 0.15) col = ASPH_L;
          built = true;
          break;
        }
        case G_PAVERS: {
          col = id === M.PARKING ? PARKING : PAVERS;
          if (weeds) col = GRASS[2];
          else if (!fine && (wy & 1)) f = 0.94;
          built = true;
          break;
        }
        case G_SLABS: {
          // industrial yards: big concrete slabs, weeds in the joints
          col = SLABS;
          if ((wx & 7) === 0 || (wy & 7) === 0) {
            f = 0.9;
            if (g < over * 0.4) { col = GRASS[2]; f = 1; }
          }
          built = true;
          break;
        }
        case G_YARD: {
          col = YARD;
          if (nGarden.at(x, y) > 0.92 - over * 0.1) col = GRASS[2];
          else if (fine) mark = MK_GRASS;
          break;
        }
        case G_RUBBLE: {
          col = g < 0.3 ? BRICK : g < 0.65 ? RUBBLE : RUBBLE_D;
          break;
        }
        case G_SANDBAG: {
          col = SANDBAG;
          if (((wx + (wy & 1)) & 1) === 0 && (wy & 1)) f = 0.8;
          break;
        }
      }

      // paving grows a clean fringe of grass along green edges as nature returns
      if (built && e & VEG_ADJ && g2 < over * 0.35) col = GRASS[2], f = 1, built = false;
      let cr = col[0] * f, cg = col[1] * f, cb = col[2] * f;
      // gutter: the curb casts a crisp line of shade onto the road south-east of it
      if (ROADLIKE[id] && mark === MK_PLAIN) {
        const n = y > 0 && GROUP[ids[i - w]] === G_SIDEWALK, wv = x > 0 && GROUP[ids[i - 1]] === G_SIDEWALK;
        if (n || wv) {
          if (fine) mark = n && wv ? MK_GUTTER_NW : n ? MK_GUTTER_N : MK_GUTTER_W;
          else { cr *= 0.8; cg *= 0.8; cb *= 0.84; }
        }
      }
      // one solid, translucent drop shadow to the south-east
      if (shadow && shadow[i]) { cr = cr * SHK + SHR; cg = cg * SHK + SHG; cb = cb * SHK + SHB; }
      out32[i] = pack(cr, cg, cb, fine ? mark : 255);
    }
  }
}

/** RGBA bytes (clamped) as one little-endian word. */
function pack(r: number, g: number, b: number, a: number): number {
  const R = r > 255 ? 255 : r < 0 ? 0 : (r + 0.5) | 0;
  const G = g > 255 ? 255 : g < 0 ? 0 : (g + 0.5) | 0;
  const B = b > 255 ? 255 : b < 0 ? 0 : (b + 0.5) | 0;
  return ((a << 24) | (B << 16) | (G << 8) | R) >>> 0;
}

/** Art-pixel offsets of a grass tuft (two little blades) and a wave crest, as [dx, dy, tone] with tone 0 dark, 1 light. */
const TUFT: number[] = [0, 0, 0, 2, 0, 1, 4, 0, 0, 1, 1, 0, 2, 1, 0, 3, 1, 0];
const WAVE: number[] = [1, 0, 1, 2, 0, 1, 0, 1, 1, 3, 1, 1];

/**
 * Pass 2 of a 2x render: every texel becomes 2x2 art pixels. Material edges are
 * smoothed (EPX on the id raster, so diagonal kerbs and banks lose their
 * staircase), and the patterns that do not fit in a 0.37 m texel are drawn
 * here: klinker herringbone, tile and paver joints, grass tufts, wave crests.
 * Patterns only scale the pass-1 colour, so shadows baked into it survive.
 * Roofs and other non-ground texels are just doubled.
 * base is the pass-1 output (with decals); out is (2w x 2h) RGBA.
 */
export function refineGround(r: IdRaster, base: Uint8ClampedArray, out: Uint8ClampedArray, ctx: ShadeContext): void {
  if (!ready) init();
  const { w, h, ids } = r;
  const W = w * 2;
  const G2 = GRAIN2;
  const ax0 = Math.floor(ctx.wx0) * 2, ay0 = Math.floor(ctx.wy0) * 2;
  const out32 = new Uint32Array(out.buffer, out.byteOffset, out.length >> 2);
  const base32 = new Uint32Array(base.buffer, base.byteOffset, base.length >> 2);
  // per art pixel: is there a tuft / wave here, and which tone (0 none, 1 dark, 2 light)
  const shapeAt = (ax: number, ay: number, cell: number, cellH: number, salt: number, dens: number, shape: number[]) => {
    const cx = Math.floor(ax / cell), cy = Math.floor(ay / cellH);
    const hc = cellHash(cx, cy, salt);
    if (hc >= dens) return 0;
    const dx = ax - cx * cell - 1 - (((hc * 131) | 0) % (cell - 6));
    const dy = ay - cy * cellH - 1 - (((hc * 37) | 0) % (cellH - 3));
    if (dx < 0 || dy < 0 || dx > 4 || dy > 1) return 0;
    for (let k = 0; k < shape.length; k += 3) if (shape[k] === dx && shape[k + 1] === dy) return shape[k + 2] + 1;
    return 0;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const P0 = ids[i];
      if (!IS_GROUND[P0]) {
        // doubled as is
        const v = (base32[i] | 0xff000000) >>> 0;
        const o = y * 2 * W + x * 2;
        out32[o] = out32[o + 1] = out32[o + W] = out32[o + W + 1] = v;
        continue;
      }
      const A = y > 0 ? ids[i - w] : P0, D = y + 1 < h ? ids[i + w] : P0;
      const Cl = x > 0 ? ids[i - 1] : P0, B = x + 1 < w ? ids[i + 1] : P0;
      for (let sy = 0; sy < 2; sy++) {
        const ay = ay0 + y * 2 + sy;
        for (let sx = 0; sx < 2; sx++) {
          const ax = ax0 + x * 2 + sx;
          // EPX: a corner takes the neighbour's material where two neighbours agree on it
          let src = i;
          const v = sy === 0 ? A : D, hz = sx === 0 ? Cl : B, vo = sy === 0 ? D : A, ho = sx === 0 ? B : Cl;
          if (v === hz && v !== P0 && v !== vo && hz !== ho && IS_GROUND[v] && v !== M.MARKING && P0 !== M.MARKING) src = sy === 0 ? i - w : i + w;
          else if (v === P0 && hz === P0 && x > 0 && y > 0 && x + 1 < w && y + 1 < h) {
            // the same inside one material, on its flat tones: patch edges lose their staircase too
            const iv = sy === 0 ? i - w : i + w, ih = sx === 0 ? i - 1 : i + 1;
            const cv = base32[iv], ch = base32[ih];
            if (cv === ch && cv !== base32[i] && cv !== base32[sy === 0 ? i + w : i - w] && ch !== base32[sx === 0 ? i + 1 : i - 1]) src = iv;
          }
          const so = src * 4;
          let cr = base[so], cg = base[so + 1], cb = base[so + 2];
          const sid = ids[src], mark = base[so + 3];
          let f = 1;
          if (mark === MK_PLAIN || mark >= MK_GRASS && mark <= MK_GRASS + 40) {
            switch (GROUP[sid]) {
              case G_GRASS: case G_URBAN: case G_SCRUB: case G_WETLAND: case G_FARM: case G_FOREST: case G_YARD: {
                if (mark === MK_PLAIN) break;
                const len = (mark - MK_GRASS) / 40;
                const t = shapeAt(ax, ay, 9, 7, 1, 0.08 + len * 0.3, TUFT);
                if (t === 1) f = 0.7; else if (t === 2) f = 1.22;
                break;
              }
              case G_SAND:
                if (G2[((ay & 255) << 8) | (ax & 255)] > 0.997) { cr = cg = cb = 255; }
                break;
              case G_BRICK: {
                if (cg > cr) break; // weeds
                // klinkers in herringbone, one 2x1 brick per two art pixels:
                // lying bricks catch the light, standing ones read a shade darker
                const d = (ax - ay) & 3;
                f = d >= 2 ? 0.86 : 1;
                if (d === 1 || d === 2) f *= 0.93;
                break;
              }
              case G_BAY: case G_PAVERS: {
                if (cg > cr && GROUP[sid] === G_BAY) break;
                // stretcher bond: courses 3 art pixels tall, bricks 4 wide, half a brick offset
                const course = Math.floor(ay / 3);
                const jy = ay - course * 3 === 2, jx = ((ax + (course & 1) * 2) & 3) === 3;
                f = jy || jx ? 0.86 : 1;
                break;
              }
              case G_SIDEWALK: {
                if (cg > cr + 8) break;
                // stoeptegels: 4x4 art pixel tiles with a clean joint
                f = (ax & 3) === 3 || (ay & 3) === 3 ? 0.9 : 1;
                break;
              }
              case G_PATH: {
                if (cg > cr) break;
                f = (ax % 6 === 5 || ay % 6 === 5) ? 0.92 : 1;
                break;
              }
              case G_SLABS: {
                f = ((ax & 15) === 0 || (ay & 15) === 0) ? 0.9 : 1;
                break;
              }
              case G_WATER: {
                if (sid === M.FLOOD) break;
                const t = shapeAt(ax, ay, 12, 7, 2, sid === M.SEA ? 0.3 : 0.4, WAVE);
                if (t) { cr += (255 - cr) * 0.45; cg += (255 - cg) * 0.4; cb += (255 - cb) * 0.25; }
                break;
              }
            }
          } else if (mark === MK_FLOWER) {
            // a bloom: three petals and a bright centre on the bottom right
            if (sx === 1 && sy === 1) { cr += (255 - cr) * 0.7; cg += (240 - cg) * 0.7; cb += (120 - cb) * 0.7; }
          } else if (mark === MK_COURT) {
            const course = Math.floor(ay / 3);
            f = ay - course * 3 === 2 || ((ax + (course & 1) * 2) & 3) === 3 ? 0.88 : 1;
          } else if (mark === MK_CURB) {
            // the curb: a bright top with the face a shade darker on its south side
            if (sy === 1 && ROADLIKE[D]) f = 0.86;
            else if (sx === 1 && ROADLIKE[B]) f = 0.9;
          } else if (mark === MK_QUAY) {
            // capping stones; the edge over the water is the wall top, a shade darker
            if ((sy === 1 && GROUP[D] === G_WATER) || (sx === 1 && GROUP[B] === G_WATER)) f = 0.8;
            else if (ax % 6 === 5 || ay % 6 === 5) f = 0.93;
          } else if (mark === MK_GUTTER_N || mark === MK_GUTTER_W || mark === MK_GUTTER_NW) {
            // the gutter: only the half of the texel against the curb is in its shade
            if ((sy === 0 && mark !== MK_GUTTER_W) || (sx === 0 && mark !== MK_GUTTER_N)) f = 0.78;
            else if (GROUP[sid] === G_BRICK) {
              const d = (ax - ay) & 3;
              f = (d >= 2 ? 0.86 : 1) * (d === 1 || d === 2 ? 0.93 : 1);
            }
          } else if (mark === MK_CRACK) {
            // cracks are a single art pixel wide
            if ((ax + ay) & 1) {
              const so2 = (sx === 0 && x + 1 < w ? i + 1 : x > 0 ? i - 1 : i) * 4;
              if (base[so2 + 3] !== MK_CRACK) { cr = base[so2]; cg = base[so2 + 1]; cb = base[so2 + 2]; }
            }
          }
          out32[(y * 2 + sy) * W + x * 2 + sx] = pack(cr * f, cg * f, cb * f, 255);
        }
      }
    }
  }
}
