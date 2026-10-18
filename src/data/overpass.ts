// Street-level data straight from OpenStreetMap via the Overpass API. Works for
// any country; the response is normalized into GeoData (see types.ts).

import { DATA_ZOOM, lonLatToWorld, tileLonLatBounds, tileOrigin } from '../core/geo';
import { classifyArea, classifyLine, isAreaWay, poiClass, type Tags } from './osm';
import { fetchMaybeGzipJson } from './fetchJson';
import type { DetailSource, GeoArea, GeoData, GeoLine, GeoPoi } from './types';

export const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

type LatLon = { lat: number; lon: number } | null;

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Tags;
  lat?: number;
  lon?: number;
  geometry?: LatLon[];
  members?: { type: string; ref: number; role: string; geometry?: LatLon[] }[];
}

export interface OverpassResponse {
  elements: OverpassElement[];
}

/** Overpass QL for everything the game draws in one z15 tile. Huge relations
 * (lakes, big forests) are skipped here: the overview pack already covers them. */
export function buildOverpassQuery(tx: number, ty: number): string {
  const b = tileLonLatBounds(DATA_ZOOM, tx, ty);
  const f = (v: number) => v.toFixed(6);
  const bbox = `${f(b.s)},${f(b.w)},${f(b.n)},${f(b.e)}`;
  const small = '(if:count_members()<400)';
  return `[out:json][timeout:90][maxsize:536870912][bbox:${bbox}];
(
  way[building];
  rel[building]${small};
  way[highway];
  way[railway~"^(rail|light_rail|tram|narrow_gauge|subway)$"];
  way[waterway~"^(river|canal|stream|ditch|drain|riverbank)$"];
  way[natural~"^(water|wood|scrub|heath|grassland|wetland|sand|beach|dune|bare_rock|shingle)$"];
  rel[natural~"^(water|wood|scrub|heath|grassland|wetland|sand|beach)$"]${small};
  way[landuse];
  rel[landuse]${small};
  way[leisure~"^(park|garden|playground|pitch|golf_course|sports_centre|stadium|track|dog_park|common)$"];
  rel[leisure~"^(park|garden|golf_course|pitch|sports_centre|stadium)$"]${small};
  way[amenity~"^(parking|school|university|college|hospital|grave_yard|kindergarten)$"];
  way[aeroway~"^(apron|runway|taxiway)$"];
  node[shop];
  node[amenity~"^(pharmacy|hospital|clinic|doctors|dentist|police|fire_station|fuel|restaurant|cafe|fast_food|bar|pub|school)$"];
);
out geom qt;`;
}

function toLocal(geom: LatLon[] | undefined, ox: number, oy: number): number[] {
  const out: number[] = [];
  if (!geom) return out;
  for (const p of geom) {
    if (!p) continue;
    const w = lonLatToWorld(p.lon, p.lat);
    const x = Math.round((w.x - ox) * 4) / 4;
    const y = Math.round((w.y - oy) * 4) / 4;
    const n = out.length;
    if (n >= 2 && out[n - 2] === x && out[n - 1] === y) continue;
    out.push(x, y);
  }
  return out;
}

function isClosed(pts: number[]): boolean {
  const n = pts.length;
  return n >= 8 && pts[0] === pts[n - 2] && pts[1] === pts[n - 1];
}

/** Join member ways of a multipolygon into closed rings. */
export function assembleRings(parts: number[][]): number[][] {
  const rings: number[][] = [];
  const open: number[][] = [];
  for (const p of parts) {
    if (p.length < 4) continue;
    if (isClosed(p)) rings.push(p);
    else open.push(p.slice());
  }
  const same = (a: number[], ai: number, b: number[], bi: number) => a[ai] === b[bi] && a[ai + 1] === b[bi + 1];
  const reversed = (p: number[]) => {
    const r: number[] = [];
    for (let i = p.length - 2; i >= 0; i -= 2) r.push(p[i], p[i + 1]);
    return r;
  };
  while (open.length) {
    let cur = open.pop()!;
    let progress = true;
    while (!isClosed(cur) && progress) {
      progress = false;
      const end = cur.length - 2;
      for (let i = 0; i < open.length; i++) {
        const o = open[i];
        const oEnd = o.length - 2;
        if (same(cur, end, o, 0)) cur = cur.concat(o.slice(2));
        else if (same(cur, end, o, oEnd)) cur = cur.concat(reversed(o).slice(2));
        else if (same(cur, 0, o, oEnd)) cur = o.concat(cur.slice(2));
        else if (same(cur, 0, o, 0)) cur = reversed(o).concat(cur.slice(2));
        else continue;
        open.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (cur.length >= 6) {
      if (!isClosed(cur)) cur.push(cur[0], cur[1]);
      rings.push(cur);
    }
  }
  return rings;
}

function levelsOf(tags: Tags): number | undefined {
  const l = parseFloat(tags['building:levels'] ?? '');
  if (isFinite(l) && l > 0) return Math.min(60, l);
  const h = parseFloat(tags.height ?? '');
  if (isFinite(h) && h > 0) return Math.max(1, Math.round(h / 3));
  return undefined;
}

export function parseOverpass(resp: OverpassResponse, tx: number, ty: number, source: string): GeoData {
  const origin = tileOrigin(DATA_ZOOM, tx, ty);
  const areas: GeoArea[] = [];
  const lines: GeoLine[] = [];
  const pois: GeoPoi[] = [];
  const seen = new Set<string>();
  for (const el of resp.elements ?? []) {
    const tags = el.tags ?? {};
    const id = `${el.type[0]}${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (el.type === 'node') {
      if (el.lat === undefined || el.lon === undefined) continue;
      const cls = poiClass(tags);
      if (!cls) continue;
      const w = lonLatToWorld(el.lon, el.lat);
      pois.push({ id, cls, x: w.x - origin.x, y: w.y - origin.y, name: tags.name });
    } else if (el.type === 'way') {
      const pts = toLocal(el.geometry, origin.x, origin.y);
      if (pts.length < 4) continue;
      const closed = isClosed(pts);
      if (isAreaWay(tags, closed)) {
        const ac = classifyArea(tags)!;
        areas.push({ id, kind: ac.kind, cls: ac.cls, rings: [pts], levels: levelsOf(tags), name: tags.name });
      } else {
        const lc = classifyLine(tags);
        if (lc) lines.push({ id, kind: lc.kind, cls: lc.cls, pts, width: lc.width, bridge: tags.bridge === 'yes' || undefined, name: tags.name });
      }
    } else if (el.type === 'relation') {
      if (tags.type !== 'multipolygon' && tags.type !== 'building') continue;
      const ac = classifyArea(tags);
      if (!ac) continue;
      const outers: number[][] = [];
      const inners: number[][] = [];
      for (const m of el.members ?? []) {
        if (m.type !== 'way' || !m.geometry) continue;
        const pts = toLocal(m.geometry, origin.x, origin.y);
        (m.role === 'inner' ? inners : outers).push(pts);
      }
      const rings = [...assembleRings(outers), ...assembleRings(inners)];
      if (rings.length) areas.push({ id, kind: ac.kind, cls: ac.cls, rings, levels: levelsOf(tags), name: tags.name });
    }
  }
  return { z: DATA_ZOOM, x: tx, y: ty, origin, areas, lines, pois, source };
}

export class OverpassSource implements DetailSource {
  readonly name = 'overpass';
  private next = 0;
  constructor(private endpoints: string[] = DEFAULT_OVERPASS_ENDPOINTS) {}

  covers(): boolean {
    return true;
  }

  async fetchTile(tx: number, ty: number, signal?: AbortSignal): Promise<GeoData> {
    const body = 'data=' + encodeURIComponent(buildOverpassQuery(tx, ty));
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.endpoints.length * 2; attempt++) {
      const url = this.endpoints[(this.next + attempt) % this.endpoints.length];
      try {
        const res = await fetch(url, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal,
        });
        if (res.status === 429 || res.status === 504 || res.status >= 500) {
          lastErr = new Error(`Overpass ${res.status}`);
          await sleep(1000 * (attempt + 1), signal);
          continue;
        }
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
        const json = (await res.json()) as OverpassResponse;
        this.next = (this.next + attempt) % this.endpoints.length;
        return parseOverpass(json, tx, ty, 'osm');
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = e;
        await sleep(500 * (attempt + 1), signal);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Overpass unavailable');
  }
}

/** Overpass-format responses baked to static files (see tools/geobake/bake_detail.py). */
export class StaticOverpassSource implements DetailSource {
  readonly name: string;
  private tiles: Set<string> | null = null;
  private ext = '.json.gz';
  private ready: Promise<void>;

  constructor(private baseUrl: string, name = 'baked') {
    this.name = name;
    this.ready = fetch(`${baseUrl}/index.json`)
      .then((r) => (r.ok ? r.json() : { tiles: [] }))
      .then((j: { tiles: [number, number][]; ext?: string }) => {
        if (j.ext) this.ext = j.ext;
        this.tiles = new Set(j.tiles.map(([x, y]) => `${x},${y}`));
      })
      .catch(() => {
        this.tiles = new Set();
      });
  }

  async init(): Promise<void> {
    await this.ready;
  }

  covers(tx: number, ty: number): boolean {
    return !!this.tiles?.has(`${tx},${ty}`);
  }

  async fetchTile(tx: number, ty: number, signal?: AbortSignal): Promise<GeoData> {
    const json = await fetchMaybeGzipJson<OverpassResponse>(`${this.baseUrl}/${DATA_ZOOM}/${tx}/${ty}${this.ext}`, signal);
    return parseOverpass(json, tx, ty, this.name);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}
