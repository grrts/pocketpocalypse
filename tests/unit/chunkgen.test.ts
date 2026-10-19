import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseOverpass } from '../../src/data/overpass';
import { decodePackTile } from '../../src/data/pack';
import { simulateOutbreak, regionStateAt } from '../../src/sim/outbreak';
import { NETHERLANDS } from '../../src/country/nl';
import { generateChunk } from '../../src/world/chunkgen';
import { openInterior, openTexels, reachable } from '../../src/world/interior';
import { C, M } from '../../src/render/materials';
import { CHUNK_TEXELS, lonLatToWorld } from '../../src/core/geo';

const D = 'public/data/nl';
const gz = (p: string) => JSON.parse(gunzipSync(readFileSync(p)).toString());
const cities = JSON.parse(readFileSync(`${D}/manifest.json`, 'utf8')).cities;
const history = simulateOutbreak(1, NETHERLANDS, cities);
const geo = parseOverpass(gz(`${D}/detail/15/16850/10810.json.gz`), 16850, 10810, 'baked');
const pack = decodePackTile(gz(`${D}/pack/10/526/337.json.gz`));
const dom = lonLatToWorld(5.1214, 52.0907);
const cx = Math.floor(dom.x / CHUNK_TEXELS), cy = Math.floor(dom.y / CHUNK_TEXELS);
const gen = (seed: number) =>
  generateChunk({ cx, cy, seed, geo, pack, packExtent: 4096, elevation: null, region: regionStateAt(history, 5.1214, 52.0907) });

describe('generateChunk (Utrecht centre)', () => {
  const a = gen(1);

  it('draws real buildings and roads', () => {
    expect(a.stats.buildings).toBeGreaterThan(100);
    expect(a.stats.roads).toBeGreaterThan(20);
    const solid = a.collision.reduce((n, v) => n + (v === C.SOLID ? 1 : 0), 0) / a.collision.length;
    const walk = a.collision.reduce((n, v) => n + (v === C.WALK ? 1 : 0), 0) / a.collision.length;
    // walls are solid, floors inside buildings are walkable
    expect(solid).toBeGreaterThan(0.05);
    expect(walk).toBeGreaterThan(0.3);
  });

  it('gives almost every building an inside with a way in', () => {
    expect(a.interiors.length).toBeGreaterThan(0.9 * a.stats.buildings);
    const b = a.interiors.find((i) => i.w > 20 && i.h > 20)!;
    expect(openInterior(b)).toBe(true);
    const ids = b.ids!;
    const floor = ids.filter((v) => v === M.FLOOR_WOOD || v === M.FLOOR_TILE || v === M.FLOOR_CARPET || v === M.FLOOR_CONCRETE || v === M.FLOOR_STONE).length;
    const wall = ids.filter((v) => v === M.INNER_WALL || v === M.OUTER_WALL).length;
    expect(floor).toBeGreaterThan(wall);
    expect(wall).toBeGreaterThan(0);
    expect(b.plan!.doors.some((d) => d.front)).toBe(true);
  });

  it('lets you reach every room from the front door', () => {
    // flood fill from just inside the front door over texels a body fits through
    let rooms = 0, reached = 0, furnished = 0;
    const unreached: string[] = [];
    for (const b of a.interiors) {
      openInterior(b);
      const ids = b.ids!, plan = b.plan!;
      const front = plan.doors.find((d) => d.front)!;
      const fx = b.door.x - b.x0, fy = b.door.y - b.y0;
      let start = -1;
      for (let k = 0.5; k < 12 && start < 0; k += 0.5) {
        const i = Math.floor(fy - b.door.ny * k) * b.w + Math.floor(fx - b.door.nx * k);
        if (openTexels(ids, b.w, b.h)[i]) start = i;
      }
      expect(start, `${b.id} has no way in at its front door`).toBeGreaterThanOrEqual(0);
      void front;
      const open = openTexels(ids, b.w, b.h);
      // side doors cut where a wing could not be reached from inside count as ways in too
      const starts = [start];
      for (let i = b.w; i < ids.length - b.w; i++) {
        if (ids[i] === M.DOORWAY && (ids[i - 1] === 0 || ids[i + 1] === 0 || ids[i - b.w] === 0 || ids[i + b.w] === 0)) {
          for (const j of [i - 1, i + 1, i - b.w, i + b.w, i - 2, i + 2, i - 2 * b.w, i + 2 * b.w]) if (open[j]) starts.push(j);
        }
      }
      const seen = reachable(ids, b.w, b.h, starts);
      if (plan.items.some((it) => it.solid)) furnished++;
      // unreached places big enough to stand in (12+ connected open texels, ~1.6 m²)
      const lost = new Uint8Array(ids.length);
      const mark = new Uint8Array(ids.length);
      for (let i = 0; i < ids.length; i++) {
        if (!open[i] || seen[i] || mark[i]) continue;
        const comp = [i];
        mark[i] = 1;
        for (let k = 0; k < comp.length; k++) {
          const c = comp[k];
          for (const j of [c - 1, c + 1, c - b.w, c + b.w]) if (open[j] && !seen[j] && !mark[j]) { mark[j] = 1; comp.push(j); }
        }
        if (comp.length >= 12) for (const c of comp) lost[c] = 1;
      }
      for (const r of plan.rooms) {
        let n = 0, gone = 0;
        const p = r.poly;
        const x0 = Math.max(0, Math.floor(Math.min(p[0], p[2], p[4], p[6]))), x1 = Math.min(b.w - 1, Math.ceil(Math.max(p[0], p[2], p[4], p[6])));
        const y0 = Math.max(0, Math.floor(Math.min(p[1], p[3], p[5], p[7]))), y1 = Math.min(b.h - 1, Math.ceil(Math.max(p[1], p[3], p[5], p[7])));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            if (!inQuad(p, x + 0.5, y + 0.5)) continue;
            const i = y * b.w + x;
            if (!open[i]) continue;
            n++;
            if (lost[i]) gone++;
          }
        }
        // rooms clipped away by an odd footprint (no space to stand) do not count
        if (n < 12) continue;
        rooms++;
        if (gone === 0) reached++;
        else unreached.push(`${b.id} ${r.kind} ${gone}/${n}`);
      }
    }
    expect(rooms).toBeGreaterThan(500);
    expect(unreached).toEqual([]);
    expect(reached).toBe(rooms);
    expect(furnished).toBeGreaterThan(0.8 * a.interiors.length);
  });

  it('populates the apocalypse', () => {
    expect(a.spawns.containers.length).toBeGreaterThan(20);
    expect(a.spawns.vehicles.length).toBeGreaterThan(3);
    expect(a.spawns.zombies.length).toBeGreaterThan(3);
    const ids = [...a.spawns.containers, ...a.spawns.vehicles, ...a.spawns.corpses, ...a.spawns.zombies].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is deterministic, so unsaved places regenerate identically', () => {
    const b = gen(1);
    expect(b.spawns).toEqual(a.spawns);
    expect(Buffer.from(b.rgba).equals(Buffer.from(a.rgba))).toBe(true);
    expect(gen(2).spawns).not.toEqual(a.spawns);
  });

  it('paints a textured ground, not flat map colours', () => {
    // count distinct colours on a strip of street-level ground
    const seen = new Set<number>();
    for (let i = 0; i < CHUNK_TEXELS * 64; i++) seen.add((a.rgba[i * 4] << 16) | (a.rgba[i * 4 + 1] << 8) | a.rgba[i * 4 + 2]);
    expect(seen.size).toBeGreaterThan(500);
    // every pixel is opaque
    for (let i = 3; i < a.rgba.length; i += 4 * 997) expect(a.rgba[i]).toBe(255);
  });

  it('renders the same chunk at 2 art pixels per texel near the player', () => {
    const hi = generateChunk({ cx, cy, seed: 1, geo, pack, packExtent: 4096, elevation: null, region: regionStateAt(history, 5.1214, 52.0907), scale: 2 });
    expect(hi.rgba.length).toBe(a.rgba.length * 4);
    expect(hi.spawns).toEqual(a.spawns);
    expect(Buffer.from(hi.collision).equals(Buffer.from(a.collision))).toBe(true);
    for (let i = 3; i < hi.rgba.length; i += 4 * 1009) expect(hi.rgba[i]).toBe(255);
  });
});

function inQuad(p: number[], x: number, y: number): boolean {
  let sign = 0;
  for (let k = 0; k < 8; k += 2) {
    const ax = p[k], ay = p[k + 1], bx = p[(k + 2) & 7], by = p[(k + 3) & 7];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c === 0) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}
