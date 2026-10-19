// Street-level chunk generation: real map data -> pixel-art texture, collision
// grid and the deterministic apocalypse layer (wrecks, corpses, loot, undead).
// Pure function of its inputs, so the same chunk always comes out the same.

import { CHUNK_TEXELS, closestOnSegment, metersPerTexel, pointInPolygon, ringArea, ringCentroid, tileTexels } from '../core/geo';
import { Rng, hash2, hashString, valueNoise } from '../core/rng';
import type { ElevationGrid } from '../data/elevation';
import { SURFACE_ORDER } from '../data/osm';
import type { GeoArea, GeoData, GeoLine, PackTile } from '../data/types';
import { buildingLootType } from '../game/items';
import { C, IS_ROOF, M, ROAD_MATERIAL, SURFACE_MATERIAL, collisionFrom, shadeRaster } from '../render/materials';
import { IdRaster, type Transform } from '../render/raster';
import type { RegionState } from '../sim/outbreak';
import { floodLevel } from './flood';
import type { ChunkSpawns, ChunkStats, CorpseKind, SpawnVehicle, VehicleModel, ZombieKind } from './spawnTypes';

export interface ChunkGenInput {
  cx: number;
  cy: number;
  seed: number;
  geo: GeoData | null;
  pack: PackTile | null;
  packExtent: number;
  elevation: ElevationGrid | null;
  region: RegionState;
}

export interface ChunkGenOutput {
  rgba: Uint8ClampedArray;
  collision: Uint8Array;
  spawns: ChunkSpawns;
  stats: ChunkStats;
}

const N = CHUNK_TEXELS;

const ROAD_RANK: Record<string, number> = {
  path: 0, track: 0, footway: 1, cycleway: 2, pedestrian: 3, service: 4, residential: 5, minor: 5, link: 6,
  tertiary: 7, secondary: 8, primary: 9, trunk: 10, motorway: 11,
};
const URBAN_STREETS = new Set(['residential', 'minor', 'tertiary', 'secondary', 'primary']);
const CAR_ROADS = new Set(['residential', 'minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway', 'service', 'link']);
const STREET_MATS = new Set<number>([M.ROAD, M.ROAD_MINOR, M.MOTORWAY, M.SIDEWALK, M.PATH, M.PARKING, M.CYCLE, M.BRIDGE]);
const FLOODABLE = new Set<number>([M.FARM, M.GRASS, M.LAND, M.WETLAND, M.URBAN, M.PARK, M.ALLOTMENT, M.ORCHARD, M.FARMYARD, M.SCRUB]);

export function generateChunk(inp: ChunkGenInput): ChunkGenOutput {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { cx, cy, geo, pack, region, seed } = inp;
  const ox = cx * N, oy = cy * N;
  const mpt = metersPerTexel(oy + N / 2);
  const tpm = 1 / mpt;
  const rng = new Rng(hash2(cx, cy, seed));
  const R = new IdRaster(N, N, pack || geo ? M.SEA : M.LAND);

  // 1. Overview pack as the base layer: land/sea, land cover, big water bodies.
  if (pack) {
    const unit = tileTexels(pack.z) / inp.packExtent;
    const pox = pack.x * tileTexels(pack.z), poy = pack.y * tileTexels(pack.z);
    const t: Transform = { ox: (ox - pox) / unit, oy: (oy - poy) / unit, scale: unit };
    for (const a of pack.areas) {
      const mat = SURFACE_MATERIAL[a.cls];
      if (mat === undefined) continue;
      R.fillPolygon(a.rings, mat, t);
    }
  } else if (geo && (geo.areas.length || geo.lines.length)) {
    R.ids.fill(M.LAND);
  }

  let buildings = 0;
  let roadsDrawn = 0;
  const containers: ChunkSpawns['containers'] = [];
  const roadLines: GeoLine[] = [];
  const burntBuildings: GeoArea[] = [];

  if (geo) {
    const t: Transform = { ox: ox - geo.origin.x, oy: oy - geo.origin.y, scale: 1 };
    // 2. Surfaces in draw order, then water areas
    const surfaces = geo.areas.filter((a) => a.kind === 'surface');
    surfaces.sort((a, b) => SURFACE_ORDER.indexOf(a.cls) - SURFACE_ORDER.indexOf(b.cls));
    for (const a of surfaces) {
      const mat = SURFACE_MATERIAL[a.cls];
      if (mat !== undefined) R.fillPolygon(a.rings, mat, t);
    }
    for (const a of geo.areas) if (a.kind === 'water') R.fillPolygon(a.rings, M.WATER, t);
    // 3. Waterways
    for (const l of geo.lines) if (l.kind === 'waterway') R.fillPolyline(l.pts, Math.max(1, l.width * tpm), M.WATER, t);
  }

  // 4. Flooded polders: below-sea-level land fills up once the pumps stop.
  let flooded = 0;
  if (inp.elevation?.data && region.daysSinceCollapse > 6) {
    const level = floodLevel(region.daysSinceCollapse);
    const B = 16;
    for (let by = 0; by < N; by += B) {
      for (let bx = 0; bx < N; bx += B) {
        const e = inp.elevation.sample(ox + bx + B / 2, oy + by + B / 2);
        if (e > level + 0.8) continue;
        for (let y = by; y < by + B; y++) {
          for (let x = bx; x < bx + B; x++) {
            const i = y * N + x;
            if (!FLOODABLE.has(R.ids[i])) continue;
            const n = valueNoise((ox + x) / 40, (oy + y) / 40, 77) * 1.2 - 0.6;
            if (e + n < level) {
              R.ids[i] = M.FLOOD;
              flooded++;
            }
          }
        }
      }
    }
  }

  if (geo) {
    const t: Transform = { ox: ox - geo.origin.x, oy: oy - geo.origin.y, scale: 1 };
    // 5. Roads and rail, minor first so major roads win at junctions
    const roads = geo.lines.filter((l) => l.kind === 'road').sort((a, b) => (ROAD_RANK[a.cls] ?? 0) - (ROAD_RANK[b.cls] ?? 0));
    const notWaterOrRoad = (cur: number) => cur !== M.WATER && cur !== M.SEA && !STREET_MATS.has(cur) || cur === M.SIDEWALK;
    if (region.urban > 0.25) {
      for (const l of roads) {
        if (!URBAN_STREETS.has(l.cls) || l.bridge) continue;
        R.fillPolyline(l.pts, (l.width + 3.4) * tpm, M.SIDEWALK, t, notWaterOrRoad);
      }
    }
    for (const l of roads) {
      const mat = l.bridge ? M.BRIDGE : ROAD_MATERIAL[l.cls] ?? M.ROAD_MINOR;
      R.fillPolyline(l.pts, Math.max(1, l.width * tpm), mat, t);
      if (lineTouchesChunk(l, t)) {
        roadsDrawn++;
        roadLines.push(l);
      }
    }
    for (const l of geo.lines) {
      if (l.kind !== 'rail') continue;
      R.fillPolyline(l.pts, (l.width + 1.5) * tpm, M.RAILGROUND, t);
      R.fillPolyline(l.pts, Math.max(1, 1.5 * tpm), M.RAIL, t);
    }
    // lane markings on big roads
    for (const l of roads) {
      if ((ROAD_RANK[l.cls] ?? 0) < 8 || l.bridge) continue;
      dashedLine(R, l.pts, t, 3 * tpm, 6 * tpm, M.MARKING);
    }

    // 6. Buildings
    const pois = geo.pois;
    let streets: SegmentIndex | undefined;
    for (const a of geo.areas) {
      if (a.kind !== 'building' || a.rings.length === 0) continue;
      const outer = a.rings[0];
      const bb = bbox(outer);
      if (bb[2] < t.ox || bb[0] > t.ox + N || bb[3] < t.oy || bb[1] > t.oy + N) continue;
      const h = hashString(a.id) ^ seed;
      let cls = a.cls;
      const c = ringCentroid(outer);
      // a shop/amenity point inside the footprint refines what the building is
      if (pois.length && cls !== 'police' && cls !== 'hospital') {
        for (const p of pois) {
          if (p.x < bb[0] || p.x > bb[2] || p.y < bb[1] || p.y > bb[3]) continue;
          if (pointInPolygon(p.x, p.y, a.rings)) { cls = p.cls; break; }
        }
      }
      const burnt = ((h >>> 8) & 1023) / 1024 < region.fire * 0.18 * (cls === 'church' || cls === 'civic' ? 0.2 : 1);
      const roof = burnt ? M.ROOF_BURNT : roofMaterial(cls, h);
      const levels = a.levels ?? (cls === 'apartments' ? 4 : cls === 'house' ? 2 : 2);
      const height = Math.max(2, Math.min(7, Math.round(levels * 1.4)));
      R.fillPolygon(a.rings, roof, t, height);
      R.strokeRings(a.rings, M.WALL, t, (cur) => IS_ROOF[cur] === 1);
      if (burnt) burntBuildings.push(a);

      // loot container at the door, only for buildings whose centre lies in this chunk
      const wx = geo.origin.x + c.x, wy = geo.origin.y + c.y;
      if (wx < ox || wy < oy || wx >= ox + N || wy >= oy + N) continue;
      const areaM2 = Math.abs(ringArea(outer)) * mpt * mpt;
      if (areaM2 < 9) continue;
      buildings++;
      const door = findDoor(outer, c.x, c.y, streets ??= new SegmentIndex(roads, 64), tpm);
      containers.push({
        id: `b:${a.id}`,
        x: geo.origin.x + door.x,
        y: geo.origin.y + door.y,
        type: buildingLootType(cls),
        label: a.name ?? buildingLabel(cls),
        scavenged: Math.min(1, region.evacuation * 0.6 + (burnt ? 0.5 : 0)),
      });
    }
  }

  // 7. Burnt-out surroundings
  for (const b of burntBuildings) {
    if (!geo) break;
    const outer = b.rings[0];
    const r2 = new Rng(hashString(b.id));
    for (let i = 0; i < outer.length / 2; i += 2) {
      const x = outer[i * 2] + geo.origin.x - ox, y = outer[i * 2 + 1] + geo.origin.y - oy;
      R.fillDisk(x + r2.range(-3, 3), y + r2.range(-3, 3), r2.range(1, 3.5), M.RUBBLE, (cur) => !IS_ROOF[cur] && cur !== M.WATER);
    }
  }

  // 8. The apocalypse layer
  const spawns = populate(R, inp, roadLines, rng, tpm);
  spawns.containers.unshift(...containers);

  // 9. Shade, collision, decals
  const rgba = new Uint8ClampedArray(N * N * 4);
  const overgrowth = Math.min(1, region.daysSinceCollapse / 120);
  shadeRaster(R, rgba, { wx0: ox, wy0: oy, tpp: 1, damage: region.intensity, overgrowth, detail: true });
  const collision = collisionFrom(R);
  for (const v of spawns.vehicles) stampVehicle(collision, v, ox, oy, tpm);
  decals(rgba, spawns, ox, oy, tpm, rng);

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    rgba,
    collision,
    spawns,
    stats: { buildings, roads: roadsDrawn, source: geo?.source ?? 'none', ms: Math.round(t1 - t0), flooded },
  };
}

function lineTouchesChunk(l: GeoLine, t: Transform): boolean {
  for (let i = 0; i < l.pts.length; i += 2) {
    const x = l.pts[i] - t.ox, y = l.pts[i + 1] - t.oy;
    if (x >= -20 && y >= -20 && x < N + 20 && y < N + 20) return true;
  }
  return false;
}

function bbox(r: number[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i]; if (r[i] > x1) x1 = r[i];
    if (r[i + 1] < y0) y0 = r[i + 1]; if (r[i + 1] > y1) y1 = r[i + 1];
  }
  return [x0, y0, x1, y1];
}

function roofMaterial(cls: string, h: number): number {
  const pick = (opts: number[]) => opts[(h >>> 3) % opts.length];
  switch (cls) {
    case 'house': case 'residential': case 'other': return pick([M.ROOF_RED, M.ROOF_RED, M.ROOF_BROWN, M.ROOF_SLATE, M.ROOF_DARK]);
    case 'apartments': return pick([M.ROOF_FLAT, M.ROOF_GRAY, M.ROOF_DARK, M.ROOF_RED]);
    case 'church': return M.ROOF_SLATE;
    case 'greenhouse': return M.GLASS;
    case 'industrial': case 'warehouse': case 'farm': case 'garage': case 'mechanic': return pick([M.ROOF_METAL, M.ROOF_GRAY, M.ROOF_FLAT]);
    case 'shed': return pick([M.ROOF_DARK, M.ROOF_BROWN]);
    default: return pick([M.ROOF_FLAT, M.ROOF_FLAT, M.ROOF_GRAY]);
  }
}

const LABELS: Record<string, string> = {
  house: 'House', residential: 'House', apartments: 'Apartment block', grocery: 'Supermarket', pharmacy: 'Pharmacy',
  medical: 'Clinic', hospital: 'Hospital', hardware: 'Hardware store', outdoor: 'Sports shop', police: 'Police station',
  fire_station: 'Fire station', military: 'Military building', fuel: 'Petrol station', food_service: 'Café',
  shop: 'Shop', retail: 'Shop', commercial: 'Commercial building', office: 'Offices', civic: 'Public building',
  school: 'School', industrial: 'Factory', warehouse: 'Warehouse', farm: 'Barn', greenhouse: 'Greenhouse',
  church: 'Church', garage: 'Garage', shed: 'Shed', mechanic: 'Garage workshop',
};

function buildingLabel(cls: string): string {
  return LABELS[cls] ?? 'Building';
}

/** Uniform grid over street segments so each building only checks nearby ones. */
class SegmentIndex {
  private cells = new Map<number, number[]>();
  readonly segs: number[] = [];
  constructor(roads: GeoLine[], private cell: number) {
    for (const l of roads) {
      if (!CAR_ROADS.has(l.cls) && l.cls !== 'footway' && l.cls !== 'pedestrian') continue;
      const p = l.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const si = this.segs.length;
        this.segs.push(p[i], p[i + 1], p[i + 2], p[i + 3]);
        const x0 = Math.floor(Math.min(p[i], p[i + 2]) / cell), x1 = Math.floor(Math.max(p[i], p[i + 2]) / cell);
        const y0 = Math.floor(Math.min(p[i + 1], p[i + 3]) / cell), y1 = Math.floor(Math.max(p[i + 1], p[i + 3]) / cell);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) continue;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const k = y * 65536 + x;
          let c = this.cells.get(k);
          if (!c) this.cells.set(k, (c = []));
          c.push(si);
        }
      }
    }
  }
  nearest(px: number, py: number, maxD: number) {
    let best = { x: px, y: py, t: 0, d: Infinity };
    const r = Math.ceil(maxD / this.cell);
    const cx = Math.floor(px / this.cell), cy = Math.floor(py / this.cell);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const c = this.cells.get(y * 65536 + x);
        if (!c) continue;
        for (const si of c) {
          const s = this.segs;
          const q = closestOnSegment(px, py, s[si], s[si + 1], s[si + 2], s[si + 3]);
          if (q.d < best.d) best = q;
        }
      }
    }
    return best;
  }
}

/** A walkable spot just outside the footprint, on the side facing the nearest street. */
function findDoor(ring: number[], cx: number, cy: number, streets: SegmentIndex, tpm: number) {
  const best = streets.nearest(cx, cy, 80 * tpm);
  const tx = best.d < 80 * tpm ? best.x : cx;
  const ty = best.d < 80 * tpm ? best.y : cy + 1e6;
  let door = { x: ring[0], y: ring[1], d: Infinity, nx: 0, ny: 1 };
  for (let i = 0; i + 3 < ring.length; i += 2) {
    const q = closestOnSegment(tx, ty, ring[i], ring[i + 1], ring[i + 2], ring[i + 3]);
    if (q.d < door.d) {
      const ex = ring[i + 2] - ring[i], ey = ring[i + 3] - ring[i + 1];
      const len = Math.hypot(ex, ey) || 1;
      let nx = -ey / len, ny = ex / len;
      // flip the edge normal to point away from the centroid
      if ((q.x - cx) * nx + (q.y - cy) * ny < 0) { nx = -nx; ny = -ny; }
      door = { x: q.x, y: q.y, d: q.d, nx, ny };
    }
  }
  const off = 0.9 * tpm;
  return { x: door.x + door.nx * off, y: door.y + door.ny * off };
}

function dashedLine(R: IdRaster, pts: number[], t: Transform, dash: number, gap: number, id: number) {
  let acc = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i] - t.ox, ay = pts[i + 1] - t.oy, bx = pts[i + 2] - t.ox, by = pts[i + 3] - t.oy;
    const len = Math.hypot(bx - ax, by - ay);
    if (Math.max(ax, bx) < 0 || Math.min(ax, bx) > N || Math.max(ay, by) < 0 || Math.min(ay, by) > N) { acc += len; continue; }
    for (let s = 0; s < len; s += 1) {
      if ((acc + s) % (dash + gap) < dash) {
        const f = s / len;
        R.set(Math.floor(ax + (bx - ax) * f), Math.floor(ay + (by - ay) * f), id);
      }
    }
    acc += len;
  }
}

/** Walk along road segments that fall inside the chunk at a fixed spacing. */
function* alongRoad(l: GeoLine, t: Transform, spacing: number, rng: Rng) {
  let carry = rng.range(0, spacing);
  for (let i = 0; i + 3 < l.pts.length; i += 2) {
    const ax = l.pts[i] - t.ox, ay = l.pts[i + 1] - t.oy, bx = l.pts[i + 2] - t.ox, by = l.pts[i + 3] - t.oy;
    const len = Math.hypot(bx - ax, by - ay);
    const ang = Math.atan2(by - ay, bx - ax);
    let s = carry;
    while (s < len) {
      const f = s / len;
      const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
      if (x >= 0 && y >= 0 && x < N && y < N) yield { x, y, ang };
      s += spacing;
    }
    carry = s - len;
  }
}

function populate(R: IdRaster, inp: ChunkGenInput, roads: GeoLine[], rng: Rng, tpm: number): ChunkSpawns {
  const { cx, cy, region, geo } = inp;
  const ox = cx * N, oy = cy * N;
  const out: ChunkSpawns = { containers: [], vehicles: [], corpses: [], zombies: [] };
  const id = (k: string, i: number) => `${k}:${cx},${cy}:${i}`;
  const free = (x: number, y: number) => {
    const v = R.get(Math.floor(x), Math.floor(y));
    return v !== 255 && !IS_ROOF[v] && v !== M.WATER && v !== M.SEA && v !== M.SANDBAG;
  };
  const t: Transform = geo ? { ox: ox - geo.origin.x, oy: oy - geo.origin.y, scale: 1 } : { ox: 0, oy: 0, scale: 1 };
  const vehicles: SpawnVehicle[] = out.vehicles;
  let vi = 0;
  const modelFor = (major: boolean): VehicleModel => rng.weighted<VehicleModel>([
    ['car', 70], ['van', 12], ['truck', major ? 6 : 1], ['bus', major ? 2 : 0.5],
    ['police', 1.5 + region.military * 2], ['ambulance', 1.2], ['military', region.military * (major ? 6 : 1)],
  ]);
  const lootFor = (m: VehicleModel) => (m === 'police' ? 'police_car' : m === 'military' ? 'military_vehicle' : m === 'ambulance' ? 'ambulance' : m === 'bus' ? 'car' : 'car');
  const addVehicle = (x: number, y: number, angle: number, major: boolean, crashed = false) => {
    if (vehicles.length >= 140 || !free(x, y)) return;
    const m = modelFor(major);
    const burnt = rng.chance(region.fire * 0.35 + (crashed ? 0.15 : 0));
    vehicles.push({
      id: id('v', vi++), x: ox + x, y: oy + y, angle: angle + (crashed ? rng.range(-0.9, 0.9) : rng.range(-0.05, 0.05)),
      model: m, color: rng.int(0, 11), burnt, lootType: burnt ? null : lootFor(m),
    });
  };

  // Parked cars, evacuation jams and crashes along the real road network
  for (const l of roads) {
    if (!CAR_ROADS.has(l.cls)) continue;
    const major = (ROAD_RANK[l.cls] ?? 0) >= 9;
    const halfW = (l.width * tpm) / 2;
    if (major && region.evacuation > 0.2) {
      const lanes = Math.max(1, Math.round(l.width / 3.6));
      for (let lane = 0; lane < lanes; lane++) {
        const off = -halfW + (lane + 0.5) * (l.width * tpm) / lanes;
        for (const p of alongRoad(l, t, 6.8 * tpm, rng)) {
          if (!rng.chance(region.evacuation * 0.85)) continue;
          const nx = -Math.sin(p.ang), ny = Math.cos(p.ang);
          addVehicle(p.x + nx * off, p.y + ny * off, p.ang, true, rng.chance(0.07));
        }
      }
    } else if (!major && l.cls !== 'service' && region.urban > 0.15) {
      const pPark = 0.15 + 0.4 * region.urban;
      for (const p of alongRoad(l, t, 6.5 * tpm, rng)) {
        if (!rng.chance(pPark)) continue;
        const side = rng.chance(0.5) ? 1 : -1;
        const nx = -Math.sin(p.ang), ny = Math.cos(p.ang);
        const off = side * Math.max(0, halfW - 1.1 * tpm);
        addVehicle(p.x + nx * off, p.y + ny * off, p.ang + (side < 0 ? Math.PI : 0), false, rng.chance(0.04 + region.intensity * 0.04));
      }
    } else {
      for (const p of alongRoad(l, t, 40 * tpm, rng)) {
        if (rng.chance(0.15 + region.evacuation * 0.3)) addVehicle(p.x, p.y, p.ang, major, rng.chance(0.5));
      }
    }
  }

  // Military checkpoints where the army tried to hold the line
  const majorRoads = roads.filter((l) => (ROAD_RANK[l.cls] ?? 0) >= 7);
  let checkpoint: { x: number; y: number } | null = null;
  if (majorRoads.length && region.military > 0.3 && rng.chance(region.military * 0.45)) {
    const l = rng.pick(majorRoads);
    const pts = [...alongRoad(l, t, 15 * tpm, rng)];
    if (pts.length) {
      const p = pts[Math.floor(pts.length / 2)];
      checkpoint = p;
      const nx = -Math.sin(p.ang), ny = Math.cos(p.ang);
      const w = (l.width * tpm) / 2 + 3 * tpm;
      for (const side of [-1, 1]) {
        const along = side * 6 * tpm;
        const bx = p.x + Math.cos(p.ang) * along, by = p.y + Math.sin(p.ang) * along;
        // sandbag wall across the road with a gap in the middle
        for (let s = -w; s <= w; s += 1) {
          if (Math.abs(s) < 1.6 * tpm) continue;
          R.fillDisk(bx + nx * s, by + ny * s, 0.55 * tpm, M.SANDBAG, (cur) => !IS_ROOF[cur]);
        }
      }
      for (let k = 0; k < rng.int(1, 3); k++) {
        vehicles.push({
          id: id('v', vi++), x: ox + p.x + Math.cos(p.ang) * rng.range(10, 18) * tpm * (k % 2 ? 1 : -1), y: oy + p.y + Math.sin(p.ang) * rng.range(10, 18) * tpm * (k % 2 ? 1 : -1),
          angle: p.ang + rng.range(-0.4, 0.4), model: 'military', color: 0, burnt: rng.chance(0.2), lootType: 'military_vehicle',
        });
      }
      for (let k = 0; k < rng.int(1, 3); k++) {
        out.containers.push({ id: id('crate', k), x: ox + p.x + nx * rng.range(-w, w), y: oy + p.y + ny * rng.range(-w, w), type: 'crate', label: 'Army supply crate', scavenged: 0 });
      }
    }
  }

  // The dead
  const deadCount = Math.round(region.intensity * (2 + region.urban * 10) * rng.range(0.6, 1.4) + (checkpoint ? rng.int(3, 7) : 0));
  let di = 0;
  for (let tries = 0; tries < deadCount * 12 && out.corpses.length < deadCount; tries++) {
    let x: number, y: number, kind: CorpseKind = 'civilian';
    if (checkpoint && out.corpses.length < 5) {
      x = checkpoint.x + rng.range(-25, 25) * tpm * 0.5;
      y = checkpoint.y + rng.range(-25, 25) * tpm * 0.5;
      kind = rng.chance(0.6) ? 'soldier' : 'civilian';
    } else {
      x = rng.range(0, N);
      y = rng.range(0, N);
      if (!STREET_MATS.has(R.get(Math.floor(x), Math.floor(y))) && !rng.chance(0.15)) continue;
      if (rng.chance(0.05 + region.military * 0.05)) kind = rng.chance(0.5) ? 'police' : 'soldier';
    }
    if (!free(x, y)) continue;
    out.corpses.push({
      id: id('c', di++), x: ox + x, y: oy + y, angle: rng.range(0, Math.PI * 2), kind,
      lootType: kind === 'soldier' ? 'corpse_soldier' : kind === 'police' ? 'corpse_police' : 'corpse',
    });
  }

  // The undead
  const zCount = Math.round(1 + region.intensity * (3 + region.urban * 18) * rng.range(0.7, 1.3) + (checkpoint ? rng.int(3, 6) : 0) + Math.min(10, vehicles.length * region.evacuation * 0.1));
  let zi = 0;
  for (let tries = 0; tries < zCount * 15 && out.zombies.length < zCount; tries++) {
    const x = rng.range(0, N), y = rng.range(0, N);
    if (!free(x, y)) continue;
    const mat = R.get(Math.floor(x), Math.floor(y));
    if (!STREET_MATS.has(mat) && !rng.chance(0.35)) continue;
    let kind: ZombieKind = 'civilian';
    const r = rng.next();
    if (checkpoint && r < 0.4) kind = 'soldier';
    else if (r < 0.05 + region.military * 0.08) kind = 'soldier';
    else if (r < 0.1) kind = 'police';
    else if (r < 0.16) kind = 'runner';
    out.zombies.push({ id: id('z', zi++), x: ox + x, y: oy + y, kind, hp: kind === 'soldier' ? 90 : kind === 'runner' ? 45 : 60 });
  }
  return out;
}

const VEHICLE_SIZE: Record<VehicleModel, [number, number]> = {
  car: [4.4, 1.8], van: [5.2, 2.0], truck: [8.5, 2.5], bus: [12, 2.55], police: [4.6, 1.85], ambulance: [6, 2.2], military: [5.5, 2.3],
};

export function vehicleSize(m: VehicleModel): [number, number] {
  return VEHICLE_SIZE[m];
}

function stampVehicle(col: Uint8Array, v: SpawnVehicle, ox: number, oy: number, tpm: number) {
  const [L, W] = VEHICLE_SIZE[v.model];
  const hl = (L * tpm) / 2, hw = (W * tpm) / 2;
  const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
  const x = v.x - ox, y = v.y - oy;
  const r = Math.ceil(Math.hypot(hl, hw));
  for (let py = Math.max(0, Math.floor(y - r)); py <= Math.min(N - 1, Math.ceil(y + r)); py++) {
    for (let px = Math.max(0, Math.floor(x - r)); px <= Math.min(N - 1, Math.ceil(x + r)); px++) {
      const dx = px + 0.5 - x, dy = py + 0.5 - y;
      const u = dx * ca + dy * sa, w = -dx * sa + dy * ca;
      if (Math.abs(u) <= hl && Math.abs(w) <= hw) col[py * N + px] = C.SOLID;
    }
  }
}

function blend(rgba: Uint8ClampedArray, x: number, y: number, r: number, g: number, b: number, a: number) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  const i = (y * N + x) * 4;
  rgba[i] = rgba[i] * (1 - a) + r * a;
  rgba[i + 1] = rgba[i + 1] * (1 - a) + g * a;
  rgba[i + 2] = rgba[i + 2] * (1 - a) + b * a;
}

function splat(rgba: Uint8ClampedArray, cx: number, cy: number, radius: number, color: [number, number, number], alpha: number, rng: Rng) {
  const r = Math.ceil(radius);
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const d = Math.hypot(x, y) / radius;
      if (d > 1 || rng.next() > 1.15 - d) continue;
      blend(rgba, Math.floor(cx + x), Math.floor(cy + y), color[0], color[1], color[2], alpha * (1 - d * 0.5));
    }
  }
}

function decals(rgba: Uint8ClampedArray, s: ChunkSpawns, ox: number, oy: number, tpm: number, rng: Rng) {
  for (const c of s.corpses) splat(rgba, c.x - ox, c.y - oy, 1.6 * tpm, [86, 18, 16], 0.75, rng);
  for (const v of s.vehicles) if (v.burnt) splat(rgba, v.x - ox, v.y - oy, 3.4 * tpm, [20, 18, 17], 0.6, rng);
  // scattered litter and stains
  const n = 120;
  for (let i = 0; i < n; i++) {
    const x = Math.floor(rng.range(0, N)), y = Math.floor(rng.range(0, N));
    if (rng.chance(0.2)) splat(rgba, x, y, rng.range(1, 2.5) * tpm, [70, 22, 18], 0.35, rng);
    else blend(rgba, x, y, 200, 196, 180, 0.6);
  }
}
