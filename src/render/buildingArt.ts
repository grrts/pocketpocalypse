// Helpers left from when building exteriors were painted into the chunk
// texture. Buildings are now drawn as geometry from their BuildingModel
// (render/buildingDraw.ts); the inside view (interiorArt.ts) still uses these.

import { PALETTE, rgbOf } from './palette';

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const hexes = (a: string[]) => a.map(hex);

const HALL = [rgbOf(PALETTE.roofTeal), hex('#4f78ac'), rgbOf(PALETTE.roofMetal), hex('#cbb685'), hex('#b0503a'), hex('#6f925a')];
const BRICK = hexes(['#c8603f', '#b9553a', '#d0704a', '#ad4c38']);
const RENDER = hexes(['#f0e6cc', '#e8d8b0', '#f2f0ea', '#d8e6e0', '#f0d8c8']);
const CONCRETE = hexes(['#c8c8c0', '#bcc0c4']);
const TIMBER = hexes(['#8a4e2e', '#a83a2a', '#6f5a3a']);
const STONE = hex('#c4b89c');

const HALLS = new Set(['industrial', 'warehouse', 'garage', 'mechanic', 'farm', 'shed', 'fire_station', 'military']);
const HOMES = new Set(['house', 'residential', 'other']);

type WallKind = 'brick' | 'render' | 'metal' | 'timber' | 'stone';

function wallColor(cls: string, seed: number, hall: RGB): { c: RGB; kind: WallKind } {
  const k = (seed >>> 5) % 97;
  if (cls === 'church') return { c: STONE, kind: 'stone' };
  if (cls === 'farm') return k % 3 ? { c: TIMBER[k % TIMBER.length], kind: 'timber' } : { c: hall, kind: 'metal' };
  if (HALLS.has(cls)) return k % 4 ? { c: hall, kind: 'metal' } : { c: BRICK[k % BRICK.length], kind: 'brick' };
  if (HOMES.has(cls)) return k % 6 ? { c: BRICK[k % BRICK.length], kind: 'brick' } : { c: RENDER[k % RENDER.length], kind: 'render' };
  if (cls === 'apartments') return k % 3 === 0 ? { c: RENDER[k % RENDER.length], kind: 'render' } : k % 3 === 1 ? { c: CONCRETE[k % CONCRETE.length], kind: 'render' } : { c: BRICK[k % BRICK.length], kind: 'brick' };
  return k % 2 ? { c: RENDER[k % RENDER.length], kind: 'render' } : k % 4 === 0 ? { c: BRICK[k % BRICK.length], kind: 'brick' } : { c: CONCRETE[k % CONCRETE.length], kind: 'render' };
}

/** The colour a building's outer walls are built in (the inside view draws the wall tops in it). */
export function facadeColor(cls: string, seed: number): [number, number, number] {
  return wallColor(cls, seed, HALL[(seed >>> 6) % HALL.length]).c;
}

const XS: number[] = [];

/** Even-odd fill of rings (offset by ox, oy) into a w x h byte mask, pixel centres inside. */
export function fillRings(m: Uint8Array, w: number, h: number, rings: ArrayLike<number>[], ox: number, oy: number, scale = 1) {
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / scale + oy;
    XS.length = 0;
    for (const r of rings) {
      const n = r.length;
      for (let i = 0; i < n; i += 2) {
        const j = i + 2 < n ? i + 2 : 0;
        const ay = r[i + 1], by = r[j + 1];
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) XS.push(r[i] + ((sy - ay) / (by - ay)) * (r[j] - r[i]));
      }
    }
    if (XS.length < 2) continue;
    XS.sort((a, b) => a - b);
    const row = y * w;
    for (let k = 0; k + 1 < XS.length; k += 2) {
      const xa = Math.max(0, Math.ceil((XS[k] - ox) * scale - 0.5)), xb = Math.min(w - 1, Math.floor((XS[k + 1] - ox) * scale - 0.5));
      for (let x = xa; x <= xb; x++) m[row + x] = 1;
    }
  }
}
