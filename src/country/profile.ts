// A country is pure configuration: where its baked overview pack lives, how the
// outbreak enters it, and a few notable places. Street-level data comes from
// OpenStreetMap for any country, so adding one means baking a pack
// (tools/geobake) and writing a profile like nl.ts.

export interface NamedPoint {
  name: string;
  lon: number;
  lat: number;
}

export interface EntryPoint extends NamedPoint {
  /** relative chance the infection arrives here first */
  weight: number;
  kind: 'airport' | 'port' | 'border';
}

export interface CountryProfile {
  id: string;
  name: string;
  /** Base URL of the overview pack (manifest.json + pack tiles) */
  packUrl: string;
  /** Optional baked Overpass-format tiles that work offline */
  bakedDetailUrl?: string;
  /** Street-level data for the whole country, baked into bundles (tools/geobake/bake_bundles.py) */
  bundleUrl?: string;
  /** Satellite colour mosaic (tools/geobake/sentinel.py) */
  satelliteUrl?: string;
  entryPoints: EntryPoint[];
  /** Garrisons that make nearby cities hold out longer */
  militaryBases: NamedPoint[];
  /** Quick-pick spawn locations on the selection map */
  spawnPresets: NamedPoint[];
}
