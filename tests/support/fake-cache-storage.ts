/**
 * An in-memory `CacheStorageLike` for the persistent output-tile cache: one `Map` of responses
 * per cache name. `Response` is a Node global (Node >= 20).
 */
import type { CacheLike, CacheStorageLike } from '../../src/tiles/persistent-cache.js';

export class FakeCache implements CacheLike {
  readonly entries = new Map<string, Response>();

  match(key: string): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(key)?.clone());
  }

  put(key: string, response: Response): Promise<void> {
    this.entries.set(key, response);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(key));
  }
}

export class FakeCacheStorage implements CacheStorageLike {
  readonly caches = new Map<string, FakeCache>();

  constructor(names: readonly string[] = []) {
    for (const name of names) this.caches.set(name, new FakeCache());
  }

  /** Opens (and so creates) a cache, as `CacheStorage.open` does. */
  open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return Promise.resolve(cache);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.caches.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.caches.delete(name));
  }

  names(): string[] {
    return [...this.caches.keys()];
  }
}
