import type { OutbreakHistory } from '../sim/outbreak';
import type { ChunkSpawns, ChunkStats } from '../world/spawnTypes';

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
