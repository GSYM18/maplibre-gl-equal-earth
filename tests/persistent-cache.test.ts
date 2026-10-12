import { describe, expect, it, vi } from 'vitest';

import {
  CACHE_NAME_PREFIX,
  PersistentTileCache,
  SWEEP_MARKER_KEY,
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

  it('misses an entry without an expiry, even at time 0', async () => {
    const storage = new FakeCacheStorage();
    await (await storage.open('equal-earth-1')).put('k', new Response(new ArrayBuffer(1)));
    expect(await new PersistentTileCache(storage, '1', () => 0).get('k')).toBeUndefined();
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

  it('skips the put when ttlDays is not positive', async () => {
    const storage = new FakeCacheStorage();
    const cache = new PersistentTileCache(storage, '1', () => 0);
    await cache.put('k', new ArrayBuffer(1), 0);
    await cache.put('k', new ArrayBuffer(1), -1);
    await cache.put('k', new ArrayBuffer(1), NaN);
    expect(storage.caches.get('equal-earth-1')?.entries.size ?? 0).toBe(0);
  });

  it('treats a throwing match or put as a miss', async () => {
    const failing = {
      match: () => Promise.reject(new Error('read')),
      put: () => Promise.reject(new Error('QuotaExceededError')),
      delete: () => Promise.resolve(false),
      keys: () => Promise.resolve([]),
    };
    const storage = { open: () => Promise.resolve(failing), keys: () => Promise.resolve([]), delete: () => Promise.resolve(false) };
    const cache = new PersistentTileCache(storage, '1');
    await expect(cache.put('k', new ArrayBuffer(1), 7)).resolves.toBeUndefined();
    expect(await cache.get('k')).toBeUndefined();
  });
});

describe('the sweep after open (Ruling R25)', () => {
  /** An entry written straight into the fake, expiring at `expires`. */
  const entry = (expires: number) =>
    new Response(new ArrayBuffer(1), { headers: { 'x-eqe-expires': String(expires) } });

  it('deletes expired entries without their being looked up', async () => {
    const storage = new FakeCacheStorage();
    const stored = await storage.open('equal-earth-1');
    await stored.put('expired', entry(1000));
    await stored.put('unreadable', new Response(new ArrayBuffer(1)));
    await stored.put('live', entry(5000));
    const cache = new PersistentTileCache(storage, '1', () => 2000);
    expect(await cache.get('something-else')).toBeUndefined();
    await vi.waitFor(() => expect([...stored.entries.keys()].sort()).toEqual(['live', SWEEP_MARKER_KEY].sort()));
  });

  it('caps the cache at 2000 entries, evicting the earliest-expiring first', async () => {
    const storage = new FakeCacheStorage();
    const stored = await storage.open('equal-earth-1');
    // Inserted latest-expiring first, so that insertion order is not what decides.
    for (let i = 2004; i >= 1; i--) await stored.put(`k${i}`, entry(10_000 + i));
    const cache = new PersistentTileCache(storage, '1', () => 0);
    await cache.get('k2004');
    // The sweep's marker entry is not a tile and does not count.
    await vi.waitFor(() => expect(stored.entries.size).toBe(2000 + 1));
    expect(stored.entries.has(SWEEP_MARKER_KEY)).toBe(true);
    for (const gone of ['k1', 'k2', 'k3', 'k4']) expect(stored.entries.has(gone)).toBe(false);
    expect(stored.entries.has('k5')).toBe(true);
    expect(stored.entries.has('k2004')).toBe(true);
  });

  it('sweeps at most once a day per cache, whatever the number of page loads and workers', async () => {
    const DAY = 86_400_000;
    let now = 10 * DAY;
    const storage = new FakeCacheStorage();
    const stored = await storage.open('equal-earth-1');
    await stored.put('expired', entry(now - 1));
    const tiles = () => [...stored.entries.keys()].filter((key) => key !== SWEEP_MARKER_KEY);
    const first = new PersistentTileCache(storage, '1', () => now);
    await first.get('x');
    await vi.waitFor(() => expect(tiles()).toEqual([]));
    // Another worker, or the next page load, within the day: no second walk over the cache.
    await stored.put('expired-later', entry(now - 1));
    const keys = vi.spyOn(stored, 'keys');
    now += DAY - 1;
    await new PersistentTileCache(storage, '1', () => now).get('x');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(keys).not.toHaveBeenCalled();
    expect(tiles()).toEqual(['expired-later']);
    // A day after the last sweep, the next one sweeps again.
    now += 2;
    await new PersistentTileCache(storage, '1', () => now).get('x');
    await vi.waitFor(() => expect(tiles()).toEqual([]));
    expect(keys).toHaveBeenCalledTimes(1);
  });

  it('stays silent when keys() throws, and does not hold up get or put', async () => {
    const storage = new FakeCacheStorage();
    const stored = await storage.open('equal-earth-1');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    stored.keys = () => blocked.then(() => Promise.reject(new Error('keys')));
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    try {
      const cache = new PersistentTileCache(storage, '1', () => 0);
      // The sweep is still waiting on keys(): get and put go ahead regardless.
      await cache.put('k', new Uint8Array([7]).buffer, 7);
      expect(new Uint8Array((await cache.get('k'))!)).toEqual(new Uint8Array([7]));
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
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
