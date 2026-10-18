// Plain-data descriptions of everything a chunk generates. Ids are stable
// (derived from OSM ids or chunk coordinates) so saved changes can refer to them.

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
}
