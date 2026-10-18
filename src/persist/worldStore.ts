// What a world remembers. Unvisited places are regenerated from the seed, so
// only differences from the generated state are stored, per chunk.

import type { Vec2 } from '../core/geo';
import type { ItemStack } from '../game/items';
import type { OutbreakHistory } from '../sim/outbreak';
import type { KeyValueStore } from './kv';

export const SAVE_VERSION = 1;

export interface PlayerCorpse {
  id: string;
  x: number;
  y: number;
  items: ItemStack[];
  diedAt: number;
  cause: string;
  survivor: number;
}

export interface WorldSave {
  version: number;
  seed: number;
  countryId: string;
  createdAt: number;
  history: OutbreakHistory;
  playerCorpses: PlayerCorpse[];
}

export interface PlayerSave {
  x: number;
  y: number;
  spawn: Vec2;
  spawnName: string;
  hp: number;
  stamina: number;
  hunger: number;
  thirst: number;
  inventory: ItemStack[];
  equipped: string | null;
  alive: boolean;
  survivor: number;
  kills: number;
  timeAlive: number;
}

export interface Drop {
  id: string;
  x: number;
  y: number;
  items: ItemStack[];
}

export interface ChunkDelta {
  v: 1;
  /** container id -> current contents (absent = never opened, roll from seed) */
  containers: Record<string, ItemStack[]>;
  /** zombie id -> last known state, or 0 when destroyed */
  zombies: Record<string, { x: number; y: number; hp: number } | 0>;
  drops: Drop[];
}

export function emptyDelta(): ChunkDelta {
  return { v: 1, containers: {}, zombies: {}, drops: [] };
}

/** Storage contract for a world. A multiplayer client would implement this against a server. */
export interface WorldStore {
  loadWorld(): Promise<WorldSave | null>;
  saveWorld(w: WorldSave): Promise<void>;
  loadPlayer(): Promise<PlayerSave | null>;
  savePlayer(p: PlayerSave): Promise<void>;
  loadChunk(key: string): Promise<ChunkDelta | null>;
  saveChunk(key: string, d: ChunkDelta): Promise<void>;
  /** Forget the world (map data cache is kept). */
  reset(): Promise<void>;
}

export class LocalWorldStore implements WorldStore {
  constructor(private kv: KeyValueStore) {}

  async loadWorld() {
    const w = await this.kv.get<WorldSave>('meta', 'world');
    return w && w.version === SAVE_VERSION ? w : null;
  }
  saveWorld(w: WorldSave) {
    return this.kv.put('meta', 'world', w);
  }
  async loadPlayer() {
    return (await this.kv.get<PlayerSave>('meta', 'player')) ?? null;
  }
  savePlayer(p: PlayerSave) {
    return this.kv.put('meta', 'player', p);
  }
  async loadChunk(key: string) {
    return (await this.kv.get<ChunkDelta>('chunks', key)) ?? null;
  }
  saveChunk(key: string, d: ChunkDelta) {
    return this.kv.put('chunks', key, d);
  }
  async reset() {
    await this.kv.clear('meta');
    await this.kv.clear('chunks');
  }
}
