import type { OutbreakHistory } from '../sim/outbreak';
import type { BuildingModel } from '../world/buildingModel';
import type { BuildingInfo, ChunkSpawns, ChunkStats } from '../world/spawnTypes';

export interface InitMsg {
  type: 'init';
  packUrl: string;
  bakedDetailUrl?: string;
  bundleUrl?: string;
  useOverpass: boolean;
  overpassEndpoints?: string[];
  elevationUrl?: string;
  seed: number;
  history: OutbreakHistory;
}

export interface ChunkReq {
  type: 'chunk';
  id: number;
  cx: number;
  cy: number;
  /** art pixels per texel in the bitmap: 1, or 2 for detailed ground near the player */
  scale?: number;
}

export interface OverviewReq {
  type: 'overview';
  id: number;
  z: number;
  x: number;
  y: number;
}

export type WorkerRequest = InitMsg | ChunkReq | OverviewReq;

export interface ChunkResult {
  type: 'chunk';
  id: number;
  bitmap: ImageBitmap;
  collision: ArrayBuffer;
  spawns: ChunkSpawns;
  interiors: BuildingInfo[];
  /** every building touching the chunk, to draw (world/buildingModel.ts) */
  models: BuildingModel[];
  /** vegetation records, see world/vegetation.ts */
  veg: ArrayBuffer;
  stats: ChunkStats;
}

export interface OverviewResult {
  type: 'overview';
  id: number;
  bitmap: ImageBitmap;
}

export interface ErrorResult {
  type: 'error';
  id: number;
  message: string;
}

export type WorkerResponse = ChunkResult | OverviewResult | ErrorResult;

export type JobRequest = Omit<ChunkReq, 'id'> | Omit<OverviewReq, 'id'>;
