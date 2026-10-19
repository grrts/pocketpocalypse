import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbKV, MemoryKV, type KeyValueStore } from '../../src/persist/kv';
import { LocalWorldStore, emptyDelta } from '../../src/persist/worldStore';

const stores: [string, () => KeyValueStore][] = [
  ['MemoryKV', () => new MemoryKV()],
  ['IndexedDbKV', () => new IndexedDbKV(`test-${Math.random()}`)],
];

describe.each(stores)('LocalWorldStore on %s', (_name, make) => {
  it('persists chunk deltas and resets the world but not map data', async () => {
    const kv = make();
    const s = new LocalWorldStore(kv);
    expect(await s.loadChunk('1,2')).toBeNull();
    const d = emptyDelta();
    d.containers['w1:door0'] = [{ id: 'canned_soup', qty: 1 }];
    d.zombies['z1'] = 0;
    d.drops.push({ id: 'drop1', x: 1, y: 2, items: [{ id: 'bandage', qty: 2 }] });
    await s.saveChunk('1,2', d);
    expect(await s.loadChunk('1,2')).toEqual(d);

    await kv.put('geo', 'v1:15/1/2', { cached: true });
    await s.reset();
    expect(await s.loadChunk('1,2')).toBeNull();
    expect(await kv.get('geo', 'v1:15/1/2')).toEqual({ cached: true });
  });

  it('ignores saves from another format version', async () => {
    const kv = make();
    const s = new LocalWorldStore(kv);
    await kv.put('meta', 'world', { version: 999 });
    expect(await s.loadWorld()).toBeNull();
  });
});
