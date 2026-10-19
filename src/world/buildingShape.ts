// Geometry shared by everything that uses a BuildingModel instead of the raw
// map outline: the squared-up outline (for interiors, lookups and the chunk's
// collision), the cells that solidify the ground under the building, which wing
// sides are real outside walls (not shared with another wing), and a simple
// fallback set of doors and windows for models that come without openings.

import type { Box } from './floorplan';
import { toWorld, type BuildingModel, type Opening } from './buildingModel';

const EPS = 1e-6;

/** Unique, sorted breakpoints (metres) of all wing boxes along s and d. */
function breaks(m: BuildingModel): { ss: number[]; ds: number[] } {
  const uniq = (v: number[]) => {
    v.sort((a, b) => a - b);
    const o: number[] = [];
    for (const x of v) if (!o.length || x - o[o.length - 1] > 1e-4) o.push(x);
    return o;
  };
  const ss: number[] = [], ds: number[] = [];
  for (const w of m.wings) { ss.push(w.box.s0, w.box.s1); ds.push(w.box.d0, w.box.d1); }
  return { ss: uniq(ss), ds: uniq(ds) };
}

const inBox = (b: Box, s: number, d: number) => s > b.s0 && s < b.s1 && d > b.d0 && d < b.d1;

/** Is (s, d) in the model frame (metres) inside any wing? */
export function insideWings(m: BuildingModel, s: number, d: number): boolean {
  for (const w of m.wings) if (inBox(w.box, s, d)) return true;
  return false;
}

/** World texel -> model frame (metres). */
export function toModel(m: BuildingModel, x: number, y: number): [number, number] {
  const dx = (x - m.ox) / m.tpm, dy = (y - m.oy) / m.tpm;
  return [dx * m.ux + dy * m.uy, -dx * m.uy + dy * m.ux];
}

/** The grid of cells the wings cover, on the wings' own breakpoints. */
function cells(m: BuildingModel): { ss: number[]; ds: number[]; on: Uint8Array } {
  const { ss, ds } = breaks(m);
  const ns = ss.length - 1, nd = ds.length - 1;
  const on = new Uint8Array(Math.max(0, ns * nd));
  for (let j = 0; j < nd; j++) {
    const d = (ds[j] + ds[j + 1]) / 2;
    for (let i = 0; i < ns; i++) on[j * ns + i] = insideWings(m, (ss[i] + ss[i + 1]) / 2, d) ? 1 : 0;
  }
  return { ss, ds, on };
}

/**
 * The squared-up outline of the whole building as world-texel rings (largest
 * first; courtyards come out as extra rings, fine for even-odd tests).
 */
export function modelOutline(m: BuildingModel): number[][] {
  const { ss, ds, on } = cells(m);
  const ns = ss.length - 1, nd = ds.length - 1;
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < ns && j < nd && on[j * ns + i] === 1;
  // directed boundary edges, covered cell on the left; vertices are grid points (i, j)
  const next = new Map<number, number[]>();
  const key = (i: number, j: number) => j * 4096 + i;
  const add = (a: number, b: number) => { const l = next.get(a); if (l) l.push(b); else next.set(a, [b]); };
  for (let j = 0; j < nd; j++) {
    for (let i = 0; i < ns; i++) {
      if (!at(i, j)) continue;
      if (!at(i, j - 1)) add(key(i + 1, j), key(i, j));
      if (!at(i + 1, j)) add(key(i + 1, j + 1), key(i + 1, j));
      if (!at(i, j + 1)) add(key(i, j + 1), key(i + 1, j + 1));
      if (!at(i - 1, j)) add(key(i, j), key(i, j + 1));
    }
  }
  const loops: number[][] = [];
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const pts: number[] = [];
      let v = start;
      do {
        pts.push(v);
        const l = next.get(v)!;
        const w = l.pop()!;
        if (!l.length) next.delete(v);
        v = w;
      } while (v !== start && next.has(v));
      // drop collinear points
      const out: number[] = [];
      const n = pts.length;
      for (let k = 0; k < n; k++) {
        const a = pts[(k + n - 1) % n], b = pts[k], c = pts[(k + 1) % n];
        const ax = a % 4096, ay = Math.floor(a / 4096), bx = b % 4096, by = Math.floor(b / 4096), cx = c % 4096, cy = Math.floor(c / 4096);
        if ((ax === bx && bx === cx) || (ay === by && by === cy)) continue;
        const [x, y] = toWorld(m, ss[bx], ds[by]);
        out.push(x, y);
      }
      if (out.length >= 6) loops.push(out);
    }
  }
  const area = (r: number[]) => { let s = 0; for (let i = 0, n = r.length; i < n; i += 2) { const j = (i + 2) % n; s += r[i] * r[j + 1] - r[j] * r[i + 1]; } return Math.abs(s) / 2; };
  loops.sort((a, b) => area(b) - area(a));
  return loops;
}

/**
 * The ground the building stands on, as world-texel quads: every covered cell,
 * pulled in by `inset` texels on its outside edges, so rasterising them (pixel
 * centres inside) never pokes a texel out past the drawn walls.
 */
export function footprintQuads(m: BuildingModel, inset: number): number[][] {
  const { ss, ds, on } = cells(m);
  const ns = ss.length - 1, nd = ds.length - 1;
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < ns && j < nd && on[j * ns + i] === 1;
  const e = inset / m.tpm;
  const out: number[][] = [];
  for (let j = 0; j < nd; j++) {
    for (let i = 0; i < ns; i++) {
      if (!at(i, j)) continue;
      const s0 = ss[i] + (at(i - 1, j) ? 0 : e), s1 = ss[i + 1] - (at(i + 1, j) ? 0 : e);
      const d0 = ds[j] + (at(i, j - 1) ? 0 : e), d1 = ds[j + 1] - (at(i, j + 1) ? 0 : e);
      if (s1 - s0 < EPS || d1 - d0 < EPS) continue;
      out.push([...toWorld(m, s0, d0), ...toWorld(m, s1, d0), ...toWorld(m, s1, d1), ...toWorld(m, s0, d1)]);
    }
  }
  return out;
}

/** Side `side` of box b as (fixed coordinate, along-start, along-end, outward sign). */
export function sideLine(b: Box, side: number): { fixed: number; a0: number; a1: number; alongS: boolean; out: number } {
  switch (side) {
    case 0: return { fixed: b.d0, a0: b.s0, a1: b.s1, alongS: true, out: -1 };
    case 1: return { fixed: b.s1, a0: b.d0, a1: b.d1, alongS: false, out: 1 };
    case 2: return { fixed: b.d1, a0: b.s0, a1: b.s1, alongS: true, out: 1 };
    default: return { fixed: b.s0, a0: b.d0, a1: b.d1, alongS: false, out: -1 };
  }
}

/**
 * Parts of a wing side that are outside walls: [from, to] intervals along the
 * side (metres, same axis as sideLine's a0..a1) not covered by another wing.
 */
export function exposedParts(m: BuildingModel, wing: number, side: number, probe = 0.05): [number, number][] {
  const b = m.wings[wing].box;
  const L = sideLine(b, side);
  let parts: [number, number][] = [[L.a0, L.a1]];
  const f = L.fixed + L.out * probe;
  for (let k = 0; k < m.wings.length; k++) {
    if (k === wing) continue;
    const o = m.wings[k].box;
    const [lo, hi, f0, f1] = L.alongS ? [o.s0, o.s1, o.d0, o.d1] : [o.d0, o.d1, o.s0, o.s1];
    if (f <= f0 || f >= f1) continue;
    const next: [number, number][] = [];
    for (const [a, c] of parts) {
      if (hi <= a || lo >= c) { next.push([a, c]); continue; }
      if (lo > a) next.push([a, lo]);
      if (hi < c) next.push([hi, c]);
    }
    parts = next.filter(([a, c]) => c - a > 0.05);
    if (!parts.length) break;
  }
  return parts;
}

const SHOPS = new Set(['shop', 'retail', 'commercial', 'grocery', 'supermarket', 'pharmacy', 'hardware', 'outdoor', 'food_service', 'fuel']);
const NO_WINDOWS = new Set(['shed', 'garage', 'warehouse', 'industrial']);

/**
 * Doors and windows for a model that came without any: the front door where the
 * street door is, windows on a regular rhythm on every outside wall and storey,
 * and a shopfront on the street side of shops.
 */
export function fallbackOpenings(m: BuildingModel, door: { x: number; y: number }): Opening[] {
  const out: Opening[] = [];
  const [ds, dd] = toModel(m, door.x, door.y);
  // the side nearest the door
  let best = { wing: 0, side: 0 as 0 | 1 | 2 | 3, at: 0, d: Infinity };
  m.wings.forEach((w, wi) => {
    for (let side = 0; side < 4; side++) {
      const L = sideLine(w.box, side);
      const along = L.alongS ? ds : dd, off = L.alongS ? dd : ds;
      const a = Math.max(L.a0 + 0.6, Math.min(L.a1 - 0.6, along));
      const dist = Math.abs(off - L.fixed) + Math.abs(a - along);
      if (dist < best.d) best = { wing: wi, side: side as 0 | 1 | 2 | 3, at: a - L.a0, d: dist };
    }
  });
  const shop = SHOPS.has(m.cls);
  const windows = !NO_WINDOWS.has(m.cls);
  const storeys = Math.max(1, m.storeys);
  m.wings.forEach((w, wi) => {
    for (let side = 0; side < 4; side++) {
      const L = sideLine(w.box, side);
      for (const [a, c] of exposedParts(m, wi, side)) {
        const len = c - a;
        const front = wi === best.wing && side === best.side;
        const doorAt = front ? L.a0 + best.at : NaN;
        if (front && shop && len > 4) {
          out.push({ wing: wi, side: side as 0 | 1 | 2 | 3, at: (a + c) / 2 - L.a0, w: Math.min(len - 1.2, Math.max(3, len * 0.7)), kind: 'shopfront' });
        }
        if (!windows || len < 1.6) continue;
        const n = Math.max(1, Math.floor((len - 0.6) / 2.6));
        const step = len / n;
        for (let st = front && shop ? 1 : 0; st < storeys; st++) {
          for (let k = 0; k < n; k++) {
            const at = a + step * (k + 0.5);
            if (st === 0 && front && Math.abs(at - doorAt) < 1.3) continue;
            out.push({ wing: wi, side: side as 0 | 1 | 2 | 3, at: at - L.a0, w: Math.min(1.3, step - 0.7), kind: 'window', storey: st });
          }
        }
      }
    }
  });
  if (!(shop && out.some((o) => o.kind === 'shopfront' && o.wing === best.wing && o.side === best.side))) {
    out.push({ wing: best.wing, side: best.side, at: best.at, w: m.cls === 'garage' ? 2.6 : 1.0, kind: m.cls === 'garage' ? 'garage' : 'door' });
  }
  return out;
}
