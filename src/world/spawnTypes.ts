// Plain-data descriptions of everything a chunk generates. Ids are stable
// (derived from OSM ids or chunk coordinates) so saved changes can refer to them.

import type { InteriorPlan } from './interior';

export type VehicleModel = 'car' | 'van' | 'truck' | 'bus' | 'police' | 'ambulance' | 'military';
export type CorpseKind = 'civilian' | 'soldier' | 'police';
export type ZombieKind = 'civilian' | 'soldier' | 'police' | 'runner';

export interface SpawnContainer {
  id: string;
  x: number;
  y: number;
  type: string;
  label: string;
  /** how picked-over the area already is (0..1) */
  scavenged: number;
}

export interface SpawnVehicle {
  id: string;
  x: number;
  y: number;
  angle: number;
  model: VehicleModel;
  color: number;
  burnt: boolean;
  lootType: string | null;
}

export interface SpawnCorpse {
  id: string;
  x: number;
  y: number;
  angle: number;
  kind: CorpseKind;
  lootType: string;
}

export interface SpawnZombie {
  id: string;
  x: number;
  y: number;
  kind: ZombieKind;
  hp: number;
}

export interface ChunkSpawns {
  containers: SpawnContainer[];
  vehicles: SpawnVehicle[];
  corpses: SpawnCorpse[];
  zombies: SpawnZombie[];
}

export interface ChunkStats {
  buildings: number;
  roads: number;
  source: string;
  ms: number;
  flooded: number;
  /** Why the baked map data could not be used here, if it failed */
  dataError?: string;
}

/**
 * A building you can walk into: its footprint and what its inside is built from.
 * The inside itself (ids, plan) is filled in on the main thread when someone
 * comes near (world/interior.ts openInterior), so chunks stay cheap to make.
 */
export interface BuildingInfo {
  id: string;
  rings: number[][];
  /** texel box of the inside raster */
  x0: number;
  y0: number;
  w: number;
  h: number;
  burnt: boolean;
  /** building class (house, shop, ...) */
  cls: string;
  /** front door on the outline (world texels) and its outward normal */
  door: { x: number; y: number; nx: number; ny: number };
  seed: number;
  /** texels per metre here */
  tpm: number;
  /** inside material per texel (0 outside), once opened */
  ids?: Uint8Array;
  /** floor plan in raster coordinates (texels from x0, y0), once opened */
  plan?: InteriorPlan;
}
