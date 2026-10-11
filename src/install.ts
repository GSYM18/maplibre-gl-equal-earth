/**
 * `installEqualEarth(maplibregl)`: the one call an application makes (spec §3 components, §6,
 * §8). It checks the MapLibre version, sizes the worker pool, loads the worker bundle that
 * registers the `eqearth://` protocol, and polyfills `Map.prototype.setProjection` and
 * `getProjection` so that an application writes `map.setProjection({ type: 'equal' })`.
 *
 * Call it **before creating any map**: MapLibre sizes its worker pool when the first map is
 * created, so `setWorkerCount` is ignored afterwards, and `importScriptInWorkers` reaches only
 * the workers of the shared pool.
 *
 * The module is passed in rather than imported, so this file has no runtime dependency on
 * `maplibre-gl` and works with whichever major (5.24+ or 6) the application loaded.
 */

import {
  EqualEarthController,
  SUPERSEDED_ERROR_NAME,
  reportError,
  type ControllerHost,
  type ControllerOptions,
} from './map/controller.js';
import type { Transition } from './map/bands.js';
import type { CompensationMode } from './math/jacobian.js';
import { PROTOCOL_SCHEME, createEqualEarthProtocol } from './tiles/protocol.js';

/** The parts of the `maplibre-gl` module the install touches. */
export interface MapLibreModule {
  getVersion(): string;
  importScriptInWorkers(url: string): Promise<unknown>;
  addProtocol(scheme: string, handler: unknown): unknown;
  getWorkerCount(): number;
  setWorkerCount(count: number): void;
  LngLat: new (lng: number, lat: number) => { lng: number; lat: number };
  Map: { prototype: { setProjection(projection: unknown): unknown; getProjection(): unknown } };
}

export interface InstallOptions {
  /**
   * URL of the worker bundle. Defaults to `worker.mjs` (v6, loaded with `import()`) or
   * `worker.iife.js` (v5, `importScripts`) next to this module; pass it when a bundler moves
   * the files apart.
   */
  workerUrl?: string | URL;
  /**
   * Worker pool size. MapLibre's default is 1, which serialises every tile warp; when the
   * count is still 1 it is raised to `clamp(hardwareConcurrency / 2, 2, 4)`, or to this number.
   * An application that set its own count keeps it. `false` leaves the pool alone.
   */
  workers?: number | false;
  transition?: Transition;
  compensation?: CompensationMode;
  fetchJson?: ControllerOptions['fetchJson'];
  onSwitch?: ControllerOptions['onSwitch'];
}

export interface EqualEarthInstall {
  /** The MapLibre version found. */
  readonly version: string;
  /** Where tiles are warped: the worker pool, or the main thread if the worker bundle failed to load. */
  readonly workerPath: 'worker' | 'main-thread';
  /** The controller of a map, created on first use. */
  controllerFor(map: ControllerHost): EqualEarthController;
  /** Restore the prototype methods (if still ours) and deactivate every controller. */
  uninstall(): void;
}

/** `"6.6.0"` → `{ major: 6, minor: 6 }`; pre-release suffixes are ignored. */
export function parseVersion(version: string): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Equal Earth: cannot read the maplibre-gl version "${version}".`);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

const EQUAL_EARTH_TYPES = new Set(['equal', 'equal-earth']);

function defaultWorkerCount(): number {
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;
  return Math.max(2, Math.min(4, Math.floor((cores ?? 4) / 2)));
}

export async function installEqualEarth(
  maplibregl: MapLibreModule,
  options: InstallOptions = {},
): Promise<EqualEarthInstall> {
  const version = maplibregl.getVersion();
  const { major, minor } = parseVersion(version);
  if (major < 5 || (major === 5 && minor < 24)) {
    throw new Error(`Equal Earth needs maplibre-gl >= 5.24; found ${version}.`);
  }

  if (options.workers !== false && maplibregl.getWorkerCount() === 1) {
    maplibregl.setWorkerCount(options.workers ?? defaultWorkerCount());
  }

  // v6 loads worker scripts with `import()`, v5 with `importScripts`: each needs its own bundle.
  // Literal `new URL(…, import.meta.url)` in each branch, so the application's bundler emits
  // the files (P15). `@vite-ignore` only stops *our* library build from rewriting the second
  // argument (the files do not exist yet when it runs); `check-worker-bundles.mjs` guards it.
  const workerUrl =
    options.workerUrl ??
    (major >= 6
      ? new URL(/* @vite-ignore */ './worker.mjs', import.meta.url)
      : new URL(/* @vite-ignore */ './worker.iife.js', import.meta.url));
  let workerPath: EqualEarthInstall['workerPath'] = 'worker';
  try {
    await maplibregl.importScriptInWorkers(String(workerUrl));
  } catch (error) {
    // Without the worker bundle the workers find no `eqearth` handler and send each request
    // back to the main thread, where this one serves it: correct, but every warp then runs on
    // the UI thread.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[equal-earth] worker script failed to load (${reason}); warping tiles on the main thread.`,
    );
    maplibregl.addProtocol(PROTOCOL_SCHEME, createEqualEarthProtocol());
    workerPath = 'main-thread';
  }

  const controllerOptions: ControllerOptions = {
    lngLatFactory: (lng, lat) => new maplibregl.LngLat(lng, lat),
    ...(options.transition ? { transition: options.transition } : {}),
    ...(options.compensation ? { compensation: options.compensation } : {}),
    ...(options.fetchJson ? { fetchJson: options.fetchJson } : {}),
    ...(options.onSwitch ? { onSwitch: options.onSwitch } : {}),
  };
  const controllers = new WeakMap<object, EqualEarthController>();
  const live = new Set<EqualEarthController>();
  const controllerFor = (map: ControllerHost): EqualEarthController => {
    let controller = controllers.get(map);
    if (!controller) {
      const created = new EqualEarthController(map, controllerOptions);
      controller = created;
      controllers.set(map, created);
      live.add(created);
      // A removed map must not be kept alive, nor have its style restored on `uninstall`.
      if (typeof map.once === 'function') {
        map.once('remove', () => {
          controllers.delete(map);
          live.delete(created);
          created.dispose();
        });
      }
    }
    return controller;
  };

  const report = (map: ControllerHost, error: unknown): void => {
    // A later setProjection overtook this one: not an error the application needs to see.
    if (error instanceof Error && error.name === SUPERSEDED_ERROR_NAME) return;
    reportError(map, error);
  };

  const proto = maplibregl.Map.prototype;
  // Kept unbound on purpose: they are prototype methods, called below with each map as `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalSet = proto.setProjection;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalGet = proto.getProjection;

  /** MapLibre's own `getProjection`, which throws on a map without a style. */
  const currentType = (map: ControllerHost): unknown => {
    try {
      return (originalGet.call(map) as { type?: unknown } | null | undefined)?.type;
    } catch {
      return undefined;
    }
  };

  const setProjection = function (this: ControllerHost, projection: unknown): unknown {
    const type = (projection as { type?: unknown } | null | undefined)?.type;
    if (typeof type === 'string' && EQUAL_EARTH_TYPES.has(type)) {
      // Equal Earth is drawn by the Mercator renderer; under globe the warped coordinates would
      // render as a distorted sphere.
      const current = currentType(this);
      if (current !== undefined && current !== 'mercator') {
        originalSet.call(this, { type: 'mercator' });
      }
      controllerFor(this)
        .activate(type as 'equal' | 'equal-earth')
        .catch((error: unknown) => report(this, error));
      return this;
    }
    // Synchronous in effect: the original style is back before MapLibre's projection changes.
    controllers
      .get(this)
      ?.deactivate()
      .catch((error: unknown) => report(this, error));
    return originalSet.call(this, projection);
  };

  const getProjection = function (this: ControllerHost): unknown {
    const projection = controllers.get(this)?.projection;
    return projection ? { type: projection } : originalGet.call(this);
  };

  proto.setProjection = setProjection;
  proto.getProjection = getProjection;

  return {
    version,
    workerPath,
    controllerFor,
    uninstall: () => {
      if (proto.setProjection === setProjection) proto.setProjection = originalSet;
      if (proto.getProjection === getProjection) proto.getProjection = originalGet;
      for (const controller of live) {
        controller.destroy().catch((error: unknown) => console.error(error));
      }
      live.clear();
    },
  };
}
