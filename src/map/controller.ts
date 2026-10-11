/**
 * One map's Equal Earth lifecycle: the integration of the style rewrite, the band switcher,
 * the band camera and the world constraint (spec §3, §4).
 *
 * `activate` rewrites the map's style into its banded form, installs the switcher, the camera
 * hook and the constraint, turns off world copies and moves the centre into the initial band's
 * map space; `deactivate` undoes all of it. While active, the controller also follows the
 * application's own `setStyle`: a style without the rewrite's metadata becomes the new original
 * and is rewritten in turn.
 *
 * **MapLibre's style events** (v6 `src/`, v5 alike) decide the ordering:
 *
 * - A diffed `setStyle` swaps the style synchronously and fires `style.load` *inside the call*
 *   (`Style.setState`, `style/style.ts:870`). `styledata` follows only on the next render
 *   (`Style.update`, `style.ts:784`), and `_render` runs the camera frames — our hook, hence the
 *   switcher — *before* that (`ui/map.ts:4250`, `4279`).
 * - A full rebuild (`diff: false`, or a diff MapLibre cannot apply) fires `styledataloading`
 *   inside the call (`Style.loadJSON`, `style.ts:452`); the style is unloaded, and
 *   `setPaintProperty` throws, until `styledata` and `style.load` fire a frame or more later.
 *
 * So (C7) the switcher, camera and constraint are torn down synchronously on the application's
 * `styledataloading` or `style.load`, before any frame can run against a style without band
 * sources, and re-installed only once our rewritten style's `style.load` has fired. `styledata`,
 * which fires on every paint or filter change, is not listened to while active: the style is
 * read (a full serialisation) only on a swap.
 *
 * **TileJSON.** A vector source given by `url` is resolved with plain `fetch`, which bypasses
 * MapLibre's `transformRequest`; relative tile URLs inside a TileJSON are not resolved against
 * it. Pass `fetchJson` for authenticated endpoints, PMTiles and the like. TMS sources are not
 * supported yet.
 *
 * Like every `map/` module this has no runtime dependency on `maplibre-gl`; the host is typed
 * structurally ({@link ControllerHost}).
 */

import { geographicToMap, wrapLongitude } from '../math/backproject.js';
import type { LngLatTuple } from '../math/equal-earth.js';
import { similarityOffsets, type CompensationMode, type SimilarityOffsets } from '../math/jacobian.js';
import {
  EQUAL_EARTH_BANDS,
  bandIndexForZoom,
  continuousBlend,
  parseRange,
  resolveTransition,
  type Band,
  type ResolvedTransition,
  type Transition,
} from './bands.js';
import type { CartographyOptions } from './cartography.js';
import { BandCamera, type CameraHost, type LngLatFactory } from './camera.js';
import { installEqualEarthConstrain, type ConstrainHost } from './constrain.js';
import {
  geographicUnder,
  installGeoApi,
  markMapSpace,
  rawCamera,
  type GeoApi,
  type GeoApiHost,
  type GeoApiState,
  type GeoCameraMethods,
  type RawCamera,
} from './geo-api.js';
import {
  REWRITTEN_METADATA_KEY,
  restorableStyle,
  rewriteStyle,
  withoutRewriteBounds,
  type SourceTemplate,
  type StyleLike,
} from './style-rewrite.js';
import { BandSwitcher, type SwitchEvent, type SwitcherHost } from './switcher.js';

/** The projection types the plugin adds: adaptive (`equal`) and pure Equal Earth. */
export type EqualEarthProjection = 'equal' | 'equal-earth';

/**
 * A style as a map's `getStyle()` returns it. As {@link StyleLike}, except that MapLibre types
 * `metadata` as `unknown`; the controller reads it defensively.
 */
export interface HostStyle {
  version: number;
  sources: StyleLike['sources'];
  layers: StyleLike['layers'];
  metadata?: unknown;
  [key: string]: unknown;
}

/**
 * The bits of a MapLibre `Map` (v5 or v6) the controller touches. `tests/host-types.test.ts`
 * checks that real maps of both majors satisfy it.
 */
export interface ControllerHost extends CameraHost, ConstrainHost, SwitcherHost, Partial<GeoCameraMethods> {
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
  once(type: string, listener: () => void): unknown;
  jumpTo(options: { center?: { lng: number; lat: number }; zoom?: number; bearing?: number }): unknown;
  /** `undefined` (or a throw) while the style is not loaded: MapLibre's `serialize`. */
  getStyle(): HostStyle | undefined;
  /** MapLibre's also takes a URL or `null`; the controller passes only style objects. */
  setStyle(style: HostStyle | string | null, options?: { diff?: boolean }): unknown;
  getCenter(): { lng: number; lat: number };
  /** Wrapped by the geographic API where present (both majors have it). */
  project?(lngLat: unknown): { x: number; y: number };
  /** Wrapped by the geographic API where present (both majors have it). */
  unproject?(point: unknown): { lng: number; lat: number };
  /** Wrapped by the geographic API where present (both majors have it). */
  getBounds?(): unknown;
  getBearing(): number;
  getRenderWorldCopies(): boolean;
  setRenderWorldCopies(value: boolean): unknown;
  fire?(event: unknown, properties?: object): unknown;
  /** Both majors: whether anything listens for an event type (`Evented.listens`). */
  listens?(type: string): boolean;
}

/**
 * The options of one map's controller other than the geographic API's ({@link ControllerOptions}).
 * The cartography options (spec §5) are those of {@link CartographyOptions}: `outsideColor`,
 * `outline` and `graticule`.
 */
export interface ControllerBaseOptions extends CartographyOptions {
  /** Builds the centre objects handed to MapLibre. Pass `(lng, lat) => new maplibregl.LngLat(lng, lat)`. */
  lngLatFactory: LngLatFactory;
  /** The `equal` transition (spec §3). */
  transition?: Transition;
  /** What the camera absorbs of each step (spec §4.2). @defaultValue `'zoom+bearing'` */
  compensation?: CompensationMode;
  /**
   * Fetches a vector source's TileJSON.
   *
   * @defaultValue plain `fetch(url)` and `.json()`: no `transformRequest`, no credentials, and
   * relative tile URLs in the TileJSON are not resolved. Pass your own for auth or PMTiles.
   */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Called on every band switch. */
  onSwitch?: (event: SwitchEvent) => void;
}

/** Builds the bounds the geographic `getBounds()` returns. */
export type LngLatBoundsFactory = (sw: LngLatTuple, ne: LngLatTuple) => unknown;

/**
 * Options of one map's controller: {@link ControllerBaseOptions} plus the geographic API's.
 *
 * `geographicApi` (default `true`): whether the map's reads (`project`, `unproject`,
 * `getCenter`, `getBounds`) and camera targets (`jumpTo`, `easeTo`, `flyTo`, `setCenter`,
 * `panTo`, `cameraForBounds`, `fitBounds`, and `center`/`around` in the options of `panBy`,
 * `zoomTo`, `zoomIn`, `zoomOut`, `rotateTo`, `resetNorth`, `resetNorthPitch`, `snapToNorth`)
 * speak geographic coordinates while Equal Earth is active (spec §7). They are wrapped on the
 * map instance at its first activation and restored by `destroy()`/`dispose()`; `false` wraps
 * nothing, and those methods then speak the map space the renderer is fed.
 *
 * `lngLatBoundsFactory` builds the bounds `getBounds()` returns while active: pass
 * `(sw, ne) => new maplibregl.LngLatBounds(sw, ne)`. Like `lngLatFactory` it is required, unless
 * `geographicApi` is `false`: MapLibre's `getBounds` returns a `LngLatBounds`, so the wrapped one
 * must as well. The constructor throws without it.
 */
export type ControllerOptions = ControllerBaseOptions &
  (
    | { geographicApi?: true; lngLatBoundsFactory: LngLatBoundsFactory }
    | { geographicApi: false; lngLatBoundsFactory?: LngLatBoundsFactory }
  );

/** The camera, geographically: what survives a teardown and is restored after it. */
interface View {
  geographic: LngLatTuple;
  zoom: number;
  bearing: number;
  /** Blend of the space the map's centre is in while nothing is installed. */
  blend: number;
}

/** Everything installed on the map while a rewritten style is live. */
interface Installed {
  switcher: BandSwitcher;
  camera: BandCamera;
  uninstallConstrain: () => void;
}

/** The name of the error an activation rejects with when a later call superseded it. */
export const SUPERSEDED_ERROR_NAME = 'EqualEarthSupersededError';

const NO_OFFSETS: SimilarityOffsets = { deltaZoom: 0, deltaBearing: 0 };

const UNWARPED_TYPES: ReadonlySet<string> = new Set(['raster', 'hillshade', 'color-relief']);
let reliefAnnounced = false;

/**
 * Raster, hillshade and color-relief layers are not warped (spec §1): they are shown in the
 * Mercator band only. Say so once per page, so the missing basemap is not mistaken for a bug.
 */
function announceUnwarpedRelief(original: StyleLike, transition: ResolvedTransition | null): void {
  if (reliefAnnounced || !original.layers.some((layer) => UNWARPED_TYPES.has(layer.type))) return;
  reliefAnnounced = true;
  const where = transition
    ? `they are shown only in the Mercator band (from z${parseRange(transition, transition.steps)[0].toFixed(1)}), and hidden under pure Equal Earth.`
    : 'they are hidden under pure Equal Earth.';
  console.info(`[equal-earth] raster, hillshade and color-relief layers are not warped: ${where}`);
}

function superseded(): Error {
  const error = new Error('Equal Earth: activation superseded');
  error.name = SUPERSEDED_ERROR_NAME;
  return error;
}

/**
 * Report an error on the map. `Evented.fire` logs an unheard error only when it is an
 * `ErrorEvent` instance (v6 `util/evented.ts:193`), which this module cannot construct, so a
 * plain error event is fired only when something listens; otherwise it goes to the console.
 */
export function reportError(host: Pick<ControllerHost, 'fire' | 'listens'>, error: unknown): void {
  if (typeof host.fire === 'function' && typeof host.listens === 'function' && host.listens('error')) {
    host.fire({ type: 'error', error });
  } else {
    console.error(error);
  }
}

const defaultFetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const hasOurMetadata = (style: StyleLike | undefined): boolean =>
  style?.metadata?.[REWRITTEN_METADATA_KEY] !== undefined;

/**
 * Owns the Equal Earth state of one map.
 *
 * Every camera change the controller makes is a single `jumpTo` with an explicit centre, zoom
 * and bearing; on activation it runs right after the camera is installed, so it both moves the
 * centre into band space and settles the first frame's compensation offsets (it fires
 * `movestart`/`moveend` like any camera change).
 *
 * The rewritten style always uses MapLibre's Mercator projection (the warp feeds the Mercator
 * renderer); the original keeps its own, and `deactivate` restores it.
 */
export class EqualEarthController {
  readonly #host: ControllerHost;
  readonly #options: ControllerOptions;
  readonly #fetchJson: (url: string) => Promise<unknown>;
  /** Resolved TileJSONs by URL: a re-apply after the application's `setStyle` does not refetch. */
  readonly #tileJson = new Map<string, SourceTemplate & { tms?: boolean }>();

  #projection: EqualEarthProjection | undefined;
  #bands: readonly Band[] = EQUAL_EARTH_BANDS;
  #transition: ResolvedTransition | null = null;
  /** The style to restore: the application's, never a rewritten one. */
  #original: StyleLike | undefined;
  /**
   * The rewritten style we last set, until it is restored away: the base MapLibre diffs the
   * application's next style against, whose in-place zoom bounds that style may inherit.
   */
  #rewritten: StyleLike | undefined;
  #installed: Installed | undefined;
  /** The camera while nothing is installed (during an apply). */
  #view: View | undefined;
  /** `renderWorldCopies` before activation; `undefined` until it has been turned off. */
  #worldCopies: boolean | undefined;
  /**
   * Bumped by every activate, re-apply and deactivate ({@link #nextGeneration}): a stale async
   * apply abandons itself.
   */
  #generation = 0;
  /**
   * Releases the waits for a map event that may never come (a rebuild that `remove()` or another
   * `setStyle` aborted, M2), so the waiting apply wakes, sees a new generation and gives up.
   */
  readonly #eventWaits = new Set<() => void>();
  #pending: { type: EqualEarthProjection; promise: Promise<void> } | undefined;
  /** True while our own `setStyle` runs: its style events are not the application's. */
  #applying = false;
  /** Generation of the `#apply` in progress, if any. */
  #inFlight: number | undefined;
  /** Activations waiting for a re-apply that took them over (M3). */
  #waiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  #destroyed = false;
  /**
   * MapLibre's own `getCenter`/`jumpTo`, unconverted: every camera read and write the controller
   * makes is in map space.
   */
  #raw: RawCamera;
  /** The geographic API's wrappers, once installed (the first activation). */
  #geoApi: GeoApi | undefined;

  constructor(host: ControllerHost, options: ControllerOptions) {
    this.#host = host;
    this.#options = options;
    this.#fetchJson = options.fetchJson ?? defaultFetchJson;
    if (options.geographicApi !== false && typeof options.lngLatBoundsFactory !== 'function') {
      throw new TypeError(
        'EqualEarthController: lngLatBoundsFactory is required unless geographicApi is false; pass (sw, ne) => new maplibregl.LngLatBounds(sw, ne).',
      );
    }
    this.#raw = rawCamera(host as GeoApiHost);
  }

  get active(): boolean {
    return this.#projection !== undefined;
  }

  get projection(): EqualEarthProjection | undefined {
    return this.#projection;
  }

  /** The type an activation still in flight will show; `undefined` when none is. */
  get pendingProjection(): EqualEarthProjection | undefined {
    return this.#pending?.type;
  }

  /** Blend of the band shown now; 1 (Mercator, i.e. geographic) while inactive. */
  get blend(): number {
    if (!this.active) return 1;
    return this.#installed ? this.#installed.camera.blend : (this.#view?.blend ?? 1);
  }

  /**
   * Blend of the band the requested camera state is in (`BandCamera.baselineBand`): what a
   * camera target converts with. {@link blend} while nothing is installed.
   */
  get baselineBlend(): number {
    const installed = this.#installed;
    return installed ? this.#bands[installed.camera.baselineBand]!.blend : this.blend;
  }

  /** The offsets the requested camera state carries (`BandCamera.baselineOffsets`); zero while nothing is installed. */
  get baselineOffsets(): SimilarityOffsets {
    return this.#installed?.camera.baselineOffsets ?? NO_OFFSETS;
  }

  /**
   * The zoom and bearing offsets the camera hook renders band `band` with at `geographic` for
   * the requested zoom `requestedZoom`: what `BandCamera` computes from the compensation it was
   * given (spec §4.2). Zero without compensation (`'none'`, `equal-earth`) and while inactive.
   */
  offsetsAt(geographic: LngLatTuple, band: number, requestedZoom: number): SimilarityOffsets {
    const mode = this.#options.compensation ?? 'zoom+bearing';
    const transition = this.#transition;
    const blend = this.#bands[band]?.blend;
    if (!this.active || !transition || mode === 'none' || blend === undefined) return NO_OFFSETS;
    return similarityOffsets(geographic, blend, continuousBlend(transition, requestedZoom), mode);
  }

  /** The bands of the type shown (or last shown); {@link EQUAL_EARTH_BANDS} before that. */
  get bands(): readonly Band[] {
    return this.#bands;
  }

  /**
   * The zoom the application asked for: the rendered `getZoom()` minus the band's compensation
   * offset (spec §4.2). `getZoom()` itself while inactive; during a re-apply, the zoom captured
   * when the camera was torn down.
   */
  get requestedZoom(): number {
    if (this.#installed) return this.#installed.camera.requestedZoom;
    return this.active && this.#view ? this.#view.zoom : this.#host.getZoom();
  }

  /** A geographic position in the map space of the band shown now. */
  toMapSpace(lngLat: LngLatTuple): LngLatTuple {
    return this.active ? geographicToMap(lngLat, this.blend) : [lngLat[0], lngLat[1]];
  }

  /**
   * A map-space position of the band shown now, geographically. A position outside the world is
   * first brought onto its outline, so the result is always finite with |lat| ≤ 90.
   *
   * With the geographic API on, `project`, `unproject`, `getCenter` and `getBounds` already
   * convert; this and {@link toMapSpace} remain for the map-space values they do not cover,
   * such as `queryRenderedFeatures` geometry and `getStyle()` contents.
   */
  toGeographic(lngLat: LngLatTuple): LngLatTuple {
    return this.active ? geographicUnder(lngLat, this.blend) : [lngLat[0], lngLat[1]];
  }

  /**
   * Show `type`. Resolves once the rewritten style is live and the camera is in band space.
   *
   * Rejects when a TileJSON cannot be resolved or a source uses TMS (the map is then
   * untouched), and with an error named {@link SUPERSEDED_ERROR_NAME} when a later
   * `activate`/`deactivate` overtook it. When the application sets a style of its own while
   * this is pending, the activation starts again from that style (or, once committed, waits for
   * the re-apply it triggers). A type switch (`equal` ↔ `equal-earth`) that fails before it
   * commits leaves the old type showing; one that fails after the old type was torn down leaves
   * Equal Earth off, with the original style restored.
   */
  activate(type: EqualEarthProjection): Promise<void> {
    if (this.#destroyed) return Promise.reject(new Error('Equal Earth: this controller was destroyed.'));
    this.#installGeoApi();
    if (this.#pending?.type === type) return this.#pending.promise;
    if (this.#projection === type && !this.#pending) return Promise.resolve();
    const generation = this.#nextGeneration();
    const promise = this.#activate(type, generation).finally(() => {
      if (this.#pending?.promise === promise) this.#pending = undefined;
    });
    this.#pending = { type, promise };
    return promise;
  }

  /**
   * Undo everything. Synchronous in effect: by the time it returns, the original style is set
   * and the camera is back in geographic space, so a caller may switch MapLibre's own
   * projection right after it.
   */
  deactivate(): Promise<void> {
    try {
      this.#deactivateNow();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async destroy(): Promise<void> {
    await this.deactivate();
    this.#release();
  }

  /**
   * The map was removed: forget it without touching it (no `setStyle` on a dead map). Pending
   * timers are cancelled; anything still in flight abandons itself.
   */
  dispose(): void {
    this.#nextGeneration();
    this.#pending = undefined;
    this.#settle(superseded());
    const installed = this.#installed;
    this.#installed = undefined;
    if (installed) {
      installed.switcher.destroy();
      installed.camera.destroy();
      installed.uninstallConstrain();
    }
    this.#projection = undefined;
    this.#view = undefined;
    this.#unsubscribe(); // `off` only: the map's state is not touched
    this.#release();
  }

  /**
   * Wrap the map's reads, once, at the first activation: a map that never shows Equal Earth is
   * never touched, even when its controller exists. They pass through while inactive.
   */
  #installGeoApi(): void {
    if (this.#geoApi || this.#options.geographicApi === false) return;
    const read = {
      active: () => this.active,
      blend: () => this.blend,
      baselineBlend: () => this.baselineBlend,
      bands: () => this.bands,
      baselineOffsets: () => this.baselineOffsets,
    };
    const state: GeoApiState = {
      get active() {
        return read.active();
      },
      get blend() {
        return read.blend();
      },
      get baselineBlend() {
        return read.baselineBlend();
      },
      get bands() {
        return read.bands();
      },
      get baselineOffsets() {
        return read.baselineOffsets();
      },
      offsets: (geographic, band, requestedZoom) => this.offsetsAt(geographic, band, requestedZoom),
    };
    const { lngLatFactory, lngLatBoundsFactory } = this.#options;
    if (!lngLatBoundsFactory) return; // the constructor guarantees it while geographicApi is on
    this.#geoApi = installGeoApi(this.#host as GeoApiHost, state, {
      lngLat: lngLatFactory,
      lngLatBounds: lngLatBoundsFactory,
    });
    this.#raw = this.#geoApi.raw;
  }

  #release(): void {
    this.#geoApi?.uninstall();
    this.#geoApi = undefined;
    this.#destroyed = true;
    this.#original = undefined;
    this.#rewritten = undefined;
    this.#tileJson.clear();
  }

  #deactivateNow(): void {
    this.#nextGeneration();
    this.#pending = undefined;
    this.#settle(superseded());
    if (!this.active) return;
    const view = this.#detach();
    const original = this.#original;
    this.#projection = undefined;
    this.#unsubscribe();
    if (original) this.#setStyle(restorableStyle(original, this.#readStyle()));
    this.#rewritten = undefined;
    this.#finishDeactivate(view);
  }

  async #activate(type: EqualEarthProjection, generation: number): Promise<void> {
    let original: StyleLike;
    let templates: Record<string, SourceTemplate>;
    try {
      for (;;) {
        // 1. A loaded style.
        let style = this.#readStyle();
        while (!style) {
          await this.#nextEvent('styledata').done;
          if (generation !== this.#generation) throw superseded();
          style = this.#readStyle();
        }
        // 2. The original: the previously captured one if this style is already ours.
        original = hasOurMetadata(style) && this.#original ? this.#original : this.#capture(style);
        // 4. Templates; a failure rejects before anything on the map has changed. A style set
        // meanwhile (I3, N2) restarts from step 1: every swap fires `styledataloading` or
        // `style.load`, so listening suffices and nothing is serialised to compare.
        let changed = false;
        const onChange = (): void => {
          changed = true;
        };
        this.#host.on('styledataloading', onChange);
        this.#host.on('style.load', onChange);
        try {
          templates = await this.#templates(original);
        } finally {
          this.#host.off('styledataloading', onChange);
          this.#host.off('style.load', onChange);
        }
        if (generation !== this.#generation) throw superseded();
        if (!changed) break;
      }
    } catch (error) {
      // N3: a type switch deferred a style the application set meanwhile (`#onStyleLoad`);
      // failing before it commits, it leaves the old type installed on that style. An apply
      // of an older generation still in flight is stale and will install nothing.
      if (
        !(error instanceof Error && error.name === SUPERSEDED_ERROR_NAME) &&
        this.active &&
        !this.#installed &&
        this.#inFlight !== this.#generation
      ) {
        this.#reapply();
      }
      throw error;
    }
    // 3. Bands.
    const transition = type === 'equal' ? resolveTransition(this.#options.transition) : null;
    const bands = transition ? transition.bands : EQUAL_EARTH_BANDS;

    // Commit. Switching type while active starts from the camera the old type showed.
    if (this.active) {
      this.#view = this.#detach();
    } else {
      // With world copies on, the centre may sit on a copy (lng 400); off the outline, the
      // conversion would extrapolate into the empty corner.
      const center = this.#raw.getCenter();
      this.#view = {
        geographic: [wrapLongitude(center.lng), center.lat],
        zoom: this.#host.getZoom(),
        bearing: this.#host.getBearing(),
        blend: 1,
      };
      this.#host.on('styledataloading', this.#onStyleLoading);
      this.#host.on('style.load', this.#onStyleLoad);
    }
    this.#original = original;
    this.#projection = type;
    this.#bands = bands;
    this.#transition = transition;
    let applied: boolean;
    try {
      applied = await this.#apply(generation, templates);
    } catch (error) {
      if (generation === this.#generation) this.#abandon(error);
      throw error;
    }
    if (applied) return;
    // A re-apply (the application's own `setStyle`, or a rebuild of ours) took over: if it is
    // still this type, resolve once it has installed, and fail if it fails (M3).
    if (!(this.#pending?.type === type && this.#projection === type)) throw superseded();
    await this.#whenInstalled();
    if (this.#projection !== type) throw superseded();
  }

  #nextGeneration(): number {
    this.#generation++;
    const waits = [...this.#eventWaits];
    this.#eventWaits.clear();
    for (const release of waits) release();
    return this.#generation;
  }

  /**
   * The host's next `type` event. `done` resolves on it, or when the generation changes,
   * whichever comes first (the caller checks which); `fired` says synchronously whether the
   * event came; `cancel` stops listening without resolving.
   */
  #nextEvent(type: string): { done: Promise<void>; fired: () => boolean; cancel: () => void } {
    let fired = false;
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const cancel = (): void => {
      this.#host.off(type, onEvent);
      this.#eventWaits.delete(release);
    };
    const release = (): void => {
      cancel();
      resolve();
    };
    const onEvent = (): void => {
      fired = true;
      release();
    };
    this.#eventWaits.add(release);
    this.#host.once(type, onEvent);
    return { done, fired: () => fired, cancel };
  }

  #whenInstalled(): Promise<void> {
    if (this.#installed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  /** Release the activations waiting for a re-apply: resolved on install, else rejected. */
  #settle(error?: unknown): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) {
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  }

  /** Re-apply {@link #original} with the current type; on failure turn off and report. */
  #reapply(): void {
    const generation = this.#nextGeneration();
    this.#apply(generation).catch((error: unknown) => {
      if (generation !== this.#generation) return;
      this.#abandon(error);
      reportError(this.#host, error);
    });
  }

  /**
   * Rewrite {@link #original}, set it, wait for it to load, then install the switcher, the
   * camera and the constraint and move the camera into the initial band (steps 5–8). Expects
   * nothing installed and {@link #view} set. Resolves `false` when superseded.
   */
  async #apply(generation: number, templates?: Record<string, SourceTemplate>): Promise<boolean> {
    this.#inFlight = generation;
    try {
      return await this.#applyNow(generation, templates);
    } finally {
      if (this.#inFlight === generation) this.#inFlight = undefined;
    }
  }

  #cartography(): CartographyOptions {
    const { outsideColor, outline, graticule } = this.#options;
    return {
      ...(outsideColor === undefined ? {} : { outsideColor }),
      ...(outline === undefined ? {} : { outline }),
      ...(graticule === undefined ? {} : { graticule }),
    };
  }

  async #applyNow(generation: number, templates?: Record<string, SourceTemplate>): Promise<boolean> {
    const original = this.#original!;
    templates ??= await this.#templates(original);
    if (generation !== this.#generation) return false;

    const view = this.#view!;
    const bands = this.#bands;
    const transition = this.#transition;
    const initialBand = bandIndexForZoom(bands, view.zoom);
    const rewritten = rewriteStyle(original, {
      bands,
      transition,
      templates,
      initialZoom: view.zoom,
      cartography: this.#cartography(),
    });
    // I4: the warp feeds MapLibre's Mercator renderer; an original globe would bend it.
    rewritten.style.projection = { type: 'mercator' };

    // C7: install only once the rewritten style has loaded. Listen first: on the diff path
    // `style.load` fires inside `setStyle`; on a full rebuild a frame or more later, or never
    // when the rebuild is aborted, in which case the generation has moved on (M2).
    const styleLoad = this.#nextEvent('style.load');
    this.#rewritten = rewritten.style;
    this.#setStyle(rewritten.style);
    if (!styleLoad.fired()) {
      const current = this.#readStyle();
      if (current) {
        // Loaded without a `style.load`: either MapLibre found nothing to change (the style is
        // already ours), or it rejected the style (validation errors are `error` events and
        // leave the old style in place).
        styleLoad.cancel();
        if (!hasOurMetadata(current)) {
          throw new Error('Equal Earth: the map did not accept the rewritten style.');
        }
      } else {
        await styleLoad.done;
      }
    }
    if (generation !== this.#generation) return false;
    // Re-entrancy: an application `style.load` listener may have set a style of its own inside
    // our `setStyle`, whose events `#applying` hid. Never install over it: apply again from
    // that style, under the caller's generation, so a failure still reaches the owner that
    // abandons and reports.
    const live = this.#readStyle();
    if (!hasOurMetadata(live)) {
      if (!live) return false; // a rebuild: its `style.load` re-applies (`#onStyleLoad`)
      this.#original = this.#capture(live);
      return this.#applyNow(generation);
    }

    const host = this.#host;
    const { lngLatFactory, onSwitch } = this.#options;
    let camera: BandCamera | undefined = undefined;
    const switcher = new BandSwitcher(host, {
      bands,
      transition,
      initialBand,
      requestedZoom: () => camera?.requestedZoom ?? host.getZoom(),
      zoomOffset: () => camera?.zoomOffset ?? 0,
      sourceIdsForBand: (band) => rewritten.sourceIdsForBand(band),
      gatesForBand: (band) => rewritten.gatesForBand(band),
      ...(onSwitch ? { onSwitch } : {}),
    });
    const mode = this.#options.compensation ?? 'zoom+bearing';
    camera = new BandCamera(host, {
      bands,
      selector: switcher,
      lngLatFactory,
      ...(transition && mode !== 'none' ? { compensation: { transition, mode } } : {}),
    });
    const installedCamera = camera;
    const uninstallConstrain = installEqualEarthConstrain(host, {
      lngLatFactory,
      bands,
      baselineBand: () => installedCamera.baselineBand,
      currentBand: () => installedCamera.shownBand,
      isActive: () => this.active,
    });
    switcher.start();
    this.#installed = { switcher, camera, uninstallConstrain };
    this.#view = undefined;
    this.#settle();

    if (this.#worldCopies === undefined) {
      this.#worldCopies = host.getRenderWorldCopies();
      host.setRenderWorldCopies(false);
    }
    // C4: one camera update converts the centre into the initial band and settles the first
    // offsets, since the hook now runs with the baseline the camera was constructed with.
    const center = geographicToMap(view.geographic, bands[initialBand]!.blend);
    this.#raw.jumpTo({
      center: markMapSpace(lngLatFactory(center[0], center[1])),
      zoom: view.zoom,
      bearing: view.bearing,
    });
    announceUnwarpedRelief(original, transition);
    return true;
  }

  /**
   * A type switch is pending but has not committed: it starts again from whatever style is
   * live (its change listeners saw the swap), so a re-apply of the old type would only
   * supersede it (N3).
   */
  #switchPending(): boolean {
    return this.#pending !== undefined && this.#pending.type !== this.#projection;
  }

  /**
   * A full rebuild began that is not ours: the style is about to be unloaded, so stop touching
   * it at once, and abandon an apply waiting for a load. The new style is picked up on its
   * `style.load`.
   */
  readonly #onStyleLoading = (): void => {
    if (!this.active || this.#applying) return;
    this.#view = this.#detach();
    if (!this.#switchPending()) this.#nextGeneration();
  };

  /**
   * A style finished loading that is not the result of our own diffed `setStyle`.
   *
   * - The application's (no metadata key): it becomes the original and is rewritten.
   * - Ours, rebuilt (N1): MapLibre restores a lost WebGL context with
   *   `setStyle(serialised, { diff: false })` (`ui/map.ts:4153`; `serialize` keeps `metadata`),
   *   and an application may do the same with `getStyle()`. If nothing is installed and no apply
   *   is waiting for this load, re-apply from the original. Re-applying, rather than re-attaching
   *   to the live rewritten style, costs one diff (normally with no operations) and makes the
   *   gates, the switcher's initial band and the centre agree again: the serialised style
   *   carries the paint of whatever switch was in progress, and pending symbol hides were
   *   cancelled with the old switcher.
   */
  readonly #onStyleLoad = (): void => {
    if (!this.active || this.#applying) return;
    const style = this.#readStyle();
    if (!style) return;
    if (hasOurMetadata(style)) {
      if (this.#installed || this.#inFlight === this.#generation || this.#switchPending()) return;
      this.#view = this.#detach();
      this.#reapply();
      return;
    }
    this.#view = this.#detach();
    this.#original = this.#capture(style);
    if (this.#switchPending()) return;
    this.#reapply();
  };

  #unsubscribe(): void {
    this.#host.off('styledataloading', this.#onStyleLoading);
    this.#host.off('style.load', this.#onStyleLoad);
  }

  /** Our own `setStyle`: its style events are not the application's. */
  #setStyle(style: StyleLike): void {
    this.#applying = true;
    try {
      this.#host.setStyle(style, { diff: true });
    } finally {
      this.#applying = false;
    }
  }

  /**
   * Tear down the switcher, camera and constraint, returning the camera in geographic terms.
   * Idempotent: while nothing is installed it returns the view captured when it was.
   */
  #detach(): View {
    const installed = this.#installed;
    if (!installed) return this.#view!;
    const { camera, switcher } = installed;
    const blend = camera.blend;
    const center = this.#raw.getCenter();
    const view: View = {
      geographic: geographicUnder([center.lng, center.lat], blend),
      zoom: camera.requestedZoom,
      bearing: camera.requestedBearing,
      blend,
    };
    switcher.destroy();
    camera.destroy();
    installed.uninstallConstrain();
    this.#installed = undefined;
    return view;
  }

  /** After the style is dealt with: world copies back, the camera back in geographic space. */
  #finishDeactivate(view: View): void {
    this.#view = undefined;
    if (this.#worldCopies !== undefined) {
      this.#host.setRenderWorldCopies(this.#worldCopies);
      this.#worldCopies = undefined;
    }
    const { lngLatFactory } = this.#options;
    this.#raw.jumpTo({
      center: markMapSpace(lngLatFactory(view.geographic[0], view.geographic[1])),
      zoom: view.zoom,
      bearing: view.bearing,
    });
  }

  /**
   * An apply failed after committing: put back whatever it had changed, and fail the
   * activations waiting for it (M3) with its error.
   */
  #abandon(error: unknown): void {
    this.#nextGeneration();
    this.#settle(error);
    const view = this.#detach();
    this.#projection = undefined;
    this.#unsubscribe();
    const live = this.#readStyle();
    if (this.#original && hasOurMetadata(live)) this.#setStyle(restorableStyle(this.#original, live));
    this.#rewritten = undefined;
    this.#finishDeactivate(view);
  }

  /** The vector sources' templates, from the inline source or its fetched TileJSON (P14). */
  async #templates(style: StyleLike): Promise<Record<string, SourceTemplate>> {
    const templates: Record<string, SourceTemplate> = {};
    await Promise.all(
      Object.entries(style.sources).map(async ([id, source]) => {
        if (source['type'] !== 'vector') return;
        const url = source['url'];
        if (!Array.isArray(source['tiles']) && typeof url !== 'string') return;
        let resolved: SourceTemplate & { tms?: boolean };
        if (Array.isArray(source['tiles'])) {
          resolved = template(source);
          if (resolved.tiles.length === 0) throw unresolved(id, 'the source lists no tiles');
        } else {
          resolved = await this.#tileJsonTemplate(id, url as string);
        }
        if (source['scheme'] === 'tms' || resolved.tms) {
          // The eqearth URL's {z}/{x}/{y} are the output tile; MapLibre's TMS y-flip would
          // corrupt them.
          throw new Error(`Equal Earth: TMS tile schemes are not supported yet (source "${id}").`);
        }
        const kept: SourceTemplate & { tms?: boolean } = { ...resolved };
        delete kept.tms;
        if (source['promoteId'] !== undefined) kept.promoteId = source['promoteId'];
        templates[id] = kept;
      }),
    );
    return templates;
  }

  async #tileJsonTemplate(id: string, url: string): Promise<SourceTemplate & { tms?: boolean }> {
    const cached = this.#tileJson.get(url);
    if (cached) return cached;
    let json: unknown;
    try {
      json = await this.#fetchJson(url);
    } catch (error) {
      throw unresolved(id, error instanceof Error ? error.message : String(error), error);
    }
    if (!json || typeof json !== 'object' || !Array.isArray((json as { tiles?: unknown }).tiles)) {
      throw unresolved(id, 'the TileJSON lists no tiles');
    }
    const resolved = template(json as Record<string, unknown>);
    if (resolved.tiles.length === 0) throw unresolved(id, 'the TileJSON lists no tiles');
    this.#tileJson.set(url, resolved);
    return resolved;
  }

  /**
   * A copy of the application's style, read from the map, to keep as the original: without the
   * zoom bounds a diff over our rewritten style left on it ({@link withoutRewriteBounds}).
   */
  #capture(style: StyleLike): StyleLike {
    return withoutRewriteBounds(structuredClone(style), this.#rewritten, this.#original);
  }

  /** The host's style if it is loaded, else `undefined`. Not a copy: clone before keeping it. */
  #readStyle(): StyleLike | undefined {
    let style: HostStyle | undefined;
    try {
      style = this.#host.getStyle();
    } catch {
      return undefined;
    }
    if (!style || !Array.isArray(style.layers)) return undefined;
    const { metadata } = style;
    // Anything but an object cannot carry the rewrite's key; drop it rather than mis-read it.
    if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null)) {
      const copy: Record<string, unknown> = { ...style };
      delete copy['metadata'];
      return copy as StyleLike;
    }
    return style as StyleLike;
  }
}

function unresolved(id: string, reason: string, cause?: unknown): Error {
  return new Error(`Equal Earth: could not resolve TileJSON for source "${id}": ${reason}`, {
    cause,
  });
}

/** The template fields of an inline source or a TileJSON; `tms` flags a TMS scheme. */
function template(json: Record<string, unknown>): SourceTemplate & { tms?: boolean } {
  const { tiles, maxzoom, minzoom, attribution, scheme } = json;
  return {
    tiles: (tiles as unknown[]).map(String),
    ...(typeof maxzoom === 'number' ? { maxzoom } : {}),
    ...(typeof minzoom === 'number' ? { minzoom } : {}),
    ...(typeof attribution === 'string' ? { attribution } : {}),
    ...(scheme === 'tms' ? { tms: true } : {}),
  };
}

