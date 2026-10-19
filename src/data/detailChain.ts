import type { KeyValueStore } from '../persist/kv';
import type { DetailSource, GeoData } from './types';

const CACHE_VERSION = 1;

/**
 * Picks the first source that covers a tile and caches results in IndexedDB,
 * so a place fetched once from Overpass loads instantly (and offline) later.
 */
export class DetailChain {
  private mem = new Map<string, Promise<GeoData | null>>();

  constructor(private sources: DetailSource[], private kv: KeyValueStore | null) {}

  get(tx: number, ty: number): Promise<GeoData | null> {
    const key = `${tx},${ty}`;
    let p = this.mem.get(key);
    if (!p) {
      p = this.load(tx, ty).catch((e) => {
        this.mem.delete(key);
        throw e;
      });
      this.mem.set(key, p);
      if (this.mem.size > 24) this.mem.delete(this.mem.keys().next().value!);
    }
    return p;
  }

  private async load(tx: number, ty: number): Promise<GeoData | null> {
    const ck = `v${CACHE_VERSION}:15/${tx}/${ty}`;
    const src = this.sources.find((s) => s.covers(tx, ty));
    if (!src) return null;
    if (this.kv && src.name === 'overpass') {
      const hit = await this.kv.get<GeoData>('geo', ck).catch(() => undefined);
      if (hit) return hit;
    }
    const data = await src.fetchTile(tx, ty);
    if (this.kv && src.name === 'overpass') await this.kv.put('geo', ck, data).catch(() => undefined);
    return data;
  }
}
