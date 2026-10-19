// Building interiors. Every building big enough to stand in gets a floor,
// walls, rooms with doorways between them, a front door facing the street and
// a little furniture, all derived from the real footprint. The result is a
// small material raster aligned to the world texel grid, so it feeds both the
// collision grid (in the worker) and the inside view (drawn on the main thread).

import { ringArea } from '../core/geo';
import { Rng } from '../core/rng';
import { M } from '../render/materials';
import { IdRaster, type Transform } from '../render/raster';

export interface Interior {
  /** raster origin in the same coordinates as the footprint (whole texels) */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** material per texel, 0 outside the footprint */
  ids: Uint8Array;
  /** a spot just inside the front door */
  inside: { x: number; y: number };
}

export interface Door {
  /** point on the wall facing the street */
  x: number;
  y: number;
  /** outward normal of that wall */
  nx: number;
  ny: number;
}

const FLOORS: Record<string, number> = {
  house: M.FLOOR_WOOD, residential: M.FLOOR_WOOD, apartments: M.FLOOR_WOOD, other: M.FLOOR_WOOD,
  shop: M.FLOOR_TILE, retail: M.FLOOR_TILE, supermarket: M.FLOOR_TILE, commercial: M.FLOOR_TILE, food_service: M.FLOOR_TILE,
  pharmacy: M.FLOOR_TILE, hospital: M.FLOOR_TILE, fuel: M.FLOOR_TILE,
  office: M.FLOOR_CARPET, civic: M.FLOOR_CARPET, school: M.FLOOR_CARPET, police: M.FLOOR_CARPET,
  industrial: M.FLOOR_CONCRETE, warehouse: M.FLOOR_CONCRETE, farm: M.FLOOR_CONCRETE, garage: M.FLOOR_CONCRETE,
  military: M.FLOOR_CONCRETE, fire_station: M.FLOOR_CONCRETE,
  church: M.FLOOR_STONE,
};
const HALLS = new Set<number>([M.FLOOR_CONCRETE, M.FLOOR_STONE]);

/** Smallest footprint that gets an inside; sheds and kiosks stay solid. */
export const MIN_INTERIOR_M2 = 9;

export function buildInterior(rings: number[][], cls: string, door: Door, seed: number, tpm: number): Interior | null {
  const outer = rings[0];
  const areaM2 = Math.abs(ringArea(outer)) / (tpm * tpm);
  if (areaM2 < MIN_INTERIOR_M2) return null;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    bx0 = Math.min(bx0, outer[i]); bx1 = Math.max(bx1, outer[i]);
    by0 = Math.min(by0, outer[i + 1]); by1 = Math.max(by1, outer[i + 1]);
  }
  const x0 = Math.floor(bx0) - 1, y0 = Math.floor(by0) - 1;
  const w = Math.ceil(bx1) + 2 - x0, h = Math.ceil(by1) + 2 - y0;
  if (w * h > 1500 * 1500) return null;
  const R = new IdRaster(w, h, 0);
  const t: Transform = { ox: x0, oy: y0, scale: 1 };
  const floor = FLOORS[cls] ?? M.FLOOR_WOOD;
  R.fillPolygon(rings, floor, t);
  const rng = new Rng(seed);
  const isFloor = (c: number) => c === floor;

  // Rooms: a grid aligned with the building's longest wall
  let best = 0, ang = 0;
  for (let i = 0; i + 3 < outer.length; i += 2) {
    const dx = outer[i + 2] - outer[i], dy = outer[i + 3] - outer[i + 1];
    const l = Math.hypot(dx, dy);
    if (l > best) { best = l; ang = Math.atan2(dy, dx); }
  }
  const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    const u = outer[i] * ux + outer[i + 1] * uy, v = outer[i] * vx + outer[i + 1] * vy;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const room = (HALLS.has(floor) ? 14 : areaM2 > 400 ? 7 : 4.4) * tpm;
  const nu = Math.max(1, Math.min(8, Math.round((u1 - u0) / room)));
  const nv = Math.max(1, Math.min(8, Math.round((v1 - v0) / room)));
  const du = (u1 - u0) / nu, dv = (v1 - v0) / nv;
  const at = (u: number, v: number) => ({ x: u * ux + v * vx - x0, y: u * uy + v * vy - y0 });
  const wall = (a: { x: number; y: number }, b: { x: number; y: number }) => R.line(a.x, a.y, b.x, b.y, M.INNER_WALL, isFloor);
  for (let k = 1; k < nu; k++) wall(at(u0 + k * du, v0), at(u0 + k * du, v1));
  for (let k = 1; k < nv; k++) wall(at(u0, v0 + k * dv), at(u1, v0 + k * dv));
  // a doorway in every stretch of wall between two rooms, so all rooms connect
  const gap = 0.55 * tpm;
  const carve = (p: { x: number; y: number }) => R.fillDisk(p.x, p.y, gap, floor, (c) => c === M.INNER_WALL);
  for (let k = 1; k < nu; k++) for (let j = 0; j < nv; j++) carve(at(u0 + k * du, v0 + (j + 0.3 + rng.next() * 0.4) * dv));
  for (let k = 1; k < nv; k++) for (let j = 0; j < nu; j++) carve(at(u0 + (j + 0.3 + rng.next() * 0.4) * du, v0 + k * dv));
  // furniture in the middle of roomy rooms, clear of the doorways along the walls
  if (!HALLS.has(floor) && du > 3.4 * tpm && dv > 3.4 * tpm) {
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        if (rng.next() < 0.35) continue;
        const cu = u0 + (i + 0.5) * du + rng.range(-0.15, 0.15) * du, cv = v0 + (j + 0.5) * dv + rng.range(-0.15, 0.15) * dv;
        const hu = rng.range(0.4, 0.9) * tpm, hv = rng.range(0.3, 0.6) * tpm;
        const c = [at(cu - hu, cv - hv), at(cu + hu, cv - hv), at(cu + hu, cv + hv), at(cu - hu, cv + hv)];
        R.fillPolygon([c.flatMap((p) => [p.x, p.y])], M.FURNITURE, { ox: 0, oy: 0, scale: 1 }, -1, isFloor);
      }
    }
  }
  // outer walls: the outline plus a second texel inwards so nothing slips through diagonals
  R.fillPolyline(outer, 2, M.INNER_WALL, t, (c) => c !== 0);
  R.strokeRings(rings, M.INNER_WALL, t, (c) => c !== 0);
  // the front door, through the wall that faces the street
  const dx = door.x - door.nx * 0.6 - x0, dy = door.y - door.ny * 0.6 - y0;
  R.fillDisk(dx, dy, 0.6 * tpm, floor, (c) => c !== 0);
  R.fillDisk(dx - door.nx * 0.8 * tpm, dy - door.ny * 0.8 * tpm, 0.5 * tpm, floor, (c) => c === M.FURNITURE || c === M.INNER_WALL);
  let inside = { x: door.x - door.nx * 1.4 * tpm, y: door.y - door.ny * 1.4 * tpm };
  if (R.get(Math.floor(inside.x - x0), Math.floor(inside.y - y0)) === 0) inside = { x: door.x - door.nx * 0.7 * tpm, y: door.y - door.ny * 0.7 * tpm };
  return { x0, y0, w, h, ids: R.ids, inside };
}
