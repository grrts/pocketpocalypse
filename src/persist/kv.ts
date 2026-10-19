// Minimal async key-value storage. IndexedDB in the browser (main thread and
// workers), an in-memory map in tests. Everything persistent goes through this
// so a server-backed store can replace it for multiplayer.

export interface KeyValueStore {
  get<T>(store: string, key: string): Promise<T | undefined>;
  put<T>(store: string, key: string, value: T): Promise<void>;
  delete(store: string, key: string): Promise<void>;
  keys(store: string): Promise<string[]>;
  clear(store: string): Promise<void>;
}

export const STORES = ['meta', 'chunks', 'geo'] as const;

export class MemoryKV implements KeyValueStore {
  private data = new Map<string, Map<string, unknown>>();
  private s(store: string) {
    let m = this.data.get(store);
    if (!m) this.data.set(store, (m = new Map()));
    return m;
  }
  async get<T>(store: string, key: string) {
    const v = this.s(store).get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(store: string, key: string, value: T) {
    this.s(store).set(key, structuredClone(value));
  }
  async delete(store: string, key: string) {
    this.s(store).delete(key);
  }
  async keys(store: string) {
    return [...this.s(store).keys()];
  }
  async clear(store: string) {
    this.s(store).clear();
  }
}

export class IndexedDbKV implements KeyValueStore {
  private db: Promise<IDBDatabase>;

  constructor(name = 'pocketpocalypse', version = 1, idb: IDBFactory = indexedDB) {
    this.db = new Promise((resolve, reject) => {
      const req = idb.open(name, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  private async tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? req.error);
      t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
    });
  }

  get<T>(store: string, key: string): Promise<T | undefined> {
    return this.tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  }
  async put<T>(store: string, key: string, value: T): Promise<void> {
    await this.tx(store, 'readwrite', (s) => s.put(value, key));
  }
  async delete(store: string, key: string): Promise<void> {
    await this.tx(store, 'readwrite', (s) => s.delete(key));
  }
  async keys(store: string): Promise<string[]> {
    const k = await this.tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys());
    return k.map(String);
  }
  async clear(store: string): Promise<void> {
    await this.tx(store, 'readwrite', (s) => s.clear());
  }
}
