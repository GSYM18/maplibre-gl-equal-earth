import { describe, expect, it } from 'vitest';

import {
  CACHE_NAME_PREFIX,
  PersistentTileCache,
  hashSourceConfig,
  persistentKey,
} from '../src/tiles/persistent-cache.js';
import { FakeCacheStorage } from './support/fake-cache-storage.js';

describe('PersistentTileCache', () => {
  it("stores and returns a tile under the version's cache name", async () => {
    const storage = new FakeCacheStorage();
    const cache = new PersistentTileCache(storage, '1.2.3', () => 0);
    await cache.put('https://equal-earth.invalid/a/0/1/0/0', new Uint8Array([1, 2, 3]).buffer, 7);
    expect(storage.names()).toEqual(['equal-earth-1.2.3']);
    expect(new Uint8Array((await cache.get('https://equal-earth.invalid/a/0/1/0/0'))!)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('misses and deletes an entry past its TTL', async () => {
    let now = 0;
    const storage = new FakeCacheStorage();
    const cache = new PersistentTileCache(storage, '1', () => now);
    await cache.put('k', new ArrayBuffer(1), 7);
    now = 7 * 86_400_000;
    expect(await cache.get('k')).toBeDefined();
    now = 7 * 86_400_000 + 1;
    expect(await cache.get('k')).toBeUndefined();
    expect(await (await storage.open('equal-earth-1')).match('k')).toBeUndefined();
  });

  it("deletes other versions' caches once", async () => {
    const storage = new FakeCacheStorage(['equal-earth-0.9.0', 'someone-else']);
    const cache = new PersistentTileCache(storage, '1.0.0');
    await cache.get('k');
    expect(storage.names().sort()).toEqual(['equal-earth-1.0.0', 'someone-else']);
    // Once per instance: a cache another worker of a newer page creates later is not its business.
    await storage.open('equal-earth-2.0.0');
    await cache.get('k');
    expect(storage.names().sort()).toEqual(['equal-earth-1.0.0', 'equal-earth-2.0.0', 'someone-else']);
  });

  it('serves nothing and throws nothing without Cache Storage, or when it throws', async () => {
    expect(await new PersistentTileCache(undefined, '1').get('k')).toBeUndefined();
    await expect(new PersistentTileCache(undefined, '1').put('k', new ArrayBuffer(1), 7)).resolves.toBeUndefined();
    const broken = {
      open: () => Promise.reject(new Error('SecurityError')),
      keys: () => Promise.reject(new Error('x')),
      delete: () => Promise.resolve(false),
    };
    const cache = new PersistentTileCache(broken, '1');
    await expect(cache.put('k', new ArrayBuffer(1), 7)).resolves.toBeUndefined();
    expect(await cache.get('k')).toBeUndefined();
  });

  it('treats a throwing match or put as a miss', async () => {
    const failing = {
      match: () => Promise.reject(new Error('read')),
      put: () => Promise.reject(new Error('QuotaExceededError')),
      delete: () => Promise.resolve(false),
    };
    const storage = { open: () => Promise.resolve(failing), keys: () => Promise.resolve([]), delete: () => Promise.resolve(false) };
    const cache = new PersistentTileCache(storage, '1');
    await expect(cache.put('k', new ArrayBuffer(1), 7)).resolves.toBeUndefined();
    expect(await cache.get('k')).toBeUndefined();
  });
});

describe('hashSourceConfig and persistentKey', () => {
  it("hashes the source config including the template's API key, excluding persistentCache", () => {
    const a = hashSourceConfig({ url: 'https://t/{z}/{x}/{y}?key=A', blend: 0 });
    expect(hashSourceConfig({ url: 'https://t/{z}/{x}/{y}?key=B', blend: 0 })).not.toBe(a);
    expect(hashSourceConfig({ blend: 0, url: 'https://t/{z}/{x}/{y}?key=A', persistentCache: { maxZoom: 5 } })).toBe(a);
    expect(hashSourceConfig({ blend: 0, url: 'https://t/{z}/{x}/{y}?key=A', persistentCache: false })).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes with every option that changes the output tile', () => {
    const base = { url: 'https://t/{z}/{x}/{y}', blend: 0 };
    const a = hashSourceConfig(base);
    expect(hashSourceConfig({ ...base, sourceZoomOffset: -1 })).not.toBe(a);
    expect(hashSourceConfig({ ...base, layers: ['water'] })).not.toBe(a);
    expect(hashSourceConfig({ ...base, buffer: 32 })).not.toBe(a);
  });

  it('is FNV-1a 64 over the stable JSON', () => {
    // The reference below is checked against the published vector for "a"; the config
    // `{ url: '' }` serialises to the 10 bytes `{"url":""}`.
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(hashSourceConfig({ url: '' })).toBe(fnv1a64('{"url":""}'));
    expect(hashSourceConfig({ url: 'é', blend: 0 })).toBe(fnv1a64('{"blend":0,"url":"é"}'));
  });

  it('builds the key from the hash, the blend and the tile, never the template', () => {
    const config = { url: 'https://t/{z}/{x}/{y}?key=SECRET', blend: 1 / 3 };
    const key = persistentKey(config, { z: 2, x: 1, y: 3 });
    expect(key).toBe(`https://equal-earth.invalid/${hashSourceConfig(config)}/${1 / 3}/2/1/3`);
    expect(key).not.toContain('SECRET');
    expect(persistentKey({ url: 'x' }, { z: 0, x: 0, y: 0 })).toMatch(/\/0\/0\/0\/0$/);
    expect(CACHE_NAME_PREFIX).toBe('equal-earth-');
  });
});

/** Reference FNV-1a 64 over UTF-8 bytes, with BigInt. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}
