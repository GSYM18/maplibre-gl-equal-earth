/**
 * Worker-side registration of the `eqearth://` protocol.
 *
 * This file is built as a **separate bundle** and loaded into MapLibre's worker pool with
 * `importScriptInWorkers`. That placement is the single most important performance decision
 * in the tile pipeline:
 *
 * `config.REGISTERED_PROTOCOLS` is a module-level object with one instance *per realm*. A
 * handler registered on the main thread is invisible to the workers, so when a worker's
 * `VectorTileWorkerSource` requests a tile it finds no handler, and round-trips the request
 * back to the main thread via `MessageType.getResource`. Every MVT would then be decoded,
 * warped and re-encoded on the UI thread, and the bytes structured-cloned twice. Measured
 * warp cost is 100–450 ms per tile — far too much to spend there.
 *
 * Registering inside the worker keeps all of it off the UI thread and removes both clones.
 *
 * No closure crosses the worker boundary, which is why the upstream tile template and all
 * warp options travel encoded inside the tile URL itself (see `protocol.ts`).
 */

import { createEqualEarthProtocol, PROTOCOL_SCHEME, type ProtocolHandler } from './protocol.js';

/** The slice of MapLibre's worker global that we use. */
interface WorkerGlobal {
  addProtocol?: (scheme: string, handler: ProtocolHandler) => void;
  removeProtocol?: (scheme: string) => void;
}

const workerSelf = globalThis as unknown as WorkerGlobal;

if (typeof workerSelf.addProtocol === 'function') {
  workerSelf.addProtocol(PROTOCOL_SCHEME, createEqualEarthProtocol());
} else {
  // Loaded outside a MapLibre worker. Nothing registers a main-thread fallback yet, so
  // tiles will fail to load until the application registers the protocol on the main thread.
  console.warn(
    '[equal-earth] worker entry loaded but self.addProtocol is unavailable; ' +
      'tiles will fail to load until the protocol is registered on the main thread.',
  );
}
