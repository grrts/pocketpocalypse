// Street-level ground texturing: turns ground material ids into a lived-in,
// weathered place instead of flat map colours. Grass with tufts and flowers,
// klinker streets, tiled sidewalks with curbs, asphalt with wear, canals with
// quay edges, crop rows, forest floor, sand. Edges between materials are read
// from the id raster so things sit in the world: curbs and gutters along
// streets, soft darkening next to walls, quays and banks along water, and
// grass creeping over paving as the days pass.
//
// Only used in detail mode; the overview map keeps its flat cartographic look.
// Everything is a pure function of world position, so chunks tile seamlessly.

import { hash2f } from '../core/rng';
import type { IdRaster } from './raster';
import { GRAIN, IS_ROOF, M, NoiseGrid, type ShadeContext } from './materials';

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
    [M.GRASS, 0.45, 0.6], [M.PARK, 0.15, 1], [M.LAND, 0.75, 0.35], [M.RESIDENTIAL, 0.2, 0.5], [M.CEMETERY, 0.2, 0.5],
    [M.ALLOTMENT, 0.5, 0.8], [M.ORCHARD, 0.35, 0.5], [M.PITCH, 0, 0], [M.MILITARY, 0.7, 0.1], [M.URBAN, 0.35, 0.4],
    [M.FARM, 0.55, 0.15],
  ];
  for (const [id, l, f] of len) { GLEN[id] = l; GFLOWER[id] = f; }
  for (const id of [M.ROAD, M.ROAD_MINOR, M.MOTORWAY, M.ROAD_BRICK, M.PARK_BAY, M.CYCLE, M.MARKING, M.BRIDGE]) ROADLIKE[id] = 1;
}

// A second, independent grain table
const GRAIN2 = new Float32Array(256 * 256);
for (let i = 0; i < GRAIN2.length; i++) GRAIN2[i] = hash2f(i & 255, i >> 8, 1301);

// Palette (docs/ART_STYLE.md section 4)
const FLOWERS = [[0xe8, 0xd8, 0x4a], [0xe0, 0x6a, 0x5a], [0xf0, 0xec, 0xe0], [0x9a, 0x7a, 0xd0]];

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
  const nGrass = grid(18, 4, 3), nClump = grid(6, 3, 31), nPatch = grid(45, 8, 32), nFlower = grid(26, 8, 33);
  const nBig = grid(90, 16, 34), nGarden = grid(10, 4, 35), nFarm = grid(60, 8, 5);
  const nWear = grid(24, 4, 37), nCrack = grid(14, 3, 21), nWater = grid(30, 8, 38);
  const nForest = grid(7, 3, 39), nWet = grid(16, 4, 40);
  // Built surfaces lose colour and pick up dirt as the world decays
  const decay = Math.min(0.22, over * 0.15 + dmg * 0.08);
  const weedP = over * 0.35, weedT = 0.78 - over * 0.25;
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
    const rowG = (wy & 255) << 8, rowGu = ((wy - 1) & 255) << 8, rowGuu = ((wy - 2) & 255) << 8;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const id = ids[i];
      if (!IS_GROUND[id]) continue;
      const wx = unit ? wx0 + x : Math.floor(wx0 + x * tpp);
      const gx = wx & 255;
      const g = GR[rowG | gx], g2 = G2[rowG | gx];
      const e = E[i];
      const grp = GROUP[id];
      // weeds come up in clumps, not as an even sprinkle
      const weeds = g2 < weedP && grp >= G_ASPHALT && nPatch.at(x, y) > weedT;
      let cr = 0, cg = 0, cb = 0;
      let f = 1 + (g - 0.5) * 0.06;
      let built = false;
      let done = false;
      let mark = 255;

      // Where land meets water: quay walls along paved banks, mud and reeds along green ones
      if (e & (WATER_ADJ | WATER_NEAR) && grp !== G_WATER) {
        const ek = EDGE[id];
        if (ek === K_PAVE || grp === G_URBAN || id === M.RESIDENTIAL || id === M.COMMERCIAL || id === M.INDUSTRIAL) {
          if (e & WATER_ADJ) {
            // brick quay top, stretcher bond
            cr = 0x7a; cg = 0x4a; cb = 0x3a;
            f *= (((wx + (wy & 1)) & 1) ? 0.9 : 1.04) * (0.94 + g2 * 0.12);
          } else {
            // stone capping
            cr = 0xb0; cg = 0xab; cb = 0xa0;
            f *= ((wx + wy) % 5 === 0 ? 0.9 : 1) * (0.96 + g2 * 0.08);
          }
          built = true;
          done = true;
        } else if (ek === K_VEG) {
          if (e & WATER_ADJ) {
            if (g2 > 0.55) { cr = 0x4a; cg = 0x6a; cb = 0x34; f *= 0.85 + g * 0.3; } // reeds
            else { cr = 0x5e; cg = 0x54; cb = 0x3a; } // mud bank
            done = true;
          } else {
            f *= 0.9;
          }
        } else if (grp === G_SAND) {
          f *= e & WATER_ADJ ? 0.82 : 0.9;
        }
      }

      if (!done) switch (grp) {
        case G_GRASS: case G_URBAN: {
          // Urban fill: a mix of tiled yards and scruffy grass
          if (grp === G_URBAN && nPatch.at(x, y) + (g - 0.5) * 0.1 < 0.6) {
            // courtyards: grey pavers in stretcher bond
            const half = (wx + (wy & 1)) & 1;
            const bg = G2[((wy & 255) << 8) | (((wx + (wy & 1)) >> 1) & 255)];
            cr = 0x92; cg = 0x8e; cb = 0x86;
            if (!fine) f *= ((wy & 1) ? 0.96 : 1.02) * (0.93 + bg * 0.12);
            mark = 252;
            if (half && weeds) { cr = 0x5a; cg = 0x6e; cb = 0x34; }
            built = true;
            break;
          }
          // Gardens: patios and flower beds between the lawns
          if (id === M.RESIDENTIAL) {
            const gn = nGarden.at(x, y) + (g - 0.5) * 0.08;
            if (gn > 0.84) {
              cr = 0x5a; cg = 0x46; cb = 0x32;
              f *= 0.9 + g * 0.2;
              if (g2 > 0.82 - over * 0.2) {
                const fl = FLOWERS[(g2 * 977) & 3];
                if (g2 > 0.9) { cr = fl[0]; cg = fl[1]; cb = fl[2]; f = 1; } else { cr = 0x4f; cg = 0x74; cb = 0x30; }
              }
              break;
            }
          }
          if (id === M.CEMETERY) {
            const mx = wx % 6, my = wy % 9;
            if (mx < 2 && my === 3) { cr = 0x9c; cg = 0x98; cb = 0x8e; f *= 0.95 + g * 0.1; break; }
            if (mx < 2 && my === 4) { cr = 0x4a; cg = 0x5c; cb = 0x34; break; }
          }
          if (id === M.ALLOTMENT) {
            const ax = wx % 18, ay = wy % 12;
            if (ax !== 0 && ay !== 0) {
              const plot = G2[(((wy / 12) | 0) & 255) << 8 | (((wx / 18) | 0) & 255)];
              if (plot < 0.7 - over * 0.5) {
                const rowOn = (wy & 1) === 0;
                if (rowOn && plot > 0.25) { cr = 0x5c; cg = 0x82; cb = 0x36; f *= 0.88 + g * 0.24; }
                else { cr = 0x6b; cg = 0x51; cb = 0x36; f *= 0.92 + g * 0.16; }
                break;
              }
            }
          }
          const av = aux[i];
          let len = GLEN[id] + over * 0.55 + (nGrass.at(x, y) - 0.5) * 0.6 + (av ? ((av >> 2) & 7) / 7 - 0.5 : 0) * 0.5;
          if (len < 0) len = 0; else if (len > 1) len = 1;
          // mown: light and even; long: deeper green with more blades
          cr = 0x6f - len * 0x16; cg = 0x98 - len * 0x16; cb = 0x40 - len * 0x0b;
          f *= 0.93 + nClump.at(x, y) * 0.14;
          f *= 0.95 + nBig.at(x, y) * 0.1;
          // dry, trampled patches
          const dry = nPatch.at(x, y);
          if (dry > 0.7 && id !== M.PITCH) {
            const k = Math.min(0.4, (dry - 0.7) * 2.5);
            cr += (0xa8 - cr) * k; cg += (0x9b - cg) * k; cb += (0x5a - cb) * k;
          }
          if (id === M.PITCH) {
            f *= ((wx >> 3) & 1) ? 1.04 : 0.96;
            if (wx % 64 === 0 || wy % 96 === 0) { cr = cg = cb = 0xd6; cb = 0xc2; f = 0.95 + g * 0.08; break; }
          } else if (len < 0.3 && id !== M.LAND) {
            // mowing stripes
            f *= ((wx >> 2) & 1) ? 1.025 : 0.975;
          }
          if (id === M.ORCHARD && wx % 14 < 3) f *= 0.92;
          // grass next to paving is worn
          if (e & (PAVE_ADJ | OTHER_ADJ) && g < 0.45) { cr = (cr + 0xa8) / 2; cg = (cg + 0x9b) / 2; cb = (cb + 0x5a) / 2; }
          // tufts: a light tip with darker blades under it
          const thr = 0.975 - len * 0.07;
          if (fine) mark = 200 + Math.round(len * 40);
          else if (g > thr) {
            if (len > 0.6 && g2 > 0.8) { cr = 0xa8; cg = 0x9b; cb = 0x5a; } else { cr = 0x8c; cg = 0xb5; cb = 0x4c; }
            f = 0.96 + g2 * 0.08;
          } else if (GR[rowGu | gx] > thr || (len > 0.55 && GR[rowGuu | gx] > thr + 0.02)) {
            cr = 0x4f; cg = 0x74; cb = 0x30;
            f = 0.94 + g2 * 0.1;
          }
          // flowers in patches
          const fd = GFLOWER[id] * (nFlower.at(x, y) - 0.45);
          if (fd > 0 && g2 > 1 - fd * 0.09) {
            const fl = FLOWERS[(g * 977) & 3];
            cr = fl[0]; cg = fl[1]; cb = fl[2]; f = 0.95 + g * 0.08;
            mark = 254;
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
          f *= 0.92 + nFarm.at(x, y) * 0.16;
          if (type < 0.48) {
            // meadow (most Dutch farmland is pasture)
            cr = 0x68; cg = 0x8e; cb = 0x3c;
            f *= 0.92 + nClump.at(x, y) * 0.16;
            if (g > 0.9) { cr = 0x8c; cg = 0xb5; cb = 0x4c; f = 0.95 + g2 * 0.1; }
            else if (GR[rowGu | gx] > 0.9) { cr = 0x4f; cg = 0x74; cb = 0x30; }
            else if (g2 > 0.997) { const fl = FLOWERS[(g * 977) & 1]; cr = fl[0]; cg = fl[1]; cb = fl[2]; f = 1; }
          } else if (type < 0.66) {
            // green crop rows over soil, rows get ragged as weeds take over
            if (stripe && g > over * 0.3) { cr = 0x6e; cg = 0x56; cb = 0x3a; f *= 0.9 + g2 * 0.14; }
            else { cr = 0x6a; cg = 0x92; cb = 0x3a; f *= 0.88 + g * 0.24; }
          } else if (type < 0.82) {
            // ripe grain
            cr = 0xbc; cg = 0xa6; cb = 0x5e;
            f *= stripe ? 0.92 : 1.04;
            if (g > 0.93) { cr = 0xd2; cg = 0xbe; cb = 0x72; }
            else if (g2 < over * 0.1) { cr = 0x6a; cg = 0x80; cb = 0x3a; }
          } else {
            // ploughed earth
            cr = 0x6e; cg = 0x55; cb = 0x39;
            f *= stripe ? 0.86 : 1.06;
            if (g > 0.96) { cr = 0x8a; cg = 0x74; cb = 0x58; }
            else if (g2 < over * 0.18) { cr = 0x5c; cg = 0x82; cb = 0x36; }
          }
          break;
        }
        case G_FOREST: {
          // forest floor: dark earth, leaf litter, ferns
          const n = nForest.at(x, y);
          const fern = nClump.at(x, y);
          if (fern > 0.66 && g > 0.25) {
            cr = 0x3c; cg = 0x5a; cb = 0x2c;
            if (g > 0.8) { cr = 0x5a; cg = 0x7e; cb = 0x36; }
            f *= 0.9 + g2 * 0.2;
          } else if (g < 0.33) { cr = 0x4a; cg = 0x3c; cb = 0x28; }
          else if (g < 0.66) { cr = 0x5a; cg = 0x48; cb = 0x2e; }
          else if (g < 0.93) { cr = 0x3e; cg = 0x46; cb = 0x2a; }
          else { cr = 0x7a; cg = 0x5a; cb = 0x2e; }
          f *= 0.82 + n * 0.3;
          // a fallen branch here and there
          if (g2 > 0.996) { cr = 0x6b; cg = 0x4a; cb = 0x2f; }
          else if (G2[rowGu | gx] > 0.996 || G2[rowG | ((wx - 1) & 255)] > 0.996) { cr = 0x43; cg = 0x30; cb = 0x21; }
          break;
        }
        case G_SCRUB: {
          const n = nClump.at(x, y);
          if (n > 0.62) { cr = 0x46; cg = 0x62; cb = 0x30; f *= 0.85 + g * 0.3; }
          else { cr = 0x7a; cg = 0x84; cb = 0x48; f *= 0.9 + g * 0.2; }
          if (g > 0.9) { cr = 0x9a; cg = 0x92; cb = 0x58; }
          else if (GR[rowGu | gx] > 0.9) { cr = 0x4a; cg = 0x5a; cb = 0x2e; }
          break;
        }
        case G_WETLAND: {
          if (nWet.at(x, y) > 0.66) {
            cr = 0x48; cg = 0x66; cb = 0x62;
            if (g > 0.95) { cr = 0x7e; cg = 0xa6; cb = 0xa6; }
            break;
          }
          cr = 0x6a; cg = 0x7c; cb = 0x4a;
          f *= 0.9 + nClump.at(x, y) * 0.2;
          if (g > 0.93) { cr = 0x8e; cg = 0x96; cb = 0x56; }
          else if (GR[rowGu | gx] > 0.93 || GR[rowGuu | gx] > 0.95) { cr = 0x4e; cg = 0x62; cb = 0x38; }
          break;
        }
        case G_SAND: {
          if (id === M.CONSTRUCTION) {
            cr = 0x96; cg = 0x80; cb = 0x5a;
            const n = nWet.at(x, y);
            if (n > 0.72) { cr = 0x6e; cg = 0x5e; cb = 0x48; }
            f *= 0.9 + g * 0.2;
            if (((wx + (wy >> 2)) % 9) === 0) f *= 0.88; // tyre tracks
            built = true;
            break;
          }
          if (id === M.BEACH) { cr = 0xdc; cg = 0xcb; cb = 0x98; } else { cr = 0xc8; cg = 0xb2; cb = 0x7e; }
          // wind ripples
          f *= ((wy + ((wx + (nClump.at(x, y) * 12 | 0)) >> 3)) % 5 === 0) ? 0.94 : 1;
          f *= 0.96 + nBig.at(x, y) * 0.08;
          if (g > 0.994) { cr = 0xf0; cg = 0xec; cb = 0xe0; } // shells, pebbles
          else if (g < 0.02) f *= 0.85;
          // marram grass on the dunes
          if (id === M.SAND && nPatch.at(x, y) > 0.6) {
            if (g2 > 0.82) { cr = 0x8a; cg = 0x9a; cb = 0x50; }
            else if (G2[rowGu | gx] > 0.82) { cr = 0x6a; cg = 0x76; cb = 0x3c; }
          }
          break;
        }
        case G_WATER: {
          if (id === M.FLOOD) {
            cr = 0x4f; cg = 0x62; cb = 0x50;
            f *= 0.92 + nWater.at(x, y) * 0.16;
            if (g > 0.93) { cr = 0x6c; cg = 0x8a; cb = 0x44; } // grass poking through
            else if (g2 > 0.97) { cr = 0x7e; cg = 0x98; cb = 0x90; }
            break;
          }
          if (id === M.SEA) { cr = 0x2c; cg = 0x52; cb = 0x5e; } else { cr = 0x3f; cg = 0x6a; cb = 0x72; }
          f *= 0.92 + nWater.at(x, y) * 0.16;
          // ripples: short light dashes with a darker trough under them
          const ru = wx + wy * 3;
          const rip = G2[rowG | ((ru >> 2) & 255)];
          const rthr = id === M.SEA ? 0.955 : 0.94;
          if (fine) { /* ripples are drawn at 2x */ }
          else if (rip > rthr && (ru & 3) !== 3) {
            cr = (cr + 0x7e) / 2; cg = (cg + 0xa6) / 2; cb = (cb + 0xa6) / 2;
          } else {
            const ru2 = wx + (wy - 1) * 3;
            if (G2[rowGu | ((ru2 >> 2) & 255)] > 0.94 && (ru2 & 3) !== 3) f *= 0.93;
          }
          // surf on the beach, a darker rim along every other bank
          if (id === M.SEA && e & OTHER_ADJ) { cr = 0xe4; cg = 0xe8; cb = 0xe0; f = 0.95 + g * 0.06; }
          else if (id === M.SEA && e & OTHER_NEAR && g > 0.3) { cr = 0x9e; cg = 0xbe; cb = 0xbc; }
          else if (e & (ROOF_ADJ | VEG_ADJ | PAVE_ADJ | OTHER_ADJ)) { cr = 0x2c; cg = 0x4f; cb = 0x58; f *= 0.82; }
          else if (e & (ROOF_NEAR | VEG_NEAR | PAVE_NEAR)) { cr = (cr + 0x2c) / 2; cg = (cg + 0x4f) / 2; cb = (cb + 0x58) / 2; }
          break;
        }
        case G_ASPHALT: {
          cr = 0x4a; cg = 0x4a; cb = 0x4e;
          if (id === M.MOTORWAY) f *= 0.94;
          else if (id === M.BRIDGE) { cr = 0x5c; cg = 0x58; cb = 0x54; }
          const wear = nWear.at(x, y);
          if (wear > 0.55) { const k = Math.min(1, (wear - 0.55) * 2.5); cr += (0x5c - cr) * k; cg += (0x5b - cg) * k; cb += (0x5c - cb) * k; }
          if (g > 0.96) f *= 1.16; else if (g < 0.04) f *= 0.84;
          // patched rectangles of newer asphalt
          const pc = G2[(((wy >> 4) + 41) & 255) << 8 | (((wx >> 4) + 17) & 255)];
          if (pc > 0.9) { const px = wx & 15, py = wy & 15; if (px > 2 && px < 13 && py > 4 && py < 11) { cr = 0x40; cg = 0x40; cb = 0x44; } }
          // oil stains
          const oc = G2[(((wy >> 3) + 101) & 255) << 8 | (((wx >> 3) + 7) & 255)];
          if (oc > 0.92) {
            const dx = (wx & 7) - 3.5, dy = (wy & 7) - 3.5;
            if (dx * dx * 1.6 + dy * dy < 3 + (oc - 0.92) * 140) f *= 0.8;
          }
          // cracks, which weeds take over
          const crack = Math.abs(nCrack.at(x, y) - 0.5);
          if (crack < 0.02 * (0.35 + dmg + over * 0.5)) {
            if (g2 < over * 0.8) { cr = 0x5c; cg = 0x7a; cb = 0x36; } else f *= 0.62;
          }
          built = true;
          break;
        }
        case G_BRICK: {
          // klinkers in herringbone: 2x1 bricks alternating horizontal and vertical
          const d = (wx - wy) & 3;
          const bx = d === 1 ? wx - 1 : wx, by = d === 2 ? wy - 1 : wy;
          const bg = G2[((by & 255) << 8) | ((bx * 3 + d) & 255)];
          // lying bricks catch the light, standing ones read a shade darker: a clean zigzag
          cr = 0x9a; cg = 0x5a; cb = 0x44;
          if (fine) { if (weeds && g < 0.5) { cr = 0x5a; cg = 0x6e; cb = 0x34; } built = true; break; }
          if (bg < 0.025) { cr = 0x80; cg = 0x76; cb = 0x6c; }
          f *= 0.97 + bg * 0.05;
          if (d >= 2) f *= 0.88;
          // the far end of each brick sits against a joint
          if (d === 1 || d === 2) {
            f *= 0.95;
            if (weeds && g < 0.5) { cr = 0x5a; cg = 0x6e; cb = 0x34; }
          }
          built = true;
          break;
        }
        case G_BAY: {
          // parking bays: a browner brick in stretcher bond
          const half = (wx + (wy & 1)) & 1;
          const bg = G2[((wy & 255) << 8) | (((wx + (wy & 1)) >> 1) & 255)];
          cr = 0x8c; cg = 0x5c; cb = 0x4a;
          if (!fine) f *= ((wy & 1) ? 0.95 : 1.02) * (0.92 + bg * 0.14);
          if (half && weeds) { cr = 0x5a; cg = 0x6e; cb = 0x34; }
          // oil drips where cars stood
          const oc = G2[(((wy >> 3) + 61) & 255) << 8 | (((wx >> 3) + 3) & 255)];
          if (oc > 0.85 && g > 0.5) f *= 0.86;
          built = true;
          break;
        }
        case G_SIDEWALK: {
          // stoeptegels: one tile per texel, a curb along the road
          const curb = (x > 0 && ROADLIKE[ids[i - 1]]) || (x + 1 < w && ROADLIKE[ids[i + 1]]) ||
            (y > 0 && ROADLIKE[ids[i - w]]) || (y + 1 < h && ROADLIKE[ids[i + w]]);
          if (curb) {
            cr = 0xbd; cg = 0xb8; cb = 0xae;
            f *= 0.97 + g * 0.06;
            mark = 253;
            if (g2 < dmg * 0.06) f *= 0.8;
          } else {
            cr = 0xa8; cg = 0xa3; cb = 0x9a;
            if (!fine) f *= ((wx + wy) & 1 ? 0.965 : 1.02) * (0.95 + g2 * 0.1);
            if (g2 < 0.003 + dmg * 0.012) { cr = 0x6e; cg = 0x5c; cb = 0x46; if (g < over) { cr = 0x5c; cg = 0x82; cb = 0x36; } }
            else if (g2 < 0.02 + dmg * 0.03) { cr = 0x86; cg = 0x82; cb = 0x7b; }
            else if (weeds) { cr = 0x5a; cg = 0x72; cb = 0x36; }
          }
          built = true;
          break;
        }
        case G_PATH: {
          // footpaths: larger grey slabs
          const sg = G2[(((wy >> 1) + 7) & 255) << 8 | (((wx >> 1) + 5) & 255)];
          cr = 0x9e; cg = 0x98; cb = 0x8c;
          if (!fine) f *= (0.93 + sg * 0.12) * ((wx & 1) && (wy & 1) ? 0.95 : 1);
          if (weeds) { cr = 0x5a; cg = 0x72; cb = 0x36; }
          built = true;
          break;
        }
        case G_CYCLE: {
          cr = 0x9c; cg = 0x4b; cb = 0x40;
          f *= 0.94 + nWear.at(x, y) * 0.12;
          if (g > 0.96) f *= 1.1; else if (g < 0.03) f *= 0.85;
          const road = (x > 0 && GROUP[ids[i - 1]] === G_ASPHALT) || (x + 1 < w && GROUP[ids[i + 1]] === G_ASPHALT) ||
            (y > 0 && GROUP[ids[i - w]] === G_ASPHALT) || (y + 1 < h && GROUP[ids[i + w]] === G_ASPHALT);
          if (road && ((wx + wy) % 6) < 4 && g > dmg * 0.4) { cr = 0xd6; cg = 0xd2; cb = 0xc2; }
          built = true;
          break;
        }
        case G_TRACK: {
          cr = 0x8a; cg = 0x75; cb = 0x56;
          const tn = nClump.at(x, y);
          f *= 0.94 + tn * 0.12;
          if (g > 0.98) { cr = 0xa0; cg = 0x94; cb = 0x7e; }
          else if (tn + (g2 - 0.5) * 0.2 > 0.7 - over * 0.2) { cr = 0x6c; cg = 0x8e; cb = 0x3c; if (g > 0.75) { cr = 0x8c; cg = 0xb5; cb = 0x4c; } }
          break;
        }
        case G_BALLAST: {
          if (g < 0.33) { cr = 0x6a; cg = 0x64; cb = 0x5c; }
          else if (g < 0.66) { cr = 0x7e; cg = 0x76; cb = 0x6a; }
          else { cr = 0x58; cg = 0x50; cb = 0x4a; }
          if (g2 < over * 0.18) { cr = 0x5c; cg = 0x7a; cb = 0x36; }
          break;
        }
        case G_RAIL: {
          if ((wx + wy) % 3 === 0) { cr = 0x52; cg = 0x42; cb = 0x34; f *= 0.9 + g2 * 0.2; }
          else { cr = 0x60; cg = 0x5a; cb = 0x52; f *= 0.85 + g * 0.3; }
          if (g2 < over * 0.1) { cr = 0x5c; cg = 0x7a; cb = 0x36; }
          break;
        }
        case G_STEEL: {
          cr = 0x62; cg = 0x5e; cb = 0x5a;
          const rust = Math.min(1, over * 1.5) * g2;
          cr += (0x7a - cr) * rust; cg += (0x52 - cg) * rust; cb += (0x3a - cb) * rust;
          break;
        }
        case G_MARKING: {
          cr = 0xd6; cg = 0xd2; cb = 0xc2;
          if (g < 0.15 + dmg * 0.3) { cr = 0x8e; cg = 0x8c; cb = 0x88; }
          built = true;
          break;
        }
        case G_PAVERS: {
          // parking lots and shopping squares: grey/beige pavers in stretcher bond
          const half = (wx + (wy & 1)) & 1;
          const bg = G2[((wy & 255) << 8) | (((wx + (wy & 1)) >> 1) & 255)];
          if (id === M.PARKING) { cr = 0x7c; cg = 0x7a; cb = 0x76; } else { cr = 0x9e; cg = 0x94; cb = 0x86; }
          if (!fine) f *= ((wy & 1) ? 0.96 : 1.02) * (0.93 + bg * 0.12);
          if (id === M.PARKING) {
            const oc = G2[(((wy >> 3) + 61) & 255) << 8 | (((wx >> 3) + 3) & 255)];
            if (oc > 0.85 && g > 0.5) f *= 0.84;
          }
          if (half && weeds) { cr = 0x5a; cg = 0x6e; cb = 0x34; }
          built = true;
          break;
        }
        case G_SLABS: {
          // industrial yards: big concrete slabs, weeds in the joints, stains
          cr = 0x88; cg = 0x85; cb = 0x7e;
          const sg = G2[(((wy >> 3) + 9) & 255) << 8 | (((wx >> 3) + 13) & 255)];
          f *= 0.94 + sg * 0.1;
          if ((wx & 7) === 0 || (wy & 7) === 0) {
            f *= 0.88;
            if (g < 0.1 + over * 0.5) { cr = 0x5c; cg = 0x7a; cb = 0x36; f = 0.9 + g2 * 0.2; }
          }
          if (nWear.at(x, y) > 0.7) f *= 0.88;
          if (g > 0.97) f *= 0.8;
          built = true;
          break;
        }
        case G_YARD: {
          cr = 0x84; cg = 0x78; cb = 0x60;
          const mud = nWet.at(x, y) + (g - 0.5) * 0.08;
          if (mud > 0.72) { cr = 0x74; cg = 0x66; cb = 0x4e; }
          f *= 0.95 + g * 0.1;
          if (g2 > 0.985) { cr = 0xa0; cg = 0x94; cb = 0x7e; }
          // weeds in clumps along the edges of the yard
          else if (nClump.at(x, y) + (g - 0.5) * 0.15 > 0.74 - over * 0.2) { cr = 0x6c; cg = 0x8a; cb = 0x3c; f = 0.9 + g2 * 0.2; }
          break;
        }
        case G_RUBBLE: {
          if (g < 0.25) { cr = 0x8e; cg = 0x52; cb = 0x40; }
          else if (g < 0.5) { cr = 0x8a; cg = 0x84; cb = 0x78; }
          else if (g < 0.75) { cr = 0x5a; cg = 0x52; cb = 0x4a; }
          else { cr = 0x3a; cg = 0x34; cb = 0x30; }
          f *= 0.9 + g2 * 0.2;
          break;
        }
        case G_SANDBAG: {
          cr = 0x8a; cg = 0x7b; cb = 0x58;
          if (((wx + (wy & 1)) & 1) === 0 && (wy & 1)) f *= 0.8;
          f *= 0.92 + g * 0.16;
          break;
        }
      }

      // paving gets a fringe of grass along green edges, more as nature returns
      if (built && e & (VEG_ADJ | VEG_NEAR)) {
        const p = e & VEG_ADJ ? 0.12 + over * 0.5 : over * 0.18;
        if (g2 < p) {
          if (g > 0.6) { cr = 0x8c; cg = 0xb5; cb = 0x4c; } else { cr = 0x5c; cg = 0x82; cb = 0x36; }
          f = 0.94 + g * 0.1;
          built = false;
        }
      }
      if (built && decay > 0) {
        const l = (cr * 0.3 + cg * 0.55 + cb * 0.15);
        cr += (l + 6 - cr) * decay; cg += (l + 2 - cg) * decay; cb += (l - 6 - cb) * decay;
      }
      // things sit in the world: soft darkening by walls, softened drop shadows
      if (e & ROOF_ADJ) f *= 0.8;
      else if (e & ROOF_NEAR) f *= 0.9;
      if (shadow && shadow[i]) {
        const inner = x > 0 && y > 0 && x + 1 < w && y + 1 < h && shadow[i + 1] && shadow[i + w] && shadow[i - 1] && shadow[i - w];
        f *= inner ? 0.66 : 0.8;
        // cool the shade a little, as overcast skylight does
        cb += 6;
      }
      out32[i] = pack(cr * f, cg * f, cb * f, fine ? mark : 255);
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

/**
 * Pass 2 of a 2x render: every texel becomes 2x2 art pixels. Material edges are
 * smoothed (EPX on the id raster, so diagonal kerbs and banks lose their
 * staircase), grass blades lean over paving, and the fine patterns that do not
 * fit in a 0.37 m texel are drawn here: klinker herringbone, tile joints, grass
 * blades, water ripples. Roofs and other non-ground texels are just doubled.
 * base is the pass-1 output (with decals); out is (2w x 2h) RGBA.
 */
export function refineGround(r: IdRaster, base: Uint8ClampedArray, out: Uint8ClampedArray, ctx: ShadeContext): void {
  if (!ready) init();
  const { w, h, ids } = r;
  const W = w * 2;
  const GR = GRAIN, G2 = GRAIN2;
  const ax0 = Math.floor(ctx.wx0) * 2, ay0 = Math.floor(ctx.wy0) * 2;
  const over = ctx.overgrowth;
  const out32 = new Uint32Array(out.buffer, out.byteOffset, out.length >> 2);
  const base32 = new Uint32Array(base.buffer, base.byteOffset, base.length >> 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const P = ids[i];
      if (!IS_GROUND[P]) {
        // doubled as is
        const v = (base32[i] | 0xff000000) >>> 0;
        const o = y * 2 * W + x * 2;
        out32[o] = out32[o + 1] = out32[o + W] = out32[o + W + 1] = v;
        continue;
      }
      const A = y > 0 ? ids[i - w] : P, D = y + 1 < h ? ids[i + w] : P;
      const Cl = x > 0 ? ids[i - 1] : P, B = x + 1 < w ? ids[i + 1] : P;
      for (let sy = 0; sy < 2; sy++) {
        const ay = ay0 + y * 2 + sy;
        const rowA = (ay & 255) << 8, rowAu = ((ay - 1) & 255) << 8;
        for (let sx = 0; sx < 2; sx++) {
          const ax = ax0 + x * 2 + sx;
          const ga = GR[rowA | (ax & 255)], gb = G2[rowA | (ax & 255)];
          // EPX: a corner takes the neighbour's material where two neighbours agree on it
          let src = i;
          const v = sy === 0 ? A : D, hz = sx === 0 ? Cl : B, vo = sy === 0 ? D : A, ho = sx === 0 ? B : Cl;
          if (v === hz && v !== P && v !== vo && hz !== ho && IS_GROUND[v] && v !== M.MARKING && P !== M.MARKING) src = sy === 0 ? i - w : i + w;
          else if (EDGE[P] !== K_VEG && P !== M.MARKING) {
            // grass leans over the edge of paving and sand
            if (EDGE[hz] === K_VEG && ga > 0.55) src = sx === 0 ? i - 1 : i + 1;
            else if (EDGE[v] === K_VEG && gb > 0.6) src = sy === 0 ? i - w : i + w;
          }
          const so = src * 4;
          let cr = base[so], cg = base[so + 1], cb = base[so + 2];
          const sid = ids[src], mark = base[so + 3];
          let f = 1;
          switch (GROUP[sid]) {
            case G_GRASS: case G_URBAN: case G_SCRUB: case G_WETLAND: {
              if (mark === 252) {
                // courtyard pavers
                if (cg > cr) break;
                const bg = G2[((ay & 255) << 8) | (((ax + (ay & 1)) >> 1) & 255)];
                f = (0.92 + bg * 0.14) * ((ay & 1) ? 0.95 : 1.02) * (((ax + (ay & 1)) & 1) ? 0.95 : 1);
                break;
              }
              if (mark === 254) {
                // a flower clump: two blooms on a diagonal, leaves around them
                if (((sx ^ sy) & 1) !== ((ax >> 1) & 1)) { cr = 0x4f; cg = 0x74; cb = 0x30; }
                break;
              }
              if (mark < 200 || mark > 240) { f = 0.95 + ga * 0.1; break; }
              const len = (mark - 200) / 40;
              const thr = 0.93 - len * 0.1;
              if (ga > thr) {
                if (len > 0.6 && gb > 0.85) { cr = 0xa8; cg = 0x9b; cb = 0x5a; f = 0.96 + gb * 0.08; }
                else f = 1.16 + gb * 0.06;
              } else if (GR[rowAu | (ax & 255)] > thr) f = 0.84;
              else f = 0.96 + gb * 0.08;
              break;
            }
            case G_FARM: case G_FOREST: case G_YARD: case G_TRACK: case G_BALLAST: case G_RUBBLE:
              f = 0.9 + ga * 0.2;
              break;
            case G_SAND:
              f = 0.96 + ga * 0.08;
              if (gb > 0.997) { cr = 0xf0; cg = 0xec; cb = 0xe0; }
              break;
            case G_ASPHALT: case G_CYCLE: case G_SLABS:
              f = gb > 0.94 ? 1.1 : gb < 0.06 ? 0.9 : 0.97 + ga * 0.06;
              break;
            case G_BRICK: {
              if (cg > cr) break; // weeds
              // klinkers in herringbone, one 2x1 brick per two art pixels
              const d = (ax - ay) & 3;
              const bx = d === 1 ? ax - 1 : ax, by = d === 2 ? ay - 1 : ay;
              const bg = G2[((by & 255) << 8) | ((bx * 3 + d) & 255)];
              if (bg < 0.03) { cr = 0x84; cg = 0x7a; cb = 0x70; }
              else if (bg > 0.9) f = 1.08;
              f *= (0.95 + bg * 0.08) * (d >= 2 ? 0.86 : 1) * (d === 1 || d === 2 ? 0.94 : 1);
              if ((d === 1 || d === 2) && ga < over * 0.25) { cr = 0x5a; cg = 0x6e; cb = 0x34; f = 1; }
              break;
            }
            case G_BAY: case G_PAVERS: {
              if (cg > cr) break;
              // stretcher bond: courses of 2x1 bricks, half a brick offset
              const half = (ax + (ay & 1)) & 1;
              const bg = G2[((ay & 255) << 8) | (((ax + (ay & 1)) >> 1) & 255)];
              f = (0.92 + bg * 0.14) * ((ay & 1) ? 0.95 : 1.02) * (half ? 0.95 : 1);
              break;
            }
            case G_SIDEWALK: {
              if (mark === 253) { f = sy === 0 ? 1.04 : 0.96; break; } // curb: lit top, shaded face
              if (cg > cr) break;
              // stoeptegels: tiles of 3x3 art pixels with a joint
              const tx = (ax / 3) | 0, ty = (ay / 3) | 0;
              const jx = ax - tx * 3 === 2, jy = ay - ty * 3 === 2;
              f = (jx || jy) ? 0.86 : 0.95 + G2[((ty & 255) << 8) | (tx & 255)] * 0.1;
              break;
            }
            case G_PATH: {
              if (cg > cr) break;
              const tx = ax >> 2, ty = ay >> 2;
              f = ((ax & 3) === 3 || (ay & 3) === 3) ? 0.88 : 0.94 + G2[(((ty + 7) & 255) << 8) | ((tx + 5) & 255)] * 0.1;
              break;
            }
            case G_WATER: {
              if (sid === M.FLOOD) { f = 0.97 + ga * 0.06; break; }
              const ru = ax + ay * 3;
              const rip = G2[rowA | ((ru >> 2) & 255)];
              if (rip > (sid === M.SEA ? 0.95 : 0.935) && (ru & 3) !== 3) {
                cr = (cr + 0x7e) / 2; cg = (cg + 0xa6) / 2; cb = (cb + 0xa6) / 2;
              } else {
                const ru2 = ax + (ay - 1) * 3;
                if (G2[rowAu | ((ru2 >> 2) & 255)] > 0.94 && (ru2 & 3) !== 3) f = 0.93;
              }
              break;
            }
            default:
              f = 0.97 + ga * 0.06;
          }
          out32[(y * 2 + sy) * W + x * 2 + sx] = pack(cr * f, cg * f, cb * f, 255);
        }
      }
    }
  }
}
