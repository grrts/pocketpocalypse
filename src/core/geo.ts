// World coordinates are Web Mercator pixels at zoom 18 ("texels"). That keeps the
// whole planet in one continuous integer-friendly space (2^26 texels wide), lines
// up exactly with slippy-map tiles at every zoom, and gives roughly 0.37 m per
// texel in the Netherlands.

export const TILE_PX = 256;
export const TEXEL_ZOOM = 18;
export const WORLD_TEXELS = TILE_PX * 2 ** TEXEL_ZOOM;
export const EARTH_CIRCUMFERENCE = 40075016.686;

/** Gameplay chunks: one z16 tile, 1024x1024 texels (~380 m in NL). */
export const CHUNK_ZOOM = 16;
export const CHUNK_TEXELS = TILE_PX * 2 ** (TEXEL_ZOOM - CHUNK_ZOOM);
/** Street-level map data is fetched per z15 tile (2x2 chunks). */
export const DATA_ZOOM = 15;
export const DATA_TEXELS = TILE_PX * 2 ** (TEXEL_ZOOM - DATA_ZOOM);

export interface Vec2 {
  x: number;
  y: number;
}

export interface LonLat {
  lon: number;
  lat: number;
}

const MAX_LAT = 85.05112878;

export function lonLatToWorld(lon: number, lat: number): Vec2 {
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const r = (la * Math.PI) / 180;
  const x = ((lon + 180) / 360) * WORLD_TEXELS;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * WORLD_TEXELS;
  return { x, y };
}

export function worldToLonLat(x: number, y: number): LonLat {
  const lon = (x / WORLD_TEXELS) * 360 - 180;
  const n = Math.PI * (1 - (2 * y) / WORLD_TEXELS);
  const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return { lon, lat };
}

/** Ground metres covered by one texel at world y. */
export function metersPerTexel(worldY: number): number {
  const { lat } = worldToLonLat(0, worldY);
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / WORLD_TEXELS;
}

export function texelsPerMeter(worldY: number): number {
  return 1 / metersPerTexel(worldY);
}

/** Texel size of a tile at zoom z. */
export function tileTexels(z: number): number {
  return TILE_PX * 2 ** (TEXEL_ZOOM - z);
}

export function tileAt(z: number, x: number, y: number): { tx: number; ty: number } {
  const s = tileTexels(z);
  return { tx: Math.floor(x / s), ty: Math.floor(y / s) };
}

export function tileOrigin(z: number, tx: number, ty: number): Vec2 {
  const s = tileTexels(z);
  return { x: tx * s, y: ty * s };
}

export function tileLonLatBounds(z: number, tx: number, ty: number): { w: number; s: number; e: number; n: number } {
  const size = tileTexels(z);
  const nw = worldToLonLat(tx * size, ty * size);
  const se = worldToLonLat((tx + 1) * size, (ty + 1) * size);
  return { w: nw.lon, s: se.lat, e: se.lon, n: nw.lat };
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function parseChunkKey(key: string): { cx: number; cy: number } {
  const [a, b] = key.split(',');
  return { cx: Number(a), cy: Number(b) };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Great-circle-ish distance in metres (equirectangular; fine at country scale). */
export function lonLatDistanceM(a: LonLat, b: LonLat): number {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
}

export function pointInRing(x: number, y: number, ring: ArrayLike<number>): boolean {
  // ring: flat [x0,y0,x1,y1,...]
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1];
    const xj = ring[j * 2], yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x: number, y: number, rings: ArrayLike<number>[]): boolean {
  let inside = false;
  for (const r of rings) if (pointInRing(x, y, r)) inside = !inside;
  return inside;
}

export function ringArea(ring: ArrayLike<number>): number {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  }
  return a / 2;
}

export function ringCentroid(ring: ArrayLike<number>): Vec2 {
  let cx = 0, cy = 0, a = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
    cx += (ring[j * 2] + ring[i * 2]) * f;
    cy += (ring[j * 2 + 1] + ring[i * 2 + 1]) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += ring[i * 2]; sy += ring[i * 2 + 1]; }
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Closest point on segment ab to p, with parameter t in [0,1]. */
export function closestOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return { x, y, t, d: Math.hypot(px - x, py - y) };
}
