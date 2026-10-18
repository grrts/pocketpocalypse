/// <reference lib="webworker" />
// Map worker: fetches data and does all rasterization off the main thread.

import { CHUNK_TEXELS, CHUNK_ZOOM, DATA_ZOOM, TILE_PX, tileTexels, worldToLonLat } from '../core/geo';
import { DetailChain } from '../data/detailChain';
import { ElevationSource } from '../data/elevation';
import { OverpassSource, StaticOverpassSource } from '../data/overpass';
import { PackSource } from '../data/pack';
import type { DetailSource } from '../data/types';
import { worldLandRings } from '../data/worldLand';
import { IndexedDbKV } from '../persist/kv';
import { regionStateAt, type OutbreakHistory } from '../sim/outbreak';
import { generateChunk } from '../world/chunkgen';
import { renderOverview } from '../world/overview';
import type { InitMsg, WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let ready: Promise<void> | null = null;
let pack: PackSource;
let detail: DetailChain;
let elevation: ElevationSource;
let history: OutbreakHistory;
let seed = 0;

async function init(msg: InitMsg) {
  history = msg.history;
  seed = msg.seed;
  pack = await PackSource.load(msg.packUrl);
  elevation = new ElevationSource(msg.elevationUrl);
  const sources: DetailSource[] = [];
  if (msg.bakedDetailUrl) {
    const baked = new StaticOverpassSource(msg.bakedDetailUrl);
    await baked.init();
    sources.push(baked);
  }
  if (msg.useOverpass) sources.push(new OverpassSource(msg.overpassEndpoints));
  let kv: IndexedDbKV | null = null;
  try {
    kv = new IndexedDbKV();
  } catch {
    kv = null;
  }
  detail = new DetailChain(sources, kv);
}

async function packTileFor(z: number, x: number, y: number) {
  const level = pack.levelFor(z);
  if (level === null) return null;
  const d = z - level;
  return pack.get(level, x >> d, y >> d);
}

async function chunk(id: number, cx: number, cy: number) {
  const s = tileTexels(DATA_ZOOM);
  const tx = Math.floor((cx * CHUNK_TEXELS) / s), ty = Math.floor((cy * CHUNK_TEXELS) / s);
  const center = worldToLonLat((cx + 0.5) * CHUNK_TEXELS, (cy + 0.5) * CHUNK_TEXELS);
  const ez = 12, ed = CHUNK_ZOOM - ez;
  const [geo, packTile, elev] = await Promise.all([
    detail.get(tx, ty).catch((e) => {
      console.warn('detail data failed', tx, ty, e);
      return null;
    }),
    packTileFor(CHUNK_ZOOM, cx, cy),
    elevation.get(ez, cx >> ed, cy >> ed),
  ]);
  const region = regionStateAt(history, center.lon, center.lat);
  const out = generateChunk({ cx, cy, seed, geo, pack: packTile, packExtent: pack.manifest.extent, elevation: elev, region });
  const bitmap = await createImageBitmap(new ImageData(out.rgba as Uint8ClampedArray<ArrayBuffer>, CHUNK_TEXELS, CHUNK_TEXELS));
  const msg: WorkerResponse = { type: 'chunk', id, bitmap, collision: out.collision.buffer as ArrayBuffer, spawns: out.spawns, stats: out.stats };
  self.postMessage(msg, [bitmap, out.collision.buffer as ArrayBuffer]);
}

async function overview(id: number, z: number, x: number, y: number) {
  const packTile = await packTileFor(z, x, y);
  const ez = Math.min(z, 11), ed = z - ez;
  const elev = z >= 6 ? await elevation.get(ez, x >> ed, y >> ed) : null;
  const c = worldToLonLat((x + 0.5) * tileTexels(z), (y + 0.5) * tileTexels(z));
  const days = z >= 9 ? regionStateAt(history, c.lon, c.lat).daysSinceCollapse : 0;
  const rgba = renderOverview({ z, x, y, pack: packTile, packExtent: pack.manifest.extent, worldLand: worldLandRings(), elevation: elev, daysSinceCollapse: days });
  const bitmap = await createImageBitmap(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, TILE_PX, TILE_PX));
  const msg: WorkerResponse = { type: 'overview', id, bitmap };
  self.postMessage(msg, [bitmap]);
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const m = ev.data;
  if (m.type === 'init') {
    ready = init(m);
    return;
  }
  try {
    await ready;
    if (m.type === 'chunk') await chunk(m.id, m.cx, m.cy);
    else if (m.type === 'overview') await overview(m.id, m.z, m.x, m.y);
  } catch (e) {
    const msg: WorkerResponse = { type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) };
    self.postMessage(msg);
  }
};
