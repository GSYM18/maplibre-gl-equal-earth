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
 * Ordering rules that matter (C7): the switcher writes paint properties from inside the camera
 * hook, and MapLibre's `setPaintProperty` throws while a style is still loading, so nothing is
 * installed until the rewritten style's `styledata` has fired; and everything is torn down
 * before any other style is set, so no frame runs against a style whose band sources are gone.
 *
 * Like every `map/` module this has no runtime dependency on `maplibre-gl`; the host is typed
 * structurally ({@link ControllerHost}).
 */

import {
  geographicToMap,
  mapSpaceMaxLatitude,
  mapSpaceMaxLongitude,
  mapToGeographic,
} from '../math/backproject.js';
import type { LngLatTuple } from '../math/equal-earth.js';
import type { CompensationMode } from '../math/jacobian.js';
import {
  EQUAL_EARTH_BANDS,
  bandIndexForZoom,
  resolveTransition,
  type Band,
  type ResolvedTransition,
  type Transition,
} from './bands.js';
import { BandCamera, type CameraHost, type LngLatFactory } from './camera.js';
import { installEqualEarthConstrain, type ConstrainHost } from './constrain.js';
import {
  REWRITTEN_METADATA_KEY,
  rewriteStyle,
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
export interface ControllerHost extends CameraHost, ConstrainHost, SwitcherHost {
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
  once(type: string, listener: () => void): unknown;
  jumpTo(options: { center?: { lng: number; lat: number }; zoom?: number; bearing?: number }): unknown;
  /** `undefined` (or a throw) while the style is not loaded: MapLibre's `serialize`. */
  getStyle(): HostStyle | undefined;
  /** MapLibre's also takes a URL or `null`; the controller passes only style objects. */
  setStyle(style: HostStyle | string | null, options?: { diff?: boolean }): unknown;
  getCenter(): { lng: number; lat: number };
  getBearing(): number;
  getRenderWorldCopies(): boolean;
  setRenderWorldCopies(value: boolean): unknown;
  fire?(event: unknown): unknown;
}

export interface ControllerOptions {
  /** Builds the centre objects handed to MapLibre. Pass `(lng, lat) => new maplibregl.LngLat(lng, lat)`. */
  lngLatFactory: LngLatFactory;
  /** The `equal` transition (spec §3). */
  transition?: Transition;
  /** What the camera absorbs of each step (spec §4.2). @defaultValue `'zoom+bearing'` */
  compensation?: CompensationMode;
  /** Fetches a vector source's TileJSON. @defaultValue `fetch(url)` and `.json()` */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Called on every band switch. */
  onSwitch?: (event: SwitchEvent) => void;
}

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

const defaultFetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

/**
 * Owns the Equal Earth state of one map.
 *
 * Every camera change the controller makes is a single `jumpTo` with an explicit centre, zoom
 * and bearing; on activation it runs right after the camera is installed, so it both moves the
 * centre into band space and settles the first frame's compensation offsets (it fires
 * `movestart`/`moveend` like any camera change).
 */
export class EqualEarthController {
  readonly #host: ControllerHost;
  readonly #options: ControllerOptions;
  readonly #fetchJson: (url: string) => Promise<unknown>;
  /** Resolved TileJSONs by URL: a re-apply after the application's `setStyle` does not refetch. */
  readonly #tileJson = new Map<string, SourceTemplate>();

  #projection: EqualEarthProjection | undefined;
  #bands: readonly Band[] = EQUAL_EARTH_BANDS;
  #transition: ResolvedTransition | null = null;
  /** The style to restore: the application's, never a rewritten one. */
  #original: StyleLike | undefined;
  #installed: Installed | undefined;
  /** The camera while nothing is installed (during an apply). */
  #view: View | undefined;
  /** `renderWorldCopies` before activation; `undefined` until it has been turned off. */
  #worldCopies: boolean | undefined;
  /** Bumped by every activate, re-apply and deactivate: a stale async apply abandons itself. */
  #generation = 0;
  #pending: { type: EqualEarthProjection; promise: Promise<void> } | undefined;
  /** True while our own `setStyle` runs, whose `styledata` is not the application's. */
  #applying = false;
  #destroyed = false;

  constructor(host: ControllerHost, options: ControllerOptions) {
    this.#host = host;
    this.#options = options;
    this.#fetchJson = options.fetchJson ?? defaultFetchJson;
  }

  get active(): boolean {
    return this.#projection !== undefined;
  }

  get projection(): EqualEarthProjection | undefined {
    return this.#projection;
  }

  /** Blend of the band shown now; 1 (Mercator, i.e. geographic) while inactive. */
  get blend(): number {
    if (!this.active) return 1;
    return this.#installed ? this.#installed.camera.blend : (this.#view?.blend ?? 1);
  }

  /** A geographic position in the map space of the band shown now. */
  toMapSpace(lngLat: LngLatTuple): LngLatTuple {
    return this.active ? geographicToMap(lngLat, this.blend) : [lngLat[0], lngLat[1]];
  }

  /** A map-space position of the band shown now, geographically. */
  toGeographic(lngLat: LngLatTuple): LngLatTuple {
    return this.active ? mapToGeographic(lngLat, this.blend) : [lngLat[0], lngLat[1]];
  }

  activate(type: EqualEarthProjection): Promise<void> {
    if (this.#destroyed) return Promise.reject(new Error('Equal Earth: this controller was destroyed.'));
    if (this.#pending?.type === type) return this.#pending.promise;
    if (this.#projection === type && !this.#pending) return Promise.resolve();
    const generation = ++this.#generation;
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
    this.#destroyed = true;
    this.#original = undefined;
    this.#tileJson.clear();
  }

  #deactivateNow(): void {
    this.#generation++;
    this.#pending = undefined;
    if (!this.active) return;
    const view = this.#detach();
    const original = this.#original;
    this.#projection = undefined;
    this.#host.off('styledata', this.#onStyleData);
    this.#applying = true;
    try {
      if (original) this.#host.setStyle(original, { diff: true });
    } finally {
      this.#applying = false;
    }
    this.#finishDeactivate(view);
  }

  async #activate(type: EqualEarthProjection, generation: number): Promise<void> {
    // 1. A loaded style.
    let style = this.#readStyle();
    while (!style) {
      await this.#nextStyleData();
      if (generation !== this.#generation) return;
      style = this.#readStyle();
    }
    // 2. The original: the previously captured one if this style is already ours.
    const original = style.metadata?.[REWRITTEN_METADATA_KEY] !== undefined && this.#original
      ? this.#original
      : style;
    // 3. Bands.
    const transition = type === 'equal' ? resolveTransition(this.#options.transition) : null;
    const bands = transition ? transition.bands : EQUAL_EARTH_BANDS;
    // 4. Templates; a failure rejects before anything on the map has changed.
    const templates = await this.#templates(original);
    if (generation !== this.#generation) return;

    // Commit. Switching type while active starts from the camera the old type showed.
    if (this.active) {
      this.#view = this.#detach();
    } else {
      const center = this.#host.getCenter();
      this.#view = {
        geographic: [center.lng, center.lat],
        zoom: this.#host.getZoom(),
        bearing: this.#host.getBearing(),
        blend: 1,
      };
      this.#host.on('styledata', this.#onStyleData);
    }
    this.#original = original;
    this.#projection = type;
    this.#bands = bands;
    this.#transition = transition;
    try {
      await this.#apply(generation, templates);
    } catch (error) {
      if (generation === this.#generation) this.#abandon();
      throw error;
    }
  }

  /**
   * Rewrite {@link #original}, set it, wait for it to load, then install the switcher, the
   * camera and the constraint and move the camera into the initial band (steps 5–8). Expects
   * nothing installed and {@link #view} set.
   */
  async #apply(generation: number, templates?: Record<string, SourceTemplate>): Promise<void> {
    const original = this.#original!;
    templates ??= await this.#templates(original);
    if (generation !== this.#generation) return;

    const view = this.#view!;
    const bands = this.#bands;
    const transition = this.#transition;
    const initialBand = bandIndexForZoom(bands, view.zoom);
    const rewritten = rewriteStyle(original, { bands, transition, templates, initialZoom: view.zoom });

    // C7: wait for the `styledata` this `setStyle` produces. MapLibre's diff path fires it
    // inside the call, so listen first; a full rebuild fires it once the style has loaded.
    let loaded = false;
    const styleLoaded = new Promise<void>((resolve) => {
      this.#host.once('styledata', () => {
        loaded = true;
        resolve();
      });
    });
    this.#applying = true;
    try {
      this.#host.setStyle(rewritten.style, { diff: true });
    } finally {
      this.#applying = false;
    }
    if (!loaded) {
      const current = this.#readStyle();
      // Loaded, yet not ours and no `styledata`: MapLibre rejected the style (validation errors
      // are emitted as `error` events and leave the old style in place).
      if (current && current.metadata?.[REWRITTEN_METADATA_KEY] === undefined) {
        throw new Error('Equal Earth: the map did not accept the rewritten style.');
      }
    }
    await styleLoaded;
    if (generation !== this.#generation) return;

    const host = this.#host;
    const { lngLatFactory, onSwitch } = this.#options;
    let camera: BandCamera | undefined = undefined;
    const switcher = new BandSwitcher(host, {
      bands,
      transition,
      initialBand,
      requestedZoom: () => camera?.requestedZoom ?? host.getZoom(),
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

    if (this.#worldCopies === undefined) {
      this.#worldCopies = host.getRenderWorldCopies();
      host.setRenderWorldCopies(false);
    }
    // C4: one camera update converts the centre into the initial band and settles the first
    // offsets, since the hook now runs with the baseline the camera was constructed with.
    const center = geographicToMap(view.geographic, bands[initialBand]!.blend);
    host.jumpTo({ center: lngLatFactory(center[0], center[1]), zoom: view.zoom, bearing: view.bearing });
  }

  /**
   * The application set a style of its own while active: it becomes the original, and is
   * rewritten in turn. Our own styles carry the metadata key and are ignored.
   */
  readonly #onStyleData = (): void => {
    if (!this.active || this.#applying) return;
    const style = this.#readStyle();
    if (style && style.metadata?.[REWRITTEN_METADATA_KEY] !== undefined) return;
    // C7: whatever is loading now has no band sources; stop touching it at once, and abandon
    // any apply still in flight for the style it replaced.
    this.#view = this.#detach();
    const generation = ++this.#generation;
    if (!style) return; // still loading: its own `styledata` follows
    this.#original = style;
    this.#apply(generation).catch((error: unknown) => {
      if (generation !== this.#generation) return;
      // The application's style stays; Equal Earth is off.
      this.#generation++;
      this.#projection = undefined;
      this.#host.off('styledata', this.#onStyleData);
      this.#finishDeactivate(this.#view!);
      this.#report(error);
    });
  };

  /**
   * Tear down the switcher, camera and constraint, returning the camera in geographic terms.
   * Idempotent: while nothing is installed it returns the view captured when it was.
   */
  #detach(): View {
    const installed = this.#installed;
    if (!installed) return this.#view!;
    const { camera, switcher } = installed;
    const blend = camera.blend;
    const center = this.#host.getCenter();
    const view: View = {
      geographic: centreToGeographic([center.lng, center.lat], blend),
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
    this.#host.jumpTo({
      center: lngLatFactory(view.geographic[0], view.geographic[1]),
      zoom: view.zoom,
      bearing: view.bearing,
    });
  }

  /** An activation failed after committing: put back whatever it had changed. */
  #abandon(): void {
    this.#generation++;
    const view = this.#detach();
    this.#projection = undefined;
    this.#host.off('styledata', this.#onStyleData);
    const current = this.#readStyle();
    if (this.#original && current?.metadata?.[REWRITTEN_METADATA_KEY] !== undefined) {
      this.#applying = true;
      try {
        this.#host.setStyle(this.#original, { diff: true });
      } finally {
        this.#applying = false;
      }
    }
    this.#finishDeactivate(view);
  }

  /** The vector sources' tile templates, from inline `tiles` or a fetched TileJSON. */
  async #templates(style: StyleLike): Promise<Record<string, SourceTemplate>> {
    const templates: Record<string, SourceTemplate> = {};
    await Promise.all(
      Object.entries(style.sources).map(async ([id, source]) => {
        if (source['type'] !== 'vector') return;
        const tiles = source['tiles'];
        if (Array.isArray(tiles)) {
          templates[id] = template(tiles, source['maxzoom']);
          return;
        }
        const url = source['url'];
        if (typeof url !== 'string') return;
        try {
          let resolved = this.#tileJson.get(url);
          if (!resolved) {
            const json = (await this.#fetchJson(url)) as { tiles?: unknown; maxzoom?: unknown } | null;
            if (!json || !Array.isArray(json.tiles) || json.tiles.length === 0) {
              throw new Error('the TileJSON lists no tiles');
            }
            resolved = template(json.tiles, json.maxzoom);
            this.#tileJson.set(url, resolved);
          }
          templates[id] = resolved;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Equal Earth: could not resolve TileJSON for source "${id}": ${reason}`, {
            cause: error,
          });
        }
      }),
    );
    return templates;
  }

  /** The host's style if it is loaded, else `undefined`. */
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

  #nextStyleData(): Promise<void> {
    return new Promise((resolve) => {
      this.#host.once('styledata', () => resolve());
    });
  }

  #report(error: unknown): void {
    if (typeof this.#host.fire === 'function') this.#host.fire({ type: 'error', error });
    else console.error(error);
  }
}

function template(tiles: unknown[], maxzoom: unknown): SourceTemplate {
  return {
    tiles: tiles.map(String),
    ...(typeof maxzoom === 'number' ? { maxzoom } : {}),
  };
}

/**
 * The geographic point under a map-space centre, brought into the band's world first as the
 * camera does: a centre panned beyond the rounded outline has no geographic meaning.
 */
function centreToGeographic(center: LngLatTuple, blend: number): LngLatTuple {
  const maxLat = mapSpaceMaxLatitude(blend);
  const lat = Math.max(-maxLat, Math.min(maxLat, center[1]));
  const maxLng = mapSpaceMaxLongitude(lat, blend);
  const lng = Math.max(-maxLng, Math.min(maxLng, center[0]));
  const geographic = mapToGeographic([lng, lat], blend);
  return Number.isFinite(geographic[0]) && Number.isFinite(geographic[1]) ? geographic : center;
}
