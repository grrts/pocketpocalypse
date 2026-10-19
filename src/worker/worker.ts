/// <reference lib="webworker" />
// Map worker: fetches data and does all rasterization off the main thread.

import { CHUNK_TEXELS, CHUNK_ZOOM, DATA_ZOOM, TILE_PX, tileTexels, worldToLonLat } from '../core/geo';
import { DetailChain } from '../data/detailChain';
import { ElevationSource } from '../data/elevation';
import { OverpassSource, StaticOverpassSource } from '../data/overpass';
import { BundleSource, mergeNeighbours, type Resolve } from '../data/bundle';
import { decodePackTile } from '../data/pack';
import type { GeoData, PackTile } from '../data/types';
import { PackSource } from '../data/pack';
import type { DetailSource } from '../data/types';
import { worldLandRings } from '../data/worldLand';
import { IndexedDbKV } from '../persist/kv';
import { regionStateAt, type OutbreakHistory } from '../sim/outbreak';
import { generateChunk } from '../world/chunkgen';
import { renderOverview } from '../world/overview';
import type { InitMsg, WorkerRequest, WorkerResponse } from './protocol';
import { handleFetchResult, installFetchProxy } from './fetchProxy';

declare const self: DedicatedWorkerGlobalScope;

installFetchProxy(self);

let ready: Promise<void> | null = null;
let pack: PackSource;
let detail: DetailChain;
let elevation: ElevationSource;
let bundles: BundleSource | null = null;

/** Country data paths go through assets.json when the host keeps big files elsewhere (an artifact's asset store). */
async function makeResolver(base: string): Promise<Resolve> {
  let map: Record<string, string> = {};
  try {
    const r = await fetch(`${base}/assets.json`);
    if (r.ok) map = await r.json();
  } catch {
    // no asset map: everything sits next to the manifest
  }
  return (p) => map[p] ?? `${base}/${p}`;
}

/** Bundles carry the z10 overview pack tile; fall back to the separate pack files. */
async function packTile(z: number, x: number, y: number): Promise<PackTile | null> {
  if (z === 10 && bundles?.hasBundle(x, y)) {
    try {
      const b = await bundles.bundle(x, y);
      if (b.pack) return decodePackTile(b.pack as Parameters<typeof decodePackTile>[0]);
    } catch {
      // fall through
    }
  }
  return pack.get(z, x, y);
}

/** Street data for a chunk: its own z15 tile plus what neighbouring tiles own near the chunk. */
async function chunkGeo(cx: number, cy: number, tx: number, ty: number): Promise<GeoData | null> {
  const base = await detail.get(tx, ty);
  if (!base || base.source !== 'bundle') return base;
  const s = tileTexels(DATA_ZOOM);
  const lx0 = cx * CHUNK_TEXELS - tx * s, ly0 = cy * CHUNK_TEXELS - ty * s;
  const pad = 160;
  const nx = lx0 === 0 ? -1 : 1, ny = ly0 === 0 ? -1 : 1;
  const others = await Promise.all(
    [[nx, 0], [0, ny], [nx, ny]].map(([dx, dy]) => detail.get(tx + dx, ty + dy).catch(() => null)),
  );
  return mergeNeighbours(base, others.filter((g): g is GeoData => !!g), lx0 - pad, ly0 - pad, lx0 + CHUNK_TEXELS + pad, ly0 + CHUNK_TEXELS + pad);
}
let history: OutbreakHistory;
let seed = 0;

async function init(msg: InitMsg) {
  history = msg.history;
  seed = msg.seed;
  pack = await PackSource.load(msg.packUrl);
  elevation = new ElevationSource(msg.elevationUrl);
  const resolve = await makeResolver(msg.packUrl);
  const sources: DetailSource[] = [];
  bundles = null;
  if (msg.bundleUrl) {
    bundles = new BundleSource(resolve);
    await bundles.init();
    sources.push(bundles);
  }
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
  return packTile(level, x >> d, y >> d);
}

async function chunk(id: number, cx: number, cy: number) {
  const s = tileTexels(DATA_ZOOM);
  const tx = Math.floor((cx * CHUNK_TEXELS) / s), ty = Math.floor((cy * CHUNK_TEXELS) / s);
  const center = worldToLonLat((cx + 0.5) * CHUNK_TEXELS, (cy + 0.5) * CHUNK_TEXELS);
  const ez = 12, ed = CHUNK_ZOOM - ez;
  let dataError: string | undefined;
  const [geo, packTile, elev] = await Promise.all([
    chunkGeo(cx, cy, tx, ty).catch((e) => {
      console.warn('detail data failed', tx, ty, e);
      dataError = e instanceof Error ? e.message : String(e);
      return null;
    }),
    packTileFor(CHUNK_ZOOM, cx, cy),
    elevation.get(ez, cx >> ed, cy >> ed),
  ]);
  const region = regionStateAt(history, center.lon, center.lat);
  const out = generateChunk({ cx, cy, seed, geo, pack: packTile, packExtent: pack.manifest.extent, elevation: elev, region });
  if (dataError) out.stats.dataError = dataError;
  const bitmap = await createImageBitmap(new ImageData(out.rgba as Uint8ClampedArray<ArrayBuffer>, CHUNK_TEXELS, CHUNK_TEXELS));
  const msg: WorkerResponse = { type: 'chunk', id, bitmap, collision: out.collision.buffer as ArrayBuffer, spawns: out.spawns, interiors: out.interiors, stats: out.stats };
  self.postMessage(msg, [bitmap, out.collision.buffer as ArrayBuffer]);
}

/** Baked data tiles under an overview tile, plus a margin for features owned by neighbours. */
async function overviewDetail(z: number, x: number, y: number): Promise<GeoData[] | undefined> {
  const b = bundles;
  if (!b) return undefined;
  const s = tileTexels(DATA_ZOOM), size = tileTexels(z), pad = 256;
  const x0 = Math.floor((x * size - pad) / s), x1 = Math.floor(((x + 1) * size + pad) / s);
  const y0 = Math.floor((y * size - pad) / s), y1 = Math.floor(((y + 1) * size + pad) / s);
  const jobs: Promise<GeoData | null>[] = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (b.covers(tx, ty)) jobs.push(b.fetchTile(tx, ty).catch(() => null));
  const out = (await Promise.all(jobs)).filter((g): g is GeoData => !!g);
  return out.length ? out : undefined;
}

async function overview(id: number, z: number, x: number, y: number) {
  const packTile = await packTileFor(z, x, y);
  const ez = Math.min(z, 11), ed = z - ez;
  const elev = z >= 6 ? await elevation.get(ez, x >> ed, y >> ed) : null;
  const c = worldToLonLat((x + 0.5) * tileTexels(z), (y + 0.5) * tileTexels(z));
  const days = z >= 9 ? regionStateAt(history, c.lon, c.lat).daysSinceCollapse : 0;
  const detail = z >= 13 ? await overviewDetail(z, x, y) : undefined;
  const rgba = renderOverview({ z, x, y, pack: packTile, packExtent: pack.manifest.extent, worldLand: worldLandRings(), elevation: elev, daysSinceCollapse: days, detail });
  const bitmap = await createImageBitmap(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, TILE_PX, TILE_PX));
  const msg: WorkerResponse = { type: 'overview', id, bitmap };
  self.postMessage(msg, [bitmap]);
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const m = ev.data;
  if (handleFetchResult(m)) return;
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
