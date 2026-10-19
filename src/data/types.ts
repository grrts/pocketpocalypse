import type { Vec2 } from '../core/geo';

// Normalized street-level map data for one z15 data tile. Coordinates are in
// texels relative to the tile origin, so they stay small enough for Float32
// and survive structured cloning / IndexedDB.

export type AreaKind = 'building' | 'water' | 'surface';
export type LineKind = 'road' | 'rail' | 'waterway';

export interface GeoArea {
  id: string;
  kind: AreaKind;
  cls: string;
  rings: number[][];
  levels?: number;
  name?: string;
}

export interface GeoLine {
  id: string;
  kind: LineKind;
  cls: string;
  pts: number[];
  /** Carriageway width in metres. */
  width: number;
  bridge?: boolean;
  name?: string;
}

export interface GeoPoi {
  id: string;
  cls: string;
  x: number;
  y: number;
  name?: string;
}

export interface GeoData {
  z: number;
  x: number;
  y: number;
  origin: Vec2;
  areas: GeoArea[];
  lines: GeoLine[];
  pois: GeoPoi[];
  source: string;
}

/** Anything that can supply street-level data for a z15 tile. */
export interface DetailSource {
  readonly name: string;
  /** Whether this source has data for the tile; sources without coverage are skipped. */
  covers(tx: number, ty: number): boolean;
  fetchTile(tx: number, ty: number, signal?: AbortSignal): Promise<GeoData>;
}

/** Decoded overview-pack tile (see tools/geobake/build_pack.py). Coordinates in tile units (0..extent). */
export interface PackTile {
  z: number;
  x: number;
  y: number;
  areas: { cls: string; rings: Float32Array[] }[];
  lines: { cls: string; pts: Float32Array }[];
}

export interface CityInfo {
  name: string;
  lon: number;
  lat: number;
  pop: number;
}

export interface PackManifest {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  extent: number;
  levels: number[];
  tiles: Record<string, [number, number][]>;
  areaOrder: string[];
  lineOrder: string[];
  outline: [number, number][][];
  cities: CityInfo[];
  attribution: string;
  /** Tile file suffix; '.json.gz' unless the pack was re-staged uncompressed for a host that can't serve gzip files. */
  ext?: string;
}
