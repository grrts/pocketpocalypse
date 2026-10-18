// Overview raster tiles for every zoom between space and street level, drawn
// with the same material rasterizer as street chunks so the LODs blend.

import { TILE_PX, metersPerTexel, tileOrigin, tileTexels, worldToLonLat } from '../core/geo';
import type { ElevationGrid } from '../data/elevation';
import type { PackTile } from '../data/types';
import type { WorldRing } from '../data/worldLand';
import { M, SURFACE_MATERIAL, shadeRaster } from '../render/materials';
import { floodLevel } from './flood';
import { IdRaster, type Transform } from '../render/raster';

export interface OverviewInput {
  z: number;
  x: number;
  y: number;
  pack: PackTile | null;
  packExtent: number;
  worldLand: WorldRing[];
  elevation: ElevationGrid | null;
  /** days since collapse near the tile centre, for polder flooding */
  daysSinceCollapse: number;
}

const LINE_STYLE: Record<string, [mat: number, metres: number, minZ: number]> = {
  motorway: [M.OV_MOTORWAY, 28, 5],
  trunk: [M.OV_MOTORWAY, 20, 8],
  primary: [M.OV_ROAD, 14, 8],
  secondary: [M.OV_ROAD, 10, 11],
  tertiary: [M.OV_ROAD, 8, 12],
  rail: [M.OV_RAIL, 6, 9],
  river: [M.WATER, 40, 8],
  canal: [M.WATER, 18, 10],
  stream: [M.WATER, 4, 13],
};

const FLOODABLE = new Set<number>([M.FARM, M.GRASS, M.LAND, M.WETLAND, M.URBAN, M.PARK]);

export function renderOverview(inp: OverviewInput): Uint8ClampedArray {
  const { z, x, y, pack } = inp;
  const R = new IdRaster(TILE_PX, TILE_PX, M.SEA);
  const o = tileOrigin(z, x, y);
  const tpp = tileTexels(z) / TILE_PX; // world texels per raster pixel
  const size = tileTexels(z);

  // Natural Earth land under (or instead of) the pack
  if (!pack || pack.z < 8) {
    const t: Transform = { ox: o.x, oy: o.y, scale: 1 / tpp };
    for (const r of inp.worldLand) {
      if (r.x1 < o.x || r.x0 > o.x + size || r.y1 < o.y || r.y0 > o.y + size) continue;
      R.fillPolygon([r.pts], M.LAND, t);
    }
  }

  if (pack) {
    const unit = tileTexels(pack.z) / inp.packExtent;
    const po = tileOrigin(pack.z, pack.x, pack.y);
    const t: Transform = { ox: (o.x - po.x) / unit, oy: (o.y - po.y) / unit, scale: unit / tpp };
    for (const a of pack.areas) {
      const mat = SURFACE_MATERIAL[a.cls];
      if (mat !== undefined) R.fillPolygon(a.rings, mat, t);
    }
    const mpt = metersPerTexel(o.y + size / 2);
    const lines = pack.lines.slice().sort((a, b) => order(a.cls) - order(b.cls));
    for (const l of lines) {
      const st = LINE_STYLE[l.cls];
      if (!st || z < st[2]) continue;
      const px = Math.max(1, st[1] / mpt / tpp);
      R.fillPolyline(l.pts, Math.min(px, 6), st[0], t);
    }
  }

  // Flooded polders, consistent with street chunks
  const e = inp.elevation;
  if (e?.data && inp.daysSinceCollapse > 6) {
    const level = floodLevel(inp.daysSinceCollapse);
    for (let py = 0; py < TILE_PX; py++) {
      for (let px = 0; px < TILE_PX; px++) {
        const i = py * TILE_PX + px;
        if (!FLOODABLE.has(R.ids[i])) continue;
        if (e.sample(o.x + (px + 0.5) * tpp, o.y + (py + 0.5) * tpp) < level) R.ids[i] = M.FLOOD;
      }
    }
  }

  const rgba = new Uint8ClampedArray(TILE_PX * TILE_PX * 4);
  shadeRaster(R, rgba, { wx0: o.x, wy0: o.y, tpp, damage: 0, overgrowth: 0, detail: false });

  // Hillshade: the Netherlands is flat, so relief is exaggerated to show dunes,
  // the Veluwe and Limburg.
  if (e?.data) {
    const mpp = metersPerTexel(o.y + size / 2) * tpp;
    const k = Math.min(30, 3 + mpp / 40);
    for (let py = 0; py < TILE_PX; py++) {
      for (let px = 0; px < TILE_PX; px++) {
        const i = py * TILE_PX + px;
        const wx = o.x + (px + 0.5) * tpp, wy = o.y + (py + 0.5) * tpp;
        const h = e.sample(wx, wy);
        const dx = e.sample(wx + tpp, wy) - h;
        const dy = e.sample(wx, wy + tpp) - h;
        // dead zone: ignore sub-metre noise in the flat polders
        let s = -(dx + dy);
        s = Math.sign(s) * Math.max(0, Math.abs(s) - 0.8);
        let f = 1 + Math.max(-0.25, Math.min(0.25, (s / mpp) * k));
        if (h < -0.5 && h > -12) f *= 0.96; // below sea level reads slightly darker
        if (f !== 1) {
          rgba[i * 4] = Math.min(255, rgba[i * 4] * f);
          rgba[i * 4 + 1] = Math.min(255, rgba[i * 4 + 1] * f);
          rgba[i * 4 + 2] = Math.min(255, rgba[i * 4 + 2] * f);
        }
      }
    }
  }
  return rgba;
}

function order(cls: string): number {
  return ['stream', 'canal', 'river', 'rail', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'].indexOf(cls);
}

export function tileCenterLonLat(z: number, x: number, y: number) {
  const s = tileTexels(z);
  return worldToLonLat((x + 0.5) * s, (y + 0.5) * s);
}
