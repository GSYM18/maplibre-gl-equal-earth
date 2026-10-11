/**
 * The `eqearth://` tile protocol.
 *
 * A style's vector source is rewritten to point at `eqearth://…/{z}/{x}/{y}`; MapLibre
 * substitutes the tile coordinates as usual and hands the URL to this handler, which fetches
 * the covering Mercator tiles from the real upstream, warps them, and returns MVT bytes.
 *
 * The upstream template travels inside the URL rather than in handler-side state, because a
 * single registered protocol has to serve every source in every style on the page, and —
 * more importantly — because the handler may be registered inside a worker, where no closure
 * from the main thread is reachable.
 */

import { TileCache, RequestCoalescer, type TileCacheOptions } from './cache.js';
import { warpTiles, type WarpTileOptions } from './mvt.js';
import { sourceTilesFor, type TileId, type TileCoverOptions } from './tile-cover.js';

export const PROTOCOL_SCHEME = 'eqearth';

/**
 * Everything the handler needs, encoded into the tile URL.
 *
 * `blend` (from both option interfaces) fixes the zoom band this source serves. Blend 1 is
 * plain Mercator and is passed through byte for byte; every lower blend warps at every zoom
 * — pure Equal Earth has no switch zoom, it simply never changes band.
 */
export interface EqualEarthSourceConfig extends TileCoverOptions, WarpTileOptions {
  /** Upstream Mercator tile template, e.g. `https://…/{z}/{x}/{y}.pbf`. */
  url: string;
}

/** Build the `tiles` entry for a rewritten source. */
export function encodeSourceUrl(config: EqualEarthSourceConfig): string {
  // Fail where the URL is built, not later in a worker when it is decoded.
  const blend: unknown = config.blend;
  if (blend !== undefined && !(typeof blend === 'number' && blend >= 0 && blend <= 1)) {
    throw new TypeError(`Equal Earth: blend ${JSON.stringify(blend)} is not a number in [0, 1].`);
  }
  return `${PROTOCOL_SCHEME}://${encodeConfig(config)}/{z}/{x}/{y}`;
}

export interface ParsedTileUrl {
  config: EqualEarthSourceConfig;
  tile: TileId;
}

/** Inverse of {@link encodeSourceUrl}, after MapLibre has substituted the coordinates. */
export function parseTileUrl(url: string): ParsedTileUrl {
  const withoutScheme = url.slice(url.indexOf('://') + 3);
  const lastSlash = withoutScheme.lastIndexOf('/');
  const secondSlash = withoutScheme.lastIndexOf('/', lastSlash - 1);
  const thirdSlash = withoutScheme.lastIndexOf('/', secondSlash - 1);

  if (lastSlash < 0 || secondSlash < 0 || thirdSlash < 0) {
    throw new Error(`Malformed ${PROTOCOL_SCHEME}:// tile URL: ${url}`);
  }

  const z = Number(withoutScheme.slice(thirdSlash + 1, secondSlash));
  const x = Number(withoutScheme.slice(secondSlash + 1, lastSlash));
  const y = Number(withoutScheme.slice(lastSlash + 1));

  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(`Malformed ${PROTOCOL_SCHEME}:// tile coordinates: ${url}`);
  }

  return { config: decodeConfig(withoutScheme.slice(0, thirdSlash)), tile: { z, x, y } };
}

/** Substitute `{z}/{x}/{y}` into an upstream template. */
export function expandTemplate(template: string, tile: TileId): string {
  return template
    .replace(/\{z\}/g, String(tile.z))
    .replace(/\{x\}/g, String(tile.x))
    .replace(/\{y\}/g, String(tile.y));
}

export interface ProtocolOptions {
  cache?: TileCacheOptions;
  /** Injectable for testing. @defaultValue global `fetch` */
  fetchImpl?: typeof fetch;
}

/**
 * Shape of MapLibre's `AddProtocolAction`, declared structurally so this module does not
 * import `maplibre-gl` — it has to be bundled into a worker script where that import would
 * pull the whole library in.
 */
export type ProtocolHandler = (
  params: { url: string },
  abortController: AbortController,
) => Promise<{ data: ArrayBuffer }>;

/** Create the protocol handler, with its own cache and in-flight request table. */
export function createEqualEarthProtocol(options: ProtocolOptions = {}): ProtocolHandler {
  const cache = new TileCache(options.cache);
  const coalescer = new RequestCoalescer<ArrayBuffer | null>();
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function loadSource(
    template: string,
    tile: TileId,
    signal: AbortSignal,
  ): Promise<ArrayBuffer | null> {
    const url = expandTemplate(template, tile);

    const cached = cache.get(url);
    if (cached !== undefined) return cached;

    return coalescer.run(url, async (sharedSignal) => {
      const response = await doFetch(url, { signal: sharedSignal });
      // 404/204 mean "no such tile", which is normal at the edges of a tileset and must
      // not fail the whole output tile.
      if (response.status === 404 || response.status === 204) {
        cache.set(url, null);
        return null;
      }
      if (!response.ok) {
        throw new Error(`Equal Earth: upstream tile ${url} returned ${response.status}`);
      }
      const data = await response.arrayBuffer();
      cache.set(url, data);
      return data;
    }, signal);
  }

  return async (params, abortController) => {
    const { config, tile } = parseTileUrl(params.url);

    // Blend 1 is plain Mercator: the upstream tile is already correct, so pass its bytes
    // through untouched rather than warping them. The polyfill routes its Mercator band to
    // the original source and never asks for this, but a hand-built URL may.
    if ((config.blend ?? 0) === 1) {
      const passthrough = await loadSource(config.url, tile, abortController.signal);
      abortController.signal.throwIfAborted();
      // A copy: the buffer is also the cache entry, and a main-thread handler's result gets
      // transferred, which would detach the cached bytes for every later request.
      return { data: passthrough ? passthrough.slice(0) : new ArrayBuffer(0) };
    }

    const sources = sourceTilesFor(tile, config);
    if (sources.length === 0) return { data: new ArrayBuffer(0) };

    const fetched = await Promise.all(
      sources.map(async (source) => ({
        tile: source,
        data: await loadSource(config.url, source, abortController.signal),
      })),
    );

    // Sources fetched for other tiles can resolve after this one was abandoned; skip the
    // 100-750 ms warp rather than compute a result nobody will read.
    abortController.signal.throwIfAborted();
    const warped = warpTiles(fetched, tile, config);
    // MapLibre treats a zero-length ArrayBuffer as a legitimately empty tile.
    return { data: toArrayBuffer(warped) };
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteLength === 0) return new ArrayBuffer(0);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/* ------------------------------------------------------------------ config codec */

/**
 * Config is base64url-encoded JSON. It has to survive being embedded in a URL path and
 * round-tripped through MapLibre's URL handling, so percent-encoding a raw JSON blob would
 * be fragile — a template containing `?`, `&` or `#` is entirely normal.
 */
function encodeConfig(config: EqualEarthSourceConfig): string {
  return base64UrlEncode(JSON.stringify(config));
}

function decodeConfig(encoded: string): EqualEarthSourceConfig {
  const parsed: unknown = JSON.parse(base64UrlDecode(encoded));
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { url?: unknown }).url !== 'string') {
    throw new Error('Equal Earth: tile URL carries no upstream template.');
  }
  // Reject rather than clamp: a blend outside [0, 1] means the URL was built wrongly, and
  // silently clamping it would render a plausible-looking but wrong map.
  const blend = (parsed as { blend?: unknown }).blend;
  if (blend !== undefined && !(typeof blend === 'number' && blend >= 0 && blend <= 1)) {
    throw new Error(`Equal Earth: tile URL carries blend ${JSON.stringify(blend)}; expected a number in [0, 1].`);
  }
  return parsed as EqualEarthSourceConfig;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '=='.slice(0, (4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
