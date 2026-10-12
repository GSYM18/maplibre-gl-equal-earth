import { readFileSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { fromGeojsonVt } from 'vt-pbf';
import { describe, expect, it, vi } from 'vitest';

import { EntryCache, RequestCoalescer, TileCache } from '../src/tiles/cache.js';
import * as mvt from '../src/tiles/mvt.js';
import { SWEEP_MARKER_KEY, persistentKey } from '../src/tiles/persistent-cache.js';
import { sourceTilesFor, type TileId } from '../src/tiles/tile-cover.js';
import {
  createEqualEarthProtocol,
  encodeSourceUrl,
  expandTemplate,
  parseTileUrl,
  PROTOCOL_SCHEME,
  type EqualEarthSourceConfig,
} from '../src/tiles/protocol.js';
import { eqeVersion } from '../scripts/build-id.ts';
import { FakeCacheStorage } from './support/fake-cache-storage.js';

const UPSTREAM = 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf';

describe('tile URL codec', () => {
  it('round-trips a config through the URL', () => {
    const url = encodeSourceUrl({ url: UPSTREAM, blend: 1 / 3, sourceZoom: 3 });
    expect(url.startsWith(`${PROTOCOL_SCHEME}://`)).toBe(true);
    expect(url.endsWith('/{z}/{x}/{y}')).toBe(true);

    const resolved = url.replace('{z}', '2').replace('{x}', '1').replace('{y}', '3');
    const { config, tile } = parseTileUrl(resolved);

    expect(config.url).toBe(UPSTREAM);
    expect(config.blend).toBe(1 / 3);
    expect(config.sourceZoom).toBe(3);
    expect(tile).toEqual({ z: 2, x: 1, y: 3 });
  });

  it('survives templates containing URL metacharacters', () => {
    // Query strings and fragments in a tile template are entirely normal (API keys,
    // style parameters), which is why the config is base64url-encoded rather than
    // percent-escaped into the path.
    const awkward = 'https://example.com/tiles?key=a&b=c#frag/{z}/{x}/{y}.pbf';
    const url = encodeSourceUrl({ url: awkward });
    const resolved = url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
    expect(parseTileUrl(resolved).config.url).toBe(awkward);
  });

  it('rejects malformed URLs rather than guessing', () => {
    expect(() => parseTileUrl('eqearth://abc')).toThrow();
    expect(() => parseTileUrl('eqearth://abc/x/y/z')).toThrow(/coordinates/);
  });

  it('rejects a config without an upstream template', () => {
    const encoded = btoa(JSON.stringify({ nope: 1 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(() => parseTileUrl(`eqearth://${encoded}/0/0/0`)).toThrow(/upstream template/);
  });

  it('rejects a blend outside [0, 1] rather than clamping it', () => {
    for (const blend of [-0.1, 1.5, 'half', null]) {
      const encoded = btoa(JSON.stringify({ url: UPSTREAM, blend }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(() => parseTileUrl(`eqearth://${encoded}/0/0/0`)).toThrow(/blend/);
    }
  });

  it('rejects a blend outside [0, 1] when encoding', () => {
    for (const blend of [-0.1, 1.5, NaN, Infinity]) {
      expect(() => encodeSourceUrl({ url: UPSTREAM, blend })).toThrow(TypeError);
    }
  });

  it('rejects a sourceZoomOffset that is not an integer when encoding', () => {
    for (const sourceZoomOffset of [-0.5, NaN, Infinity]) {
      expect(() => encodeSourceUrl({ url: UPSTREAM, sourceZoomOffset })).toThrow(TypeError);
    }
    expect(() => encodeSourceUrl({ url: UPSTREAM, sourceZoomOffset: -1 })).not.toThrow();
  });

  it('rejects a tile URL whose sourceZoomOffset is not an integer, as for blend', () => {
    for (const sourceZoomOffset of [0.5, -2.5, '1', null]) {
      const encoded = btoa(JSON.stringify({ url: UPSTREAM, sourceZoomOffset }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(() => parseTileUrl(`eqearth://${encoded}/0/0/0`), String(sourceZoomOffset)).toThrow(/sourceZoomOffset/);
    }
    const ok = encodeSourceUrl({ url: UPSTREAM, sourceZoomOffset: -1 }).replace('{z}/{x}/{y}', '0/0/0');
    expect(parseTileUrl(ok).config.sourceZoomOffset).toBe(-1);
  });

  it('expands templates', () => {
    expect(expandTemplate(UPSTREAM, { z: 4, x: 2, y: 9 })).toBe(
      'https://tiles.openfreemap.org/planet/latest/4/2/9.pbf',
    );
  });
});

describe('TileCache', () => {
  it('stores and retrieves', () => {
    const cache = new TileCache();
    const data = new ArrayBuffer(16);
    cache.set('a', data);
    expect(cache.get('a')).toBe(data);
    expect(cache.bytes).toBe(16);
  });

  it('distinguishes a miss from a cached absent tile', () => {
    const cache = new TileCache();
    cache.set('gone', null);
    expect(cache.get('gone')).toBeNull();
    expect(cache.get('never-seen')).toBeUndefined();
  });

  it('evicts least-recently-used entries over the byte budget', () => {
    const cache = new TileCache({ maxBytes: 100 });
    cache.set('a', new ArrayBuffer(40));
    cache.set('b', new ArrayBuffer(40));
    cache.get('a'); // refresh a, making b the oldest
    cache.set('c', new ArrayBuffer(40));

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('serves but does not retain an oversized tile', () => {
    const cache = new TileCache({ maxBytes: 10 });
    cache.set('huge', new ArrayBuffer(100));
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });

  it('accounts correctly when overwriting a key', () => {
    const cache = new TileCache({ maxBytes: 1000 });
    cache.set('a', new ArrayBuffer(40));
    cache.set('a', new ArrayBuffer(10));
    expect(cache.bytes).toBe(10);
    expect(cache.size).toBe(1);
  });

  it('clears', () => {
    const cache = new TileCache();
    cache.set('a', new ArrayBuffer(8));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});

describe('EntryCache', () => {
  it('evicts the least recently used entry beyond maxEntries', () => {
    const cache = new EntryCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('refreshes recency on get', () => {
    const cache = new EntryCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // b is now the oldest
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('replaces an existing key without growing', () => {
    const cache = new EntryCache<number>(2);
    cache.set('a', 1);
    cache.set('a', 2);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(2);
  });
});

describe('RequestCoalescer', () => {
  it('runs a task once for concurrent callers', async () => {
    const coalescer = new RequestCoalescer<number>();
    const task = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 7;
    });

    const results = await Promise.all([
      coalescer.run('k', task),
      coalescer.run('k', task),
      coalescer.run('k', task),
    ]);

    expect(task).toHaveBeenCalledOnce();
    expect(results).toEqual([7, 7, 7]);
  });

  it('releases the key after completion', async () => {
    const coalescer = new RequestCoalescer<number>();
    await coalescer.run('k', async () => 1);
    expect(coalescer.pending).toBe(0);
    const task = vi.fn(async () => 2);
    expect(await coalescer.run('k', task)).toBe(2);
  });

  it('releases the key after rejection', async () => {
    const coalescer = new RequestCoalescer<number>();
    await expect(
      coalescer.run('k', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(coalescer.pending).toBe(0);
  });

  it('keeps the shared task alive when one of several callers aborts', async () => {
    const coalescer = new RequestCoalescer<number>();
    let release!: (value: number) => void;
    const gate = new Promise<number>((resolve) => (release = resolve));
    let taskSignal!: AbortSignal;
    const task = vi.fn((signal: AbortSignal) => {
      taskSignal = signal;
      return gate;
    });
    const middle = new AbortController();

    const first = coalescer.run('k', task, new AbortController().signal);
    const second = coalescer.run('k', task, middle.signal);
    const third = coalescer.run('k', task, new AbortController().signal);
    middle.abort();

    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(taskSignal.aborted).toBe(false);
    release(9);
    expect(await Promise.all([first, third])).toEqual([9, 9]);
    expect(task).toHaveBeenCalledOnce();
    expect(taskSignal.aborted).toBe(false);
  });

  it("aborts the shared task when its only caller aborts, and a dead task's settlement leaves a fresh entry alone", async () => {
    const coalescer = new RequestCoalescer<number>();
    const signals: AbortSignal[] = [];
    const releases: ((value: number) => void)[] = [];
    const rejections: ((reason: unknown) => void)[] = [];
    // The task deliberately ignores its signal, so it settles only when the test says so:
    // that is what lets the first task settle *after* the second entry exists.
    const task = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<number>((resolve, reject) => {
        releases.push(resolve);
        rejections.push(reject);
      });
    });

    const only = new AbortController();
    const first = coalescer.run('k', task, only.signal);
    only.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals[0]!.aborted).toBe(true);
    expect(coalescer.pending).toBe(0);

    const second = coalescer.run('k', task, new AbortController().signal);
    expect(task).toHaveBeenCalledTimes(2);
    expect(coalescer.pending).toBe(1);

    // The dead task settles now; its `finally` must not delete the fresh entry.
    rejections[0]!(new DOMException('aborted', 'AbortError'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(coalescer.pending).toBe(1);

    releases[1]!(5);
    expect(await second).toBe(5);
    expect(coalescer.pending).toBe(0);
  });

  it('removes the entry on settlement, so the next call is served from the value cache', async () => {
    const coalescer = new RequestCoalescer<number>();
    const values = new Map<string, number>();
    const task = vi.fn(async () => {
      values.set('k', 11);
      return 11;
    });
    // The protocol's `loadSource` pattern: value cache first, coalescer only on a miss.
    const load = (signal: AbortSignal): Promise<number> =>
      values.has('k') ? Promise.resolve(values.get('k')!) : coalescer.run('k', task, signal);

    expect(await load(new AbortController().signal)).toBe(11);
    expect(coalescer.pending).toBe(0);
    expect(await load(new AbortController().signal)).toBe(11);
    expect(task).toHaveBeenCalledOnce();
    expect(coalescer.pending).toBe(0);
  });
});

describe('protocol handler', () => {
  const tileUrl = (z: number, x: number, y: number, blend = 0) =>
    encodeSourceUrl({ url: UPSTREAM, blend })
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));

  it('passes tiles through unwarped at blend 1', async () => {
    const payload = new Uint8Array([1, 2, 3]).buffer;
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      return new Response(payload, { status: 200 });
    });
    const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await handler({ url: tileUrl(8, 3, 4, 1) }, new AbortController());

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(requested[0]).toContain('/8/3/4.pbf');
    expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('warps pure Equal Earth at any zoom — there is no switch zoom any more', async () => {
    const tile = { z: 8, x: 130, y: 126 };
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      return new Response(null, { status: 404 });
    });
    const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await handler({ url: tileUrl(tile.z, tile.x, tile.y) }, new AbortController());

    const cover = sourceTilesFor(tile).map((source) => expandTemplate(UPSTREAM, source));
    expect(cover.length).toBeGreaterThan(0);
    expect([...requested].sort()).toEqual([...cover].sort());
    expect(requested).not.toEqual([expandTemplate(UPSTREAM, tile)]);
  });

  it('returns an empty tile outside the Equal Earth world without fetching', async () => {
    const fetchImpl = vi.fn();
    const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });

    // z2/0/0 lies in the empty band above the Equal Earth world.
    const result = await handler({ url: tileUrl(2, 0, 0) }, new AbortController());

    expect(result.data.byteLength).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats 404 and 204 as an absent tile, not an error', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await handler({ url: tileUrl(0, 0, 0) }, new AbortController());
    expect(result.data.byteLength).toBe(0);
  });

  it('propagates a real upstream failure', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(handler({ url: tileUrl(0, 0, 0) }, new AbortController())).rejects.toThrow(
      /returned 500/,
    );
  });

  it('caches upstream tiles across output tiles', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await handler({ url: tileUrl(1, 0, 1) }, new AbortController());
    const afterFirst = fetchImpl.mock.calls.length;
    await handler({ url: tileUrl(1, 1, 1) }, new AbortController());

    // The two output tiles share their whole source cover at z1, so the second must
    // issue no new requests.
    expect(fetchImpl.mock.calls.length).toBe(afterFirst);
  });

  it('returns a copy at blend 1, so detaching the result leaves the cache intact', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer));
    const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const first = await handler({ url: tileUrl(8, 3, 4, 1) }, new AbortController());
    structuredClone(first.data, { transfer: [first.data] });
    const second = await handler({ url: tileUrl(8, 3, 4, 1) }, new AbortController());

    expect(first.data.byteLength).toBe(0);
    expect(second.data.byteLength).toBe(3);
  });

  /** A small MVT with one polygon covering the whole tile, in layers `a` and `b`. */
  function sourceTileBytes(): Uint8Array {
    const square = {
      type: 3 as const,
      geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]],
      tags: { kind: 'square' },
    };
    return fromGeojsonVt({ a: { features: [square] }, b: { features: [square] } }, { version: 2, extent: 4096 });
  }

  it('decodes each source tile once across bands', async () => {
    const bytes = sourceTileBytes();
    const fetchImpl = vi.fn(async () => new Response(bytes.slice()));
    const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const decode = vi.spyOn(mvt, 'decodeToGeographic');

    try {
      const tile = { z: 1, x: 0, y: 1 };
      await handler({ url: tileUrl(tile.z, tile.x, tile.y, 0) }, new AbortController());
      await handler({ url: tileUrl(tile.z, tile.x, tile.y, 1 / 3) }, new AbortController());

      const keys = (blend: number) =>
        sourceTilesFor(tile, { blend }).map((source) => expandTemplate(UPSTREAM, source));
      const union = new Set([...keys(0), ...keys(1 / 3)]);
      // The two bands share source tiles, so decoding per band would decode some twice.
      expect(keys(0).length + keys(1 / 3).length).toBeGreaterThan(union.size);
      expect(fetchImpl).toHaveBeenCalledTimes(union.size);
      expect(decode).toHaveBeenCalledTimes(union.size);
    } finally {
      decode.mockRestore();
    }
  });

  it('applies a layer filter to a cached decode', async () => {
    const bytes = sourceTileBytes();
    const fetchImpl = vi.fn(async () => new Response(bytes.slice()));
    const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const layersOf = (data: ArrayBuffer) =>
      Object.keys(new VectorTile(new PbfReader(new Uint8Array(data))).layers).sort();

    const all = await handler({ url: tileUrl(0, 0, 0) }, new AbortController());
    const onlyA = encodeSourceUrl({ url: UPSTREAM, layers: ['a'] })
      .replace('{z}', '0')
      .replace('{x}', '0')
      .replace('{y}', '0');
    const filtered = await handler({ url: onlyA }, new AbortController());

    expect(layersOf(all.data)).toEqual(['a', 'b']);
    expect(layersOf(filtered.data)).toEqual(['a']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  describe('persistent output-tile cache', () => {
    const at = (config: EqualEarthSourceConfig, { z, x, y }: TileId) =>
      encodeSourceUrl(config).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const upstream = () => vi.fn(async () => new Response(sourceTileBytes().slice()));
    const Z2: TileId = { z: 2, x: 1, y: 1 };
    const Z4: TileId = { z: 4, x: 8, y: 7 };
    const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    /** Lets the handler's fire-and-forget `put` settle. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    /** The tiles stored in a fake cache: its entries but the sweep's marker. */
    const tilesIn = (cache: { entries: Map<string, Response> } | undefined) =>
      [...(cache?.entries.keys() ?? [])].filter((key) => key !== SWEEP_MARKER_KEY).length;

    it('serves a z2 tile to a new handler from Cache Storage, without fetching upstream', async () => {
      const storage = new FakeCacheStorage();
      const config = { url: UPSTREAM, blend: 0 };
      const first = upstream();
      const cold = createEqualEarthProtocol({ fetchImpl: first as unknown as typeof fetch, cacheStorage: storage, version: 't' });
      const built = await cold({ url: at(config, Z2) }, new AbortController());
      expect(first).toHaveBeenCalled();
      expect(built.data.byteLength).toBeGreaterThan(0);
      await vi.waitFor(() => expect(storage.caches.get('equal-earth-t')?.entries.has(persistentKey(config, Z2))).toBe(true));

      const second = upstream();
      const warm = createEqualEarthProtocol({ fetchImpl: second as unknown as typeof fetch, cacheStorage: storage, version: 't' });
      const served = await warm({ url: at(config, Z2) }, new AbortController());
      expect(second).not.toHaveBeenCalled();
      expect(new Uint8Array(served.data)).toEqual(new Uint8Array(built.data));
    });

    it('never stores a tile above maxZoom, 3 by default', async () => {
      const storage = new FakeCacheStorage();
      const handler = createEqualEarthProtocol({ fetchImpl: upstream() as unknown as typeof fetch, cacheStorage: storage, version: 't' });
      await handler({ url: at({ url: UPSTREAM, blend: 0 }, Z4) }, new AbortController());
      await settle();
      expect(tilesIn(storage.caches.get('equal-earth-t'))).toBe(0);

      const raised = { url: UPSTREAM, blend: 0, persistentCache: { maxZoom: 4 } };
      await handler({ url: at(raised, Z4) }, new AbortController());
      await vi.waitFor(() => expect(storage.caches.get('equal-earth-t')?.entries.has(persistentKey(raised, Z4))).toBe(true));
    });

    it('bypasses Cache Storage with persistentCache: false', async () => {
      const storage = new FakeCacheStorage();
      const handler = createEqualEarthProtocol({ fetchImpl: upstream() as unknown as typeof fetch, cacheStorage: storage, version: 't' });
      await handler({ url: at({ url: UPSTREAM, blend: 0, persistentCache: false }, Z2) }, new AbortController());
      await settle();
      expect(storage.names()).toEqual([]);
    });

    it('does not store the Mercator pass-through (blend 1)', async () => {
      const storage = new FakeCacheStorage();
      const handler = createEqualEarthProtocol({ fetchImpl: upstream() as unknown as typeof fetch, cacheStorage: storage, version: 't' });
      await handler({ url: at({ url: UPSTREAM, blend: 1 }, Z2) }, new AbortController());
      await settle();
      expect(storage.names()).toEqual([]);
    });

    it('serves the tile when Cache Storage throws on put', async () => {
      const failing = {
        match: () => Promise.resolve(undefined),
        put: () => Promise.reject(new Error('QuotaExceededError')),
        delete: () => Promise.resolve(false),
        keys: () => Promise.resolve([]),
      };
      const storage = { open: () => Promise.resolve(failing), keys: () => Promise.resolve([]), delete: () => Promise.resolve(false) };
      const warn = vi.spyOn(console, 'warn');
      const error = vi.spyOn(console, 'error');
      try {
        const handler = createEqualEarthProtocol({ fetchImpl: upstream() as unknown as typeof fetch, cacheStorage: storage, version: 't' });
        const result = await handler({ url: at({ url: UPSTREAM, blend: 0 }, Z2) }, new AbortController());
        await settle();
        expect(result.data.byteLength).toBeGreaterThan(0);
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });

    it('names the cache after the package version and the build id of the worker sources by default (R25)', async () => {
      const storage = new FakeCacheStorage();
      const handler = createEqualEarthProtocol({ fetchImpl: upstream() as unknown as typeof fetch, cacheStorage: storage });
      await handler({ url: at({ url: UPSTREAM, blend: 0 }, Z2) }, new AbortController());
      await vi.waitFor(() => expect(storage.names()).toEqual([`equal-earth-${eqeVersion()}`]));
      expect(storage.names()[0]!.startsWith(`equal-earth-${PKG.version}+`)).toBe(true);
    });

    it('does not store an output tile whose upstream failed', async () => {
      const storage = new FakeCacheStorage();
      const failing = vi.fn(async () => new Response(null, { status: 503 }));
      const handler = createEqualEarthProtocol({ fetchImpl: failing as unknown as typeof fetch, cacheStorage: storage, version: 't' });
      await expect(handler({ url: at({ url: UPSTREAM, blend: 0 }, Z2) }, new AbortController())).rejects.toThrow(/returned 503/);
      await settle();
      expect(tilesIn(storage.caches.get('equal-earth-t'))).toBe(0);
    });

    it('rejects a tile aborted during the persistent lookup, without fetching or storing', async () => {
      let answer: ((response: Response | undefined) => void) | undefined;
      const pending = new FakeCacheStorage();
      const stored = await pending.open('equal-earth-t');
      stored.match = () => new Promise((resolve) => (answer = resolve));
      const fetchImpl = upstream();
      const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch, cacheStorage: pending, version: 't' });
      const abort = new AbortController();
      const result = handler({ url: at({ url: UPSTREAM, blend: 0 }, Z2) }, abort);
      await vi.waitFor(() => expect(answer).toBeDefined());
      abort.abort();
      answer!(undefined);
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      await settle();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(tilesIn(stored)).toBe(0);
    });

    it('round-trips a zero-length tile (every source absent) through the cache', async () => {
      const storage = new FakeCacheStorage();
      const config = { url: UPSTREAM, blend: 0 };
      const absent = vi.fn(async () => new Response(null, { status: 404 }));
      const cold = createEqualEarthProtocol({ fetchImpl: absent as unknown as typeof fetch, cacheStorage: storage, version: 't' });
      expect((await cold({ url: at(config, Z2) }, new AbortController())).data.byteLength).toBe(0);
      await vi.waitFor(() => expect(storage.caches.get('equal-earth-t')?.entries.has(persistentKey(config, Z2))).toBe(true));
      const second = vi.fn(async () => new Response(null, { status: 404 }));
      const warm = createEqualEarthProtocol({ fetchImpl: second as unknown as typeof fetch, cacheStorage: storage, version: 't' });
      expect((await warm({ url: at(config, Z2) }, new AbortController())).data.byteLength).toBe(0);
      expect(second).not.toHaveBeenCalled();
    });

    it('neither looks up nor stores with ttlDays <= 0', async () => {
      const storage = new FakeCacheStorage();
      const handler = createEqualEarthProtocol({ fetchImpl: upstream() as unknown as typeof fetch, cacheStorage: storage, version: 't' });
      for (const ttlDays of [0, -1]) {
        await handler({ url: at({ url: UPSTREAM, blend: 0, persistentCache: { ttlDays } }, Z2) }, new AbortController());
      }
      await settle();
      expect(storage.names()).toEqual([]);
    });

    it('stores a copy, so transferring the result leaves the stored tile intact', async () => {
      const storage = new FakeCacheStorage();
      const config = { url: UPSTREAM, blend: 0 };
      const handler = createEqualEarthProtocol({ fetchImpl: upstream() as unknown as typeof fetch, cacheStorage: storage, version: 't' });
      const result = await handler({ url: at(config, Z2) }, new AbortController());
      const length = result.data.byteLength;
      structuredClone(result.data, { transfer: [result.data] });
      await vi.waitFor(() => expect(storage.caches.get('equal-earth-t')?.entries.has(persistentKey(config, Z2))).toBe(true));
      const stored = await storage.caches.get('equal-earth-t')!.match(persistentKey(config, Z2));
      expect((await stored!.arrayBuffer()).byteLength).toBe(length);
    });
  });

  describe('aborts', () => {
    /** A fetch that stays pending until released, and honours `init.signal`. */
    function controllableFetch() {
      const signals: AbortSignal[] = [];
      const releases: (() => void)[] = [];
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        return new Promise<Response>((resolve, reject) => {
          releases.push(() => resolve(new Response(null, { status: 404 })));
          signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
        });
      });
      return {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signals,
        releaseAll: () => releases.forEach((release) => release()),
      };
    }

    it('does not cancel a shared source fetch when only one output tile aborts', async () => {
      const { fetchImpl, signals, releaseAll } = controllableFetch();
      const handler = createEqualEarthProtocol({ fetchImpl });
      const a = new AbortController();
      const b = new AbortController();

      // z1 output tiles 0/1 and 1/1 share all four z1 sources.
      const first = handler({ url: tileUrl(1, 0, 1) }, a);
      const second = handler({ url: tileUrl(1, 1, 1) }, b);
      a.abort();

      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);

      releaseAll();
      await expect(second).resolves.toHaveProperty('data');
    });

    it('cancels the shared fetch once every output tile has aborted', async () => {
      const { fetchImpl, signals } = controllableFetch();
      const handler = createEqualEarthProtocol({ fetchImpl });
      const a = new AbortController();
      const b = new AbortController();

      const first = handler({ url: tileUrl(1, 0, 1) }, a);
      const second = handler({ url: tileUrl(1, 1, 1) }, b);
      a.abort();
      b.abort();

      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      await expect(second).rejects.toMatchObject({ name: 'AbortError' });
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    });

    it('rejects an aborted tile whose sources are all cached, without fetching', async () => {
      const primed = vi.fn(async () => new Response(null, { status: 404 }));
      const fetchImpl = vi.fn(primed);
      const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });
      await handler({ url: tileUrl(1, 0, 1) }, new AbortController());

      fetchImpl.mockImplementation(() => {
        throw new Error('must not fetch');
      });
      const aborted = new AbortController();
      aborted.abort();

      await expect(handler({ url: tileUrl(1, 0, 1) }, aborted)).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
  });
});
