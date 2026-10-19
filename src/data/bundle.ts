// Street-level data baked for a whole country by tools/geobake/bake_bundles.py:
// one bundle per z10 tile holding every z15 data tile inside it, plus the
// overview pack tile. Features keep OpenStreetMap-style tags, so they go
// through the same classification as live Overpass data. Bundles are stored as
// the pixels of greyscale PNGs; see the bake script for the byte layout.

import { DATA_ZOOM, tileOrigin } from '../core/geo';
import { classifyArea, classifyLine, isAreaWay, poiClass, type Tags } from './osm';
import { decodePng } from './png';
import type { DetailSource, GeoArea, GeoData, GeoLine, GeoPoi } from './types';

const BUNDLE_ZOOM = 10;
const SHIFT = DATA_ZOOM - BUNDLE_ZOOM;

interface BundleIndex {
  v: number;
  ext?: string;
  bundles: [number, number][];
  attribution?: string;
}

interface BundleHeader {
  v: number;
  q: number;
  tags: string[];
  names: string[];
  tiles: [number, number, number, number][];
  pack: unknown;
}

export interface LoadedBundle {
  bytes: Uint8Array;
  base: number;
  q: number;
  tags: (Tags | null)[];
  tagStrings: string[];
  names: string[];
  tiles: Map<string, [number, number]>;
  pack: unknown;
}

/** Maps a data path (relative to the country folder) to the URL that serves it. */
export type Resolve = (path: string) => string;

/** Bundle bytes from the greyscale PNG they are stored in. */
export async function unwrapPng(blob: Blob): Promise<Uint8Array> {
  return (await decodePng(new Uint8Array(await blob.arrayBuffer()))).data;
}

export function readBundle(buf: Uint8Array): LoadedBundle {
  if (buf[0] !== 0x50 || buf[1] !== 0x50 || buf[2] !== 0x47 || buf[3] !== 0x32) throw new Error('not a map bundle');
  const hl = (buf[4] | (buf[5] << 8) | (buf[6] << 16)) + buf[7] * 2 ** 24;
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + hl))) as BundleHeader;
  const tiles = new Map<string, [number, number]>();
  for (const [x, y, off, len] of header.tiles) tiles.set(`${x},${y}`, [off, len]);
  return {
    bytes: buf, base: 8 + hl, q: header.q, tags: new Array(header.tags.length).fill(null), tagStrings: header.tags,
    names: header.names, tiles, pack: header.pack,
  };
}

function tagsOf(b: LoadedBundle, i: number): Tags {
  let t = b.tags[i];
  if (!t) {
    t = {};
    for (const kv of b.tagStrings[i].split('\x1f')) {
      const eq = kv.indexOf('=');
      if (eq > 0) t[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    b.tags[i] = t;
  }
  return t;
}

function levelsOf(tags: Tags): number | undefined {
  const l = parseFloat(tags['building:levels'] ?? '');
  if (isFinite(l) && l > 0) return Math.min(60, l);
  const h = parseFloat(tags.height ?? '');
  if (isFinite(h) && h > 0) return Math.max(1, Math.round(h / 3));
  return undefined;
}

/** Decode one z15 tile blob into GeoData. */
export function decodeTile(b: LoadedBundle, tx: number, ty: number, source: string): GeoData {
  const entry = b.tiles.get(`${tx},${ty}`);
  if (!entry) return { z: DATA_ZOOM, x: tx, y: ty, origin: tileOrigin(DATA_ZOOM, tx, ty), areas: [], lines: [], pois: [], source };
  const raw = b.bytes.subarray(b.base + entry[0], b.base + entry[0] + entry[1]);
  const q = b.q;
  let p = 0;
  let fx = 0, fy = 0; // first point of the previous ring/line
  const uv = (): number => {
    let v = 0, s = 0, c: number;
    do {
      c = raw[p++];
      v += (c & 0x7f) * 2 ** s;
      s += 7;
    } while (c & 0x80);
    return v;
  };
  const sv = (): number => {
    const v = uv();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  const coords = (): number[] => {
    const n = uv();
    const out = new Array<number>(n * 2);
    let x = fx, y = fy;
    for (let i = 0; i < n; i++) {
      x += sv();
      y += sv();
      if (i === 0) { fx = x; fy = y; }
      out[i * 2] = x * q;
      out[i * 2 + 1] = y * q;
    }
    return out;
  };
  const areas: GeoArea[] = [];
  const lines: GeoLine[] = [];
  const pois: GeoPoi[] = [];
  const count = uv();
  for (let i = 0; i < count; i++) {
    const type = raw[p++];
    const tags = tagsOf(b, uv());
    const ni = uv();
    const name = ni ? b.names[ni - 1] : undefined;
    const id = `g${tx}_${ty}_${i}`;
    if (type === 0) {
      const nr = uv();
      const rings: number[][] = [];
      for (let r = 0; r < nr; r++) {
        const ring = coords();
        // close the ring like OSM ways are closed
        if (ring.length >= 6) ring.push(ring[0], ring[1]);
        rings.push(ring);
      }
      if (!rings.length || !isAreaWay(tags, true)) continue;
      const ac = classifyArea(tags);
      if (ac) areas.push({ id, kind: ac.kind, cls: ac.cls, rings, levels: levelsOf(tags), name });
    } else if (type === 1) {
      const pts = coords();
      if (pts.length < 4) continue;
      const lc = classifyLine(tags);
      if (lc) lines.push({ id, kind: lc.kind, cls: lc.cls, pts, width: lc.width, bridge: tags.bridge === 'yes' || undefined, name });
    } else {
      const pt = coords();
      const cls = poiClass(tags);
      if (cls && pt.length === 2) pois.push({ id, cls, x: pt[0], y: pt[1], name });
    }
  }
  return { z: DATA_ZOOM, x: tx, y: ty, origin: tileOrigin(DATA_ZOOM, tx, ty), areas, lines, pois, source };
}

/** Detail source backed by the country's baked bundles. */
export class BundleSource implements DetailSource {
  readonly name = 'bundle';
  private have = new Set<string>();
  private ext = '.png';
  private ready: Promise<void>;
  private bundles = new Map<string, Promise<LoadedBundle>>();
  private decoded = new Map<string, Promise<GeoData>>();

  constructor(private resolve: Resolve, private dir = 'geo') {
    this.ready = fetch(resolve(`${dir}/index.json`))
      .then((r) => (r.ok ? (r.json() as Promise<BundleIndex>) : ({ v: 2, bundles: [] } as BundleIndex)))
      .then((j) => {
        if (j.ext) this.ext = j.ext;
        for (const [x, y] of j.bundles) this.have.add(`${x},${y}`);
      })
      .catch(() => undefined);
  }

  init(): Promise<void> {
    return this.ready;
  }

  covers(tx: number, ty: number): boolean {
    return this.hasBundle(tx >> SHIFT, ty >> SHIFT);
  }

  hasBundle(bx: number, by: number): boolean {
    return this.have.has(`${bx},${by}`);
  }

  bundle(bx: number, by: number): Promise<LoadedBundle> {
    const key = `${bx},${by}`;
    let p = this.bundles.get(key);
    if (!p) {
      p = fetch(this.resolve(`${this.dir}/${BUNDLE_ZOOM}/${bx}/${by}${this.ext}`))
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return readBundle(await unwrapPng(await r.blob()));
        })
        .catch((e) => {
          this.bundles.delete(key);
          throw e;
        });
      this.bundles.set(key, p);
      // a bundle is several MB unpacked; keep the few around the player
      if (this.bundles.size > 2) this.bundles.delete(this.bundles.keys().next().value!);
    }
    return p;
  }

  fetchTile(tx: number, ty: number): Promise<GeoData> {
    const key = `${tx},${ty}`;
    let p = this.decoded.get(key);
    if (!p) {
      p = this.bundle(tx >> SHIFT, ty >> SHIFT).then((b) => decodeTile(b, tx, ty, this.name));
      p.catch(() => this.decoded.delete(key));
      this.decoded.set(key, p);
      // chunks and overview tiles around the player reuse the same few dozen tiles
      if (this.decoded.size > 64) this.decoded.delete(this.decoded.keys().next().value!);
    }
    return p;
  }
}

/**
 * Features of neighbouring tiles that reach into a chunk. Bundles store each
 * feature once, so a chunk next to a tile edge also draws what its neighbours
 * own. Coordinates are moved into the base tile's frame.
 */
export function mergeNeighbours(base: GeoData, neighbours: GeoData[], x0: number, y0: number, x1: number, y1: number): GeoData {
  const areas = base.areas.slice(), lines = base.lines.slice(), pois = base.pois.slice();
  const hit = (pts: ArrayLike<number>, dx: number, dy: number) => {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] + dx, y = pts[i + 1] + dy;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
    return bx1 >= x0 && bx0 <= x1 && by1 >= y0 && by0 <= y1;
  };
  const shift = (pts: number[], dx: number, dy: number) => pts.map((v, i) => v + (i % 2 ? dy : dx));
  for (const n of neighbours) {
    const dx = n.origin.x - base.origin.x, dy = n.origin.y - base.origin.y;
    for (const a of n.areas) if (hit(a.rings[0], dx, dy)) areas.push({ ...a, rings: a.rings.map((r) => shift(r, dx, dy)) });
    for (const l of n.lines) if (hit(l.pts, dx, dy)) lines.push({ ...l, pts: shift(l.pts, dx, dy) });
    for (const p of n.pois) if (p.x + dx >= x0 && p.x + dx <= x1 && p.y + dy >= y0 && p.y + dy <= y1) pois.push({ ...p, x: p.x + dx, y: p.y + dy });
  }
  return { ...base, areas, lines, pois };
}
