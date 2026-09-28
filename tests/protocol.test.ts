import { describe, expect, it, vi } from 'vitest';

import { RequestCoalescer, TileCache } from '../src/tiles/cache.js';
import { sourceTilesFor } from '../src/tiles/tile-cover.js';
import {
  createEqualEarthProtocol,
  encodeSourceUrl,
  expandTemplate,
  parseTileUrl,
  PROTOCOL_SCHEME,
} from '../src/tiles/protocol.js';

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
});
