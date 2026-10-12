/**
 * The persistent output-tile cache (spec §6): warped low-zoom tiles kept in Cache Storage, so a
 * reload, a second tab or a later visit draws the world view without fetching and warping the
 * source tiles again. Those are the expensive tiles: output tile 2/1/1 needs 9 OpenFreeMap source
 * tiles totalling 9.4 MB to produce 225 kB.
 *
 * It runs where the protocol handler runs, normally inside MapLibre's workers, where `caches` is
 * available in a secure context (`https:` or `localhost`). Without it, or when it throws (an
 * insecure context, a browser that blocks storage, a full quota), every lookup is a miss and every
 * store is dropped, silently: the tile is simply built as before.
 *
 * Layout: the plugin version is the cache **name** (`equal-earth-<version>`), so a new release
 * starts empty and the first use per instance deletes every other `equal-earth-*` cache. The key is
 * `https://equal-earth.invalid/<hash>/<blend>/<z>/<x>/<y>`, the hash covering the whole source
 * config, the upstream template and any API key in it included, so rotating a key starts a fresh
 * namespace and the key itself is never stored in plain text. Each entry carries its expiry in an
 * `x-eqe-expires` header; an expired entry is a miss and is deleted.
 *
 * The version is a build id (Ruling R25, `scripts/build-id.ts`): `<package version>+<hash of the
 * worker's sources>`, so a code change that alters the tiles never meets the old ones.
 *
 * Namespaces nothing reads again (a rotated or per-session API key) would never be looked up, so
 * their entries would never expire by lookup. So once per instance, after opening, a background
 * sweep deletes every expired entry and caps the cache at {@link MAX_ENTRIES}, evicting the
 * earliest-expiring first (Ruling R25). It never delays `get` or `put`, never rejects, never logs.
 */

import type { EqualEarthSourceConfig } from './protocol.js';
import type { TileId } from './tile-cover.js';

export interface PersistentCacheOptions {
  /** Output tiles above this zoom are never stored. @defaultValue 3 */
  maxZoom?: number;
  /** Entries older than this are misses and are deleted. @defaultValue 7 */
  ttlDays?: number;
}

/** The slice of `CacheStorage` used (injectable for tests). */
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

/** The slice of `Cache` used. */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** The stored requests, as `Cache.keys()` returns them (a URL string is accepted too). */
  keys(): Promise<readonly (string | { readonly url: string })[]>;
}

export const CACHE_NAME_PREFIX = 'equal-earth-';

export const DEFAULT_PERSISTENT_MAX_ZOOM = 3;
export const DEFAULT_PERSISTENT_TTL_DAYS = 7;

/** The sweep's cap per cache: ~2000 low-zoom tiles is several world views' worth at z0–3. */
export const MAX_ENTRIES = 2000;

const EXPIRES_HEADER = 'x-eqe-expires';
const DAY_MS = 86_400_000;
const KEY_ORIGIN = 'https://equal-earth.invalid';

/** FNV-1a 64-bit over the config's stable JSON (sorted keys), `persistentCache` excluded; 16 hex digits. */
export function hashSourceConfig(config: EqualEarthSourceConfig): string {
  // Where a tile is kept does not change what it is.
  const hashed: Partial<EqualEarthSourceConfig> = { ...config };
  delete hashed.persistentCache;
  return fnv1a64(stableJson(hashed));
}

/** `https://equal-earth.invalid/<hash>/<blend>/<z>/<x>/<y>` */
export function persistentKey(config: EqualEarthSourceConfig, tile: TileId): string {
  return `${KEY_ORIGIN}/${hashSourceConfig(config)}/${config.blend ?? 0}/${tile.z}/${tile.x}/${tile.y}`;
}

export class PersistentTileCache {
  readonly #storage: CacheStorageLike | undefined;
  readonly #name: string;
  readonly #now: () => number;
  /** The open cache, once per instance; `undefined` once opening failed. */
  #cache: Promise<CacheLike | undefined> | undefined;

  constructor(storage: CacheStorageLike | undefined, version: string, now: () => number = Date.now) {
    this.#storage = storage;
    this.#name = CACHE_NAME_PREFIX + version;
    this.#now = now;
  }

  /** Never rejects: any failure (no Cache Storage, insecure context, quota) is a miss. */
  async get(key: string): Promise<ArrayBuffer | undefined> {
    try {
      const cache = await this.#open();
      const response = await cache?.match(key);
      if (!cache || !response) return undefined;
      const expires = expiresOf(response);
      // A missing or unreadable expiry is treated as expired.
      if (!(this.#now() <= expires)) {
        await cache.delete(key);
        return undefined;
      }
      return await response.arrayBuffer();
    } catch {
      return undefined;
    }
  }

  /** Never rejects; stores with an `x-eqe-expires` header. A `ttlDays` of 0 or less stores nothing. */
  async put(key: string, data: ArrayBuffer, ttlDays: number): Promise<void> {
    if (!(ttlDays > 0)) return;
    try {
      const cache = await this.#open();
      if (!cache) return;
      const expires = this.#now() + ttlDays * DAY_MS;
      await cache.put(
        key,
        new Response(data, {
          headers: { 'content-type': 'application/x-protobuf', [EXPIRES_HEADER]: String(expires) },
        }),
      );
    } catch {
      // A full quota or a storage error: the tile was served; it just is not kept.
    }
  }

  #open(): Promise<CacheLike | undefined> {
    return (this.#cache ??= this.#init());
  }

  /** Delete every other version's cache, then open this version's. */
  async #init(): Promise<CacheLike | undefined> {
    const storage = this.#storage;
    if (!storage) return undefined;
    try {
      const stale = (await storage.keys()).filter((name) => name.startsWith(CACHE_NAME_PREFIX) && name !== this.#name);
      await Promise.all(stale.map((name) => storage.delete(name)));
    } catch {
      // Leftovers of an old version only cost storage; this version's cache still works.
    }
    let cache: CacheLike;
    try {
      cache = await storage.open(this.#name);
    } catch {
      return undefined;
    }
    void this.#sweep(cache);
    return cache;
  }

  /** Delete expired entries, then evict the earliest-expiring beyond {@link MAX_ENTRIES}. */
  async #sweep(cache: CacheLike): Promise<void> {
    try {
      const now = this.#now();
      const live: { key: string; expires: number }[] = [];
      for (const request of await cache.keys()) {
        const key = typeof request === 'string' ? request : request.url;
        const expires = expiresOf(await cache.match(key));
        if (now <= expires) live.push({ key, expires });
        else await cache.delete(key);
      }
      if (live.length <= MAX_ENTRIES) return;
      live.sort((a, b) => a.expires - b.expires);
      for (const { key } of live.slice(0, live.length - MAX_ENTRIES)) await cache.delete(key);
    } catch {
      // Storage that fails here fails for get and put too, which treat it as a miss.
    }
  }
}

/** An entry's expiry; `NaN` (expired by every comparison) when it has none or it is unreadable. */
function expiresOf(response: Response | undefined): number {
  const header = response?.headers.get(EXPIRES_HEADER);
  return header === null || header === undefined || header === '' ? NaN : Number(header);
}

/** JSON with object keys sorted at every level, and `undefined` members dropped as `JSON.stringify` does. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item ?? null)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64 over the UTF-8 bytes of `text`, as 16 hex digits. */
function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}
