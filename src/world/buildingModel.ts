// A building as an architect would draw it, built on a real footprint.
//
// The map only gives us the blueprint: an outline, a class and sometimes a
// number of storeys. We do not paint over that outline. We read it as a plan,
// square it up into clean rectangular wings in the building's own axes, and put
// a proper building on top: straight walls, a roof with a straight ridge and
// eaves, a front door facing the street and windows on a regular rhythm.
// Renderers draw this model; nothing draws the raw outline.
//
// Coordinates: world texels, the same space as BuildingInfo.rings. Lengths in
// the model's own frame are metres (multiply by tpm for texels).

import { decompose, dominantAxis, mainPart, type Box } from './floorplan';

export type RoofKind = 'gable' | 'hip' | 'flat' | 'mansard' | 'shed';

export interface Wing {
  /** rectangle in the building frame, metres from the frame origin (s along ux, d along uy) */
  box: Box;
  roof: RoofKind;
  /** ridge runs along s (true) or along d (false); ignored for flat roofs */
  ridgeAlongS: boolean;
  /** eaves height above the ground, metres */
  wallH: number;
  /** ridge height above the eaves, metres (0 for flat) */
  roofH: number;
}

export interface Opening {
  /** which wing and which side of it: 0 = d0 edge (-uy), 1 = s1 edge (+ux), 2 = d1 edge (+uy), 3 = s0 edge (-ux) */
  wing: number;
  side: 0 | 1 | 2 | 3;
  /** centre along that side, metres from the side's start (s0 or d0) */
  at: number;
  /** width in metres */
  w: number;
  kind: 'door' | 'window' | 'shopfront' | 'garage';
  /** for windows: which storey (0 = ground floor) */
  storey?: number;
}

export interface BuildingModel {
  id: string;
  cls: string;
  seed: number;
  burnt: boolean;
  /** frame origin (world texels) and unit axes; the frame is the building's dominant wall direction */
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  /** texels per metre */
  tpm: number;
  /** clean wings; together they are the building's squared-up footprint */
  wings: Wing[];
  openings: Opening[];
  storeys: number;
  /** id of the terrace row this house belongs to (houses sharing party walls), or '' */
  row: string;
}

export interface ModelInput {
  id: string;
  /** footprint rings in world texels (outer first) */
  rings: number[][];
  cls: string;
  levels?: number;
  seed: number;
  burnt: boolean;
  tpm: number;
  /** front door on the outline (world texels) and its outward normal */
  door: { x: number; y: number; nx: number; ny: number };
}

/** World texel position of a point given in the model frame (metres). */
export function toWorld(m: BuildingModel, s: number, d: number): [number, number] {
  const k = m.tpm;
  return [m.ox + (m.ux * s - m.uy * d) * k, m.oy + (m.uy * s + m.ux * d) * k];
}

/**
 * Square up a footprint into a building. Placeholder implementation: one wing
 * per decomposed rectangle, gabled along its long side.
 */
export function buildModel(inp: ModelInput): BuildingModel | null {
  const outer = inp.rings[0];
  if (!outer || outer.length < 6) return null;
  const [ux, uy] = dominantAxis(outer);
  const k = inp.tpm;
  // footprint in the building frame, metres, with the frame's origin at the min corner
  let s0 = Infinity, d0 = Infinity, s1 = -Infinity, d1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    const s = (outer[i] * ux + outer[i + 1] * uy) / k, d = (-outer[i] * uy + outer[i + 1] * ux) / k;
    s0 = Math.min(s0, s); s1 = Math.max(s1, s); d0 = Math.min(d0, d); d1 = Math.max(d1, d);
  }
  const rings = inp.rings.map((r) => {
    const o: number[] = [];
    for (let i = 0; i < r.length; i += 2) o.push((r[i] * ux + r[i + 1] * uy) / k - s0, (-r[i] * uy + r[i + 1] * ux) / k - d0);
    return o;
  });
  const W = s1 - s0, D = d1 - d0;
  if (W < 2 || D < 2) return null;
  let boxes = decompose(rings, W, D).filter((b) => b.s1 - b.s0 >= 2 && b.d1 - b.d0 >= 2);
  if (!boxes.length) boxes = [{ s0: 0, s1: W, d0: 0, d1: D }];
  const main = mainPart(boxes);
  const storeys = Math.max(1, Math.round(inp.levels ?? (inp.cls === 'apartments' ? 4 : 2)));
  const wallH = storeys * 3;
  const wings: Wing[] = boxes.map((b) => {
    const along = b.s1 - b.s0 >= b.d1 - b.d0;
    const span = along ? b.d1 - b.d0 : b.s1 - b.s0;
    return { box: b, roof: 'gable', ridgeAlongS: along, wallH, roofH: span * 0.45 };
  });
  return {
    id: inp.id, cls: inp.cls, seed: inp.seed, burnt: inp.burnt,
    ox: (s0 * ux - d0 * uy) * k, oy: (s0 * uy + d0 * ux) * k, ux, uy, tpm: k,
    wings: wings.sort((a, b) => (a.box === main ? -1 : b.box === main ? 1 : 0)),
    openings: [], storeys, row: '',
  };
}
