// Natural Earth 1:50m land, for the view from space outside the country pack.

import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import land50 from 'world-atlas/land-50m.json';
import { lonLatToWorld } from '../core/geo';

export interface WorldRing {
  pts: Float64Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

let cached: WorldRing[] | null = null;

export function worldLandRings(): WorldRing[] {
  if (cached) return cached;
  const topo = land50 as unknown as Topology<{ land: GeometryCollection }>;
  const fc = feature(topo, topo.objects.land) as unknown as GeoJSON.FeatureCollection;
  const rings: WorldRing[] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      const outer = poly[0];
      const pts = new Float64Array(outer.length * 2);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      outer.forEach(([lon, lat], i) => {
        const w = lonLatToWorld(lon, lat);
        pts[i * 2] = w.x;
        pts[i * 2 + 1] = w.y;
        if (w.x < x0) x0 = w.x; if (w.x > x1) x1 = w.x;
        if (w.y < y0) y0 = w.y; if (w.y > y1) y1 = w.y;
      });
      rings.push({ pts, x0, y0, x1, y1 });
    }
  }
  cached = rings;
  return rings;
}
