/**
 * LRU cache for fetched source tiles.
 *
 * Source tiles are shared heavily between output tiles — an output tile's pre-image usually
 * overlaps 4–9 Mercator tiles, and neighbouring output tiles overlap most of the same ones.
 * Measured against OpenFreeMap, building output tile 2/1/1 pulls 9.4 MB of source; without
 * caching, the eight neighbouring output tiles would each re-fetch nearly all of it.
 *
 * Bounded by total bytes rather than entry count, because tile sizes vary by two orders of
 * magnitude between z0 and z2.
 */

export interface TileCacheOptions {
  /** Byte budget for retained tile data. @defaultValue 64 MiB */
  maxBytes?: number;
}

interface Entry {
  value: ArrayBuffer | null;
  bytes: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A byte-bounded LRU over tile payloads.
 *
 * `null` is a cacheable value: it records "the server does not have this tile", which is
 * worth remembering so a missing tile is not re-requested for every output tile that
 * overlaps it.
 */
export class TileCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(options: TileCacheOptions = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** Returns `undefined` for a miss, distinct from a cached `null` (tile absent upstream). */
  get(key: string): ArrayBuffer | null | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    // Refresh recency: delete + set moves the key to the end of Map's insertion order.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: ArrayBuffer | null): void {
    const existing = this.#entries.get(key);
    if (existing) {
      this.#bytes -= existing.bytes;
      this.#entries.delete(key);
    }

    const bytes = value?.byteLength ?? 0;
    // An oversized single tile is served but not retained, rather than evicting everything.
    if (bytes > this.#maxBytes) return;

    this.#entries.set(key, { value, bytes });
    this.#bytes += bytes;
    this.#evict();
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  #evict(): void {
    while (this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      const entry = this.#entries.get(oldest.value);
      this.#entries.delete(oldest.value);
      this.#bytes -= entry?.bytes ?? 0;
    }
  }
}

/**
 * Deduplicates concurrent requests for the same key.
 *
 * MapLibre asks for many output tiles at once and their source covers overlap, so without
 * this the same source tile is fetched several times in parallel — the cache cannot help,
 * because none of the requests has completed yet.
 */
export class RequestCoalescer<T> {
  readonly #inFlight = new Map<string, Promise<T>>();

  get pending(): number {
    return this.#inFlight.size;
  }

  async run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing) return existing;

    const promise = task().finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, promise);
    return promise;
  }
}
