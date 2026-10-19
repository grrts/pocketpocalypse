// Render street chunks or overview tiles to PNG from local data, without a browser.
// Useful for checking geographic generation on real data.
//
//   npx vite-node tools/preview.ts -- chunk <lon> <lat> [radius] [out.png]
//   npx vite-node tools/preview.ts -- overview <z> <lon> <lat> [out.png]
//
// Reads the pack and baked tiles from public/data/nl (override with DATA_DIR).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { CHUNK_TEXELS, CHUNK_ZOOM, DATA_ZOOM, TILE_PX, lonLatToWorld, tileAt, tileTexels } from '../src/core/geo';
import { ElevationGrid, decodeTerrarium, TERRARIUM_URL } from '../src/data/elevation';
import { parseOverpass } from '../src/data/overpass';
import { decodePackTile } from '../src/data/pack';
import type { PackManifest } from '../src/data/types';
import { worldLandRings } from '../src/data/worldLand';
import { NETHERLANDS } from '../src/country/nl';
import { regionStateAt, simulateOutbreak } from '../src/sim/outbreak';
import { generateChunk } from '../src/world/chunkgen';
import { renderOverview } from '../src/world/overview';

const DATA = process.env.DATA_DIR ?? 'public/data/nl';
const DETAIL = process.env.DETAIL_DIR ?? `${DATA}/detail`;
const manifest = JSON.parse(readFileSync(`${DATA}/manifest.json`, 'utf8')) as PackManifest;
const history = simulateOutbreak(Number(process.env.SEED ?? 1234), NETHERLANDS, manifest.cities);

function gz(path: string) {
  return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
}

function pack(z: number, x: number, y: number) {
  const level = [...manifest.levels].reverse().find((l) => l <= z)!;
  const d = z - level;
  const p = `${DATA}/pack/${level}/${x >> d}/${y >> d}.json.gz`;
  return existsSync(p) ? decodePackTile(gz(p)) : null;
}

async function elevation(z: number, x: number, y: number) {
  try {
    const url = TERRARIUM_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const res = await fetch(url);
    const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    return new ElevationGrid(z, x, y, decodeTerrarium(new Uint8ClampedArray(png.data)));
  } catch (e) {
    console.warn('elevation unavailable', e);
    return new ElevationGrid(z, x, y, null);
  }
}

function writePng(path: string, w: number, h: number, rgba: Uint8ClampedArray) {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  writeFileSync(path, PNG.sync.write(png));
  console.log('wrote', path);
}

async function chunks(lon: number, lat: number, radius: number, out: string) {
  const w = lonLatToWorld(lon, lat);
  const { tx: ccx, ty: ccy } = tileAt(CHUNK_ZOOM, w.x, w.y);
  const n = radius * 2 + 1;
  const img = new Uint8ClampedArray(n * CHUNK_TEXELS * n * CHUNK_TEXELS * 4);
  for (let j = -radius; j <= radius; j++) {
    for (let i = -radius; i <= radius; i++) {
      const cx = ccx + i, cy = ccy + j;
      const s = tileTexels(DATA_ZOOM);
      const tx = Math.floor((cx * CHUNK_TEXELS) / s), ty = Math.floor((cy * CHUNK_TEXELS) / s);
      const p = `${DETAIL}/15/${tx}/${ty}.json.gz`;
      const geo = existsSync(p) ? parseOverpass(gz(p), tx, ty, 'baked') : null;
      const center = { lon, lat };
      const region = regionStateAt(history, center.lon, center.lat);
      const elev = await elevation(12, cx >> 4, cy >> 4);
      const res = generateChunk({ cx, cy, seed: 1234, geo, pack: pack(CHUNK_ZOOM, cx, cy), packExtent: manifest.extent, elevation: elev, region });
      console.log(`chunk ${cx},${cy}`, res.stats, 'vehicles', res.spawns.vehicles.length, 'zombies', res.spawns.zombies.length, 'containers', res.spawns.containers.length, 'corpses', res.spawns.corpses.length);
      const W = n * CHUNK_TEXELS;
      for (let y = 0; y < CHUNK_TEXELS; y++) {
        const dst = (((j + radius) * CHUNK_TEXELS + y) * W + (i + radius) * CHUNK_TEXELS) * 4;
        img.set(res.rgba.subarray(y * CHUNK_TEXELS * 4, (y + 1) * CHUNK_TEXELS * 4), dst);
      }
    }
  }
  console.log('region', regionStateAt(history, lon, lat));
  writePng(out, n * CHUNK_TEXELS, n * CHUNK_TEXELS, img);
}

async function overview(z: number, lon: number, lat: number, out: string) {
  const w = lonLatToWorld(lon, lat);
  const { tx, ty } = tileAt(z, w.x, w.y);
  const n = 3;
  const img = new Uint8ClampedArray(n * TILE_PX * n * TILE_PX * 4);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ez = Math.min(z, 11), ed = z - ez;
      const rgba = renderOverview({
        z, x: tx + i, y: ty + j, pack: pack(z, tx + i, ty + j), packExtent: manifest.extent, worldLand: worldLandRings(),
        elevation: z >= 6 ? await elevation(ez, (tx + i) >> ed, (ty + j) >> ed) : null, daysSinceCollapse: 60,
      });
      const W = n * TILE_PX;
      for (let y = 0; y < TILE_PX; y++) img.set(rgba.subarray(y * TILE_PX * 4, (y + 1) * TILE_PX * 4), (((j + 1) * TILE_PX + y) * W + (i + 1) * TILE_PX) * 4);
    }
  }
  writePng(out, n * TILE_PX, n * TILE_PX, img);
}

const args = process.argv.slice(2).filter((a) => a !== '--');
if (args[0] === 'chunk') await chunks(Number(args[1]), Number(args[2]), Number(args[3] ?? 1), args[4] ?? 'chunk.png');
else if (args[0] === 'overview') await overview(Number(args[1]), Number(args[2]), Number(args[3]), args[4] ?? 'overview.png');
else console.log('usage: chunk <lon> <lat> [radius] [out] | overview <z> <lon> <lat> [out]');
