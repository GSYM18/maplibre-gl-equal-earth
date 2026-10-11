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
 * A count-bounded LRU, for values whose size cannot be read off cheaply — decoded source
 * tiles in the protocol. Same recency trick as {@link TileCache}: `Map` keeps insertion
 * order, and a hit is moved to the end by deleting and re-inserting it.
 */
export class EntryCache<T> {
  readonly #entries = new Map<string, T>();
  readonly #maxEntries: number;

  constructor(maxEntries: number) {
    this.#maxEntries = Math.max(0, Math.floor(maxEntries));
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): T | undefined {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key) as T;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.#entries.delete(key);
    if (this.#maxEntries === 0) return;
    this.#entries.set(key, value);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      this.#entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

interface InFlight<T> {
  promise: Promise<T>;
  controller: AbortController;
  callers: number;
}

/**
 * Deduplicates concurrent requests for the same key.
 *
 * MapLibre asks for many output tiles at once and their source covers overlap, so without
 * this the same source tile is fetched several times in parallel — the cache cannot help,
 * because none of the requests has completed yet.
 *
 * Aborts are ref-counted. The shared task runs under its own signal, not any caller's: if it
 * took the first caller's, aborting that one output tile would reject every other tile
 * coalesced onto the fetch, and MapLibre silently drops an AbortError without ever marking
 * the tile errored, leaving it "loading" forever. Each caller instead rejects only itself;
 * the shared task is aborted once no caller is left waiting on it.
 */
export class RequestCoalescer<T> {
  readonly #inFlight = new Map<string, InFlight<T>>();

  get pending(): number {
    return this.#inFlight.size;
  }

  async run(
    key: string,
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();

    let entry = this.#inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: InFlight<T> = {
        controller,
        callers: 0,
        promise: task(controller.signal).finally(() => {
          // A fully aborted entry was already replaced or dropped; only remove our own.
          if (this.#inFlight.get(key) === created) this.#inFlight.delete(key);
        }),
      };
      entry = created;
      this.#inFlight.set(key, entry);
    }

    const shared = entry;
    shared.callers++;
    if (!signal) return shared.promise;

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(signal.reason as Error);
        if (--shared.callers === 0) {
          if (this.#inFlight.get(key) === shared) this.#inFlight.delete(key);
          shared.controller.abort(signal.reason);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.promise
        .finally(() => signal.removeEventListener('abort', onAbort))
        .then(resolve, reject);
    });
  }
}
