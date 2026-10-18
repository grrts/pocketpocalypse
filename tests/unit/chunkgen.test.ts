import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseOverpass } from '../../src/data/overpass';
import { decodePackTile } from '../../src/data/pack';
import { simulateOutbreak, regionStateAt } from '../../src/sim/outbreak';
import { NETHERLANDS } from '../../src/country/nl';
import { generateChunk } from '../../src/world/chunkgen';
import { C } from '../../src/render/materials';
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
    expect(solid).toBeGreaterThan(0.15);
    expect(walk).toBeGreaterThan(0.15);
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
});
