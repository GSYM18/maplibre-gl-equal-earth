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
 * **GeoJSON** (spec §7). A GeoJSON source is fanned out into one warped copy per band
 * (`style-rewrite.ts`, `geojson.ts`); one given by URL is fetched with `fetchJson` first, afresh
 * on each activation and from a per-URL cache for the re-applies within it. Right before each
 * rewrite the original takes every GeoJSON source's live data (`serialize()`), so a `setData`
 * made while nothing is wrapped (in the tick of `setProjection` or of the application's own
 * `setStyle`) is not reverted. While installed, the live source object's `setData` and
 * `updateData` are wrapped (`wrapMethod`) so that the copies follow: `setData` warps the new data
 * into every copy at once (a URL is fetched afresh with `fetchJson` first, and a fetch that a
 * later `setData` overtook is dropped); `updateData` waits until MapLibre has applied the diff,
 * then fans out the source's full `getData()`, a full re-warp of that source per update. The new
 * data also becomes the original's (a URL stays a URL), so a re-apply and the restore keep it.
 * A teardown makes every fetch or `updateData` the wrappers started stale. An `updateData` made
 * while nothing is wrapped and still with the worker at the rewrite reaches the copies only with
 * the source's next wrapped update.
 *
 * **Live style edits** (Task 9). The map's `addSource`, `removeSource`, `addLayer`, `removeLayer`,
 * `setPaintProperty`, `setLayoutProperty` and `setFilter` (and `setStyle`, `fire` and the reads
 * below) are wrapped on the instance when the controller is constructed, and pass straight
 * through while Equal Earth is off. While it is on,
 * an edit addresses the application's ids, which name the original's layers and sources:
 *
 * - A property edit is written to every live copy of the layer and kept in the original. A gated
 *   value (an opacity the switcher fades, a hidden-by-visibility layer's `visibility`) becomes the
 *   gate's own value instead, written only to the copies of the band shown (hidden copies keep 0
 *   or `"none"`). The first copy written tells whether MapLibre accepted the value (its getter
 *   reads it back); a refused value goes no further, so it cannot poison later rewrites. The
 *   first background layer is the exception: its copies are not plain clones (outside colour,
 *   world polygon), so its edits go through the rewrite, as structure edits do.
 * - A structure edit calls MapLibre's own method first, so the application can use the id at once
 *   (it lands where the Mercator band's layers are), with `beforeId` translated to the first live
 *   copy of that layer, and applies the same change to the original. One amend per task
 *   (`queueMicrotask`) then rewrites the original and diffs it in with `setStyle`. It **amends**
 *   rather than re-applies: no teardown, no new switcher, camera or constraint, no `jumpTo`, so the
 *   view and the band shown do not change. The rewrite starts its copies in the band the switcher
 *   shows (`RewriteOptions.initialBand`), and a band still fading out keeps its live state (its
 *   pending hide reads the new gates when it fires), so MapLibre's diff touches only what was
 *   added or removed. Before rewriting, the GeoJSON sources take their live data (as for a
 *   re-apply) and the style's root properties (light, sky, sprite, …) are taken from the live
 *   style, so neither the application's `setData` nor its `setLight` is reverted. A source given
 *   by URL that is not cached yet (an added GeoJSON source, a TileJSON) is fetched first: only then
 *   does an amend wait, and edits made meanwhile join it. A source that cannot be resolved is
 *   reported (an `error` event, as for a re-apply) and stays unbanded.
 * - An amend is invisible, as a native `addLayer` is (R15), and so are activation, re-apply and
 *   restore, as a native `setProjection` is (R21): the `style.load` that `Style.setState` fires for
 *   the plugin's own diff bubbles through the Map's `fire`, which is wrapped to swallow it while
 *   that `setStyle` runs. The application's `style.load` listeners hear only the styles it set
 *   itself, once each; MapLibre's own listener only jumps to an unmodified camera's stylesheet view,
 *   wrong for a map-space style anyway. A full rebuild of ours (a diff MapLibre cannot apply) still
 *   delivers its later `style.load`. An edit made inside the plugin's own `setStyle` (an application
 *   listener of an event it fires, such as `sourcedataloading`) is amended in a new macrotask, never
 *   in the running amend loop.
 * - An application `setStyle(url)` still fetching is never cancelled (R20): MapLibre aborts its
 *   `_diffStyleRequest` on any `setStyle` of an object, ours included. While it is out, an amend
 *   and a re-apply (or activation) wait, polling, and the wrappers go on following the original
 *   (the live style is still ours). Its style arrives and is captured, which supersedes them and,
 *   as natively, drops what was edited on the old style; or the fetch fails or changes nothing, and
 *   they go ahead with the edits. A deactivation restores at once and asks for the URL again, or,
 *   when the live style is not ours (an activation still waiting for the fetch), leaves it alone (R22).
 * - Edits made while an activation fetches its TileJSON are taken before it commits; edits made
 *   while a re-apply is in flight reach the original it rewrites, and an amend follows the apply
 *   once it has finished (R17).
 * - The live style decides (R19): the wrappers keep edits in the original, translate ids and
 *   refuse as MapLibre would only while the live style is our rewrite, told by one raw `getLayer`
 *   of a layer only the rewrite has (its sentinel). Otherwise, as for a basemap the application
 *   switched to (`setStyle(url)` diffs it in from MapLibre's own fetch, so the call is long over),
 *   they pass straight through: a `style.load` listener that re-adds its layers edits the live
 *   style, where the capture finds them, and an edit made after the capture but before the
 *   re-apply is found by the re-apply's second look at the live style, made again after every wait
 *   (a TileJSON, a GeoJSON URL). The application's `setStyle` is still tracked (R16, R20), and a
 *   rewrite without a sentinel decides by it.
 * - `getLayer`, `getPaintProperty`, `getLayoutProperty`, `getFilter` and the `layers` of
 *   `queryRenderedFeatures` read an original id that is not live (pure Equal Earth, or outside
 *   the Mercator band's range) as its copy in the band shown, else its first live copy (R18): the
 *   application's guards agree with what the wrappers accept and refuse.
 *
 * The plugin's own writes and reads never pass through these wrappers (rule 4): the switcher's
 * gates and every call the controller makes use MapLibre's methods as found before wrapping.
 * `setLayerZoomRange`, `moveLayer` and the other style setters are not followed.
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
  bandSourceId,
  continuousBlend,
  parseRange,
  resolveTransition,
  type Band,
  type ResolvedTransition,
  type Transition,
} from './bands.js';
import { CARTOGRAPHY_PREFIX, type CartographyOptions } from './cartography.js';
import { BandCamera, type CameraHost, type LngLatFactory } from './camera.js';
import { installEqualEarthConstrain, type ConstrainHost } from './constrain.js';
import { geojsonZoomForBand, warpGeoJSON } from './geojson.js';
import { wrapMethod } from './instance-wrap.js';
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
  applyGate,
  restorableStyle,
  rewriteStyle,
  withoutRewriteBounds,
  type GateHost,
  type LayerGate,
  type RewriteOptions,
  type RewrittenStyle,
  type SourceTemplate,
  type StyleLayerLike,
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
  /** The live source object (both majors); read structurally ({@link GeoJSONSourceLike}). */
  getSource(id: string): unknown;
  /** This and the next four are followed while active (Task 9), with `setPaintProperty` and `setLayoutProperty`. */
  addSource(id: string, source: unknown): unknown;
  removeSource(id: string): unknown;
  addLayer(layer: unknown, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  setFilter(layerId: string, filter: unknown, options?: unknown): unknown;
  /** The live layer, `undefined` when the style has none by that id. */
  getLayer(id: string): unknown;
  /** Read back after a write, to see whether MapLibre accepted the value (both majors). */
  getPaintProperty?(layerId: string, name: string): unknown;
  getLayoutProperty?(layerId: string, name: string): unknown;
  getFilter?(layerId: string): unknown;
}

/** MapLibre's own style edits, as found before the controller wrapped them (rule 4). */
interface RawStyle {
  addSource(id: unknown, source: unknown, ...rest: unknown[]): unknown;
  removeSource(id: unknown, ...rest: unknown[]): unknown;
  addLayer(layer: unknown, beforeId: unknown, ...rest: unknown[]): unknown;
  removeLayer(id: unknown, ...rest: unknown[]): unknown;
  setPaintProperty(layerId: unknown, name: unknown, value: unknown, ...rest: unknown[]): unknown;
  setLayoutProperty(layerId: unknown, name: unknown, value: unknown, ...rest: unknown[]): unknown;
  setFilter(layerId: unknown, filter: unknown, ...rest: unknown[]): unknown;
  setStyle(style: unknown, ...rest: unknown[]): unknown;
  getLayer(...args: unknown[]): unknown;
  /** These three throw on a map without them; `#accepted` then assumes acceptance. */
  getPaintProperty(...args: unknown[]): unknown;
  getLayoutProperty(...args: unknown[]): unknown;
  getFilter(...args: unknown[]): unknown;
  queryRenderedFeatures(...args: unknown[]): unknown;
}

/** The style reads that resolve an original id while active (R18), by their id argument. */
const LAYER_READS = ['getLayer', 'getPaintProperty', 'getLayoutProperty', 'getFilter'] as const;

const RAW_METHODS = [
  'addSource',
  'removeSource',
  'addLayer',
  'removeLayer',
  'setPaintProperty',
  'setLayoutProperty',
  'setFilter',
  'setStyle',
  ...LAYER_READS,
  'queryRenderedFeatures',
] as const satisfies readonly (keyof RawStyle)[];

const STYLE_EDITS = [
  'addSource',
  'removeSource',
  'addLayer',
  'removeLayer',
  'setPaintProperty',
  'setLayoutProperty',
  'setFilter',
] as const satisfies readonly (keyof RawStyle)[];

/** Which of a layer's properties a property edit sets. */
type PropertyKind = 'paint' | 'layout' | 'filter';

/**
 * The style's root properties `Style.serialize` reports when set (v6 and v5.24 alike), other than
 * those the rewrite owns ({@link REWRITE_ROOT}).
 */
const SERIALIZED_ROOT = ['name', 'light', 'sky', 'center', 'zoom', 'bearing', 'pitch', 'sprite', 'glyphs', 'transition', 'terrain'];
const REWRITE_ROOT = new Set(['version', 'sources', 'layers', 'metadata', 'projection']);

/** The parts of a MapLibre `GeoJSONSource` the controller wraps and reads (v5.24+, v6). */
interface GeoJSONSourceLike {
  setData?(data: unknown, ...rest: unknown[]): unknown;
  updateData?(diff: unknown, ...rest: unknown[]): unknown;
  getData?(): Promise<unknown>;
  /** `false` while a data update is with the worker or pending (`GeoJSONSource.loaded`). */
  loaded?(): boolean;
  once?(type: string, listener: () => void): unknown;
  /** The source's options with its current `data` (the URL, or the object); both majors. */
  serialize?(): unknown;
}

/** What a style's sources resolve to before it is rewritten: vector templates and GeoJSON data. */
interface ResolvedSources {
  templates: Record<string, SourceTemplate>;
  /** Fetched data of the GeoJSON sources given by URL, by source id. */
  geojson: Record<string, GeoJSON.GeoJSON>;
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
  /** The `setData`/`updateData` wrappers of the banded GeoJSON sources, by source id. */
  geojson: Map<string, GeoJSONWrap>;
}

/** One GeoJSON source object's wrappers: removed when the source leaves the bands or is replaced. */
interface GeoJSONWrap {
  source: object;
  restore: () => void;
}

/** The name of the error an activation rejects with when a later call superseded it. */
export const SUPERSEDED_ERROR_NAME = 'EqualEarthSupersededError';

const NO_OFFSETS: SimilarityOffsets = { deltaZoom: 0, deltaBearing: 0 };

/** How often a wait for the application's `setStyle` looks again (R20): a style that changes nothing fires no event. */
const APP_STYLE_POLL_MS = 16;

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
  /** Fetched GeoJSON by URL, likewise; a `setData(url)` while active refreshes its entry. */
  readonly #geojson = new Map<string, GeoJSON.GeoJSON>();
  /** Per GeoJSON source id, bumped by each `setData`/`updateData`: a late result is dropped. */
  readonly #dataVersions = new Map<string, number>();

  #projection: EqualEarthProjection | undefined;
  #bands: readonly Band[] = EQUAL_EARTH_BANDS;
  #transition: ResolvedTransition | null = null;
  /** The style to restore: the application's, never a rewritten one. */
  #original: StyleLike | undefined;
  /**
   * The rewrite we last set, until it is restored away: its style is the base MapLibre diffs the
   * application's next style against, whose in-place zoom bounds that style may inherit. A live
   * style edit's amend replaces it; the switcher reads its sources and gates through it.
   */
  #rewritten: RewrittenStyle | undefined;
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
  /** MapLibre's own style edits, captured before wrapping: the plugin's own writes (rule 4). */
  readonly #rawStyle: RawStyle;
  /** Restores the seven style edits the controller wrapped. */
  readonly #unwrapStyleEdits: () => void;
  /**
   * Bumped by every style edit the application makes: an activation still resolving starts again
   * from the live style, and an apply that saw one installs and then amends.
   */
  #edits = 0;
  #amendQueued = false;
  #amendRunning = false;
  #amendRequested = false;
  /** An amend deferred to a new macrotask (an edit made inside the plugin's own `setStyle`, R15). */
  #amendTimer: ReturnType<typeof setTimeout> | undefined;
  #amendDeferred = false;
  /** Set around the plugin's own `setStyle`: the `style.load` events it fires, swallowed (R15, R21). */
  #ownLoads: { count: number } | undefined;
  /**
   * An application `setStyle` while active (R16): `call` during the call; `fetch` while a URL is
   * fetched, until MapLibre's `_diffStyleRequest` is gone (or, on a map without it, until the
   * style's `style.load` or an `error`); `rebuild` while a full rebuild loads, until its
   * `style.load` or an `error`; `none` otherwise. See {@link #appStyleInFlight}.
   */
  #appStyle: 'none' | 'call' | 'fetch' | 'rebuild' = 'none';
  /** The application's `setStyle` calls while active: an amend tells one made inside its own. */
  #appStyleCalls = 0;
  /** The application's last `setStyle(url)` while active, and MapLibre's request for it (R20). */
  #appRequest: { url: string; rest: unknown[]; request: object | null | undefined } | undefined;
  /** Per rewrite, the id of a layer it adds that no original has (R19, {@link #liveIsOurs}). */
  readonly #sentinels = new WeakMap<RewrittenStyle, string | undefined>();
  /** Warped GeoJSON by data object and band (`blend/zoom`): an amend re-warps only new data. */
  readonly #warped = new WeakMap<object, Map<string, GeoJSON.GeoJSON>>();
  /** Source specs whose resolution failed synchronously (TMS, no tiles): reported once. */
  readonly #reported = new WeakSet<object>();

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
    this.#rawStyle = rawStyle(host);
    this.#unwrapStyleEdits = this.#wrapStyleEdits();
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
      unwrapGeoJSON(installed);
    }
    this.#projection = undefined;
    this.#view = undefined;
    this.#appStyle = 'none';
    this.#appRequest = undefined;
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
    this.#unwrapStyleEdits();
    clearTimeout(this.#amendTimer);
    this.#amendTimer = undefined;
    this.#destroyed = true;
    this.#original = undefined;
    this.#rewritten = undefined;
    this.#tileJson.clear();
    this.#geojson.clear();
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
    if (original) this.#restoreOriginal(original, this.#readStyle());
    this.#rewritten = undefined;
    this.#finishDeactivate(view);
  }

  async #activate(type: EqualEarthProjection, generation: number): Promise<void> {
    let original: StyleLike;
    let resolved: ResolvedSources;
    try {
      // GeoJSON given by URL is fetched afresh once per activation; a pass repeated only because
      // the application edited the style meanwhile is served from the cache.
      let fresh = true;
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
        // 4. Templates and GeoJSON; a failure rejects before anything on the map has changed. A style set
        // meanwhile (I3, N2) restarts from step 1: every swap fires `styledataloading` or
        // `style.load`, so listening suffices and nothing is serialised to compare. An edit through
        // the wrappers (`addLayer` in the tick of `setProjection`, say) is not in the captured
        // original either: that also starts again, from the live style. Our own `setStyle` (an amend
        // of the type still shown) changes nothing that was captured.
        let changed = false;
        const onChange = (): void => {
          if (!this.#applying) changed = true;
        };
        const edits = this.#edits;
        this.#host.on('styledataloading', onChange);
        this.#host.on('style.load', onChange);
        try {
          resolved = await this.#resolveSources(original, fresh);
        } finally {
          this.#host.off('styledataloading', onChange);
          this.#host.off('style.load', onChange);
        }
        if (generation !== this.#generation) throw superseded();
        if (!changed && this.#edits === edits) break;
        fresh = changed;
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
      applied = await this.#apply(generation, resolved);
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
  async #apply(generation: number, resolved?: ResolvedSources): Promise<boolean> {
    this.#inFlight = generation;
    try {
      return await this.#applyNow(generation, resolved);
    } finally {
      if (this.#inFlight === generation) this.#inFlight = undefined;
      // An amend this apply blocked (R17): installed now, or abandoned, which drops it.
      if (this.#amendRequested && this.#inFlight === undefined) this.#scheduleAmend();
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

  /**
   * The options of every `rewriteStyle` call (Ruling R2): the bands and transition of the type
   * shown, the cartography, `resolved` (the TileJSON templates and fetched GeoJSON), the memoised
   * GeoJSON warp, and for an amend the band the copies start shown in (`initialBand`).
   */
  #rewriteOptions(resolved: ResolvedSources, initialZoom: number, initialBand?: number): RewriteOptions {
    return {
      bands: this.#bands,
      transition: this.#transition,
      templates: resolved.templates,
      geojson: resolved.geojson,
      initialZoom,
      ...(initialBand === undefined ? {} : { initialBand }),
      cartography: this.#cartography(),
      warp: this.#warp,
    };
  }

  /** {@link rewriteStyle} of `original`, drawn with MapLibre's Mercator (I4). */
  #rewrite(original: StyleLike, resolved: ResolvedSources, initialZoom: number, initialBand?: number): RewrittenStyle {
    const rewritten = rewriteStyle(original, this.#rewriteOptions(resolved, initialZoom, initialBand));
    // I4: the warp feeds MapLibre's Mercator renderer; an original globe would bend it.
    rewritten.style.projection = { type: 'mercator' };
    // R19: a layer only this rewrite has, preferably a cartography layer (`equal-earth:*`, which no
    // application addresses), else a band copy. Every rewrite with something to translate has one:
    // the world polygon whenever there is a background and a band below Mercator (pure Equal Earth
    // included), a band copy whenever a layer is banded.
    const own = new Set(original.layers.map((layer) => layer.id));
    const added = rewritten.style.layers.filter((layer) => !own.has(layer.id));
    this.#sentinels.set(rewritten, (added.find((layer) => layer.id.startsWith(CARTOGRAPHY_PREFIX)) ?? added[0])?.id);
    return rewritten;
  }

  /**
   * {@link warpGeoJSON}, memoised by data object and band for the controller's life of that data:
   * an amend's rewrite reuses the warp of unchanged data, and of data a fan-out has just warped. A
   * `setData` with an object warped before forgets it first (an application may mutate and set the
   * same object again).
   */
  readonly #warp = (data: GeoJSON.GeoJSON, blend: number, densifyZoom: number): GeoJSON.GeoJSON => {
    let byBand = this.#warped.get(data);
    if (!byBand) {
      byBand = new Map();
      this.#warped.set(data, byBand);
    }
    const key = `${blend}/${densifyZoom}`;
    let warped = byBand.get(key);
    if (!warped) {
      warped = warpGeoJSON(data, blend, densifyZoom);
      byBand.set(key, warped);
    }
    return warped;
  };

  async #applyNow(generation: number, resolved?: ResolvedSources): Promise<boolean> {
    let original = this.#original!;
    // An edit from here on reaches `original` while the live style is ours (the wrappers keep it),
    // perhaps after the rewrite; the live style otherwise (it is the captured original).
    let edits = this.#edits;
    resolved ??= await this.#resolveSources(original);
    if (generation !== this.#generation) return false;
    // Until the rewrite is set, three things can leave it behind the application, each looked at
    // again after any wait, since every wait lets the application act:
    // - R20: an application `setStyle(url)` still fetching. Our `setStyle` would abort it
    //   (MapLibre's `_diffStyle` aborts `_diffStyleRequest`), so wait: its style arrives
    //   (`#onStyleLoad` captures it and re-applies, superseding this apply), or the fetch fails or
    //   changes nothing.
    // - R19: edits made since the capture while the live style was the application's went to the
    //   live style alone. Capture it again (and resolve what it added) so the rewrite keeps them.
    // - GeoJSON data set since the capture (the application's `setProjection` and `setData` in one
    //   tick, a `setData` right after its own `setStyle`): the wrappers only exist once installed.
    //   Take the live data, so the rewrite neither warps nor diffs back the old one; a new URL is
    //   resolved first.
    for (;;) {
      if (this.#appStyleInFlight()) {
        await this.#appStyleSettled(generation);
        if (generation !== this.#generation) return false;
        continue;
      }
      const live = this.#edits === edits ? undefined : this.#readStyle();
      if (live && !hasOurMetadata(live)) {
        edits = this.#edits;
        original = this.#original = this.#capture(live);
        resolved = await this.#resolveSources(original);
        if (generation !== this.#generation) return false;
        continue;
      }
      if (!this.#refreshGeoJSONData(original)) break;
      resolved = { ...resolved, geojson: await this.#geojsonData(original, false) };
      if (generation !== this.#generation) return false;
    }

    const view = this.#view!;
    const bands = this.#bands;
    const transition = this.#transition;
    const initialBand = bandIndexForZoom(bands, view.zoom);
    const rewritten = this.#rewrite(original, resolved, view.zoom);

    // C7: install only once the rewritten style has loaded. On the diff path `style.load` fires
    // inside `setStyle`, where it is counted and swallowed (R21); on a full rebuild it fires a
    // frame or more later, unswallowed, or never when the rebuild is aborted, in which case the
    // generation has moved on (M2). Listen first.
    const styleLoad = this.#nextEvent('style.load');
    this.#rewritten = rewritten;
    if (this.#setStyle(rewritten.style) > 0) {
      styleLoad.cancel();
    } else if (!styleLoad.fired()) {
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
    // The switcher reads the rewrite live: an amend replaces it without re-installing anything.
    const current = (): RewrittenStyle => this.#rewritten ?? rewritten;
    const switcher = new BandSwitcher(this.#switcherHost(), {
      bands,
      transition,
      initialBand,
      requestedZoom: () => camera?.requestedZoom ?? host.getZoom(),
      zoomOffset: () => camera?.zoomOffset ?? 0,
      sourceIdsForBand: (band) => current().sourceIdsForBand(band),
      gatesForBand: (band) => current().gatesForBand(band),
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
    const installed: Installed = { switcher, camera, uninstallConstrain, geojson: new Map() };
    this.#wrapGeoJSONSources(installed, rewritten.geojsonSources);
    this.#installed = installed;
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
    // The application edited the style while this apply was resolving or loading: what the
    // rewrite missed is amended now.
    if (this.#edits !== edits) this.#scheduleAmend();
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
    if (this.#appStyle !== 'none') this.#appStyle = 'rebuild';
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
    this.#appStyle = 'none'; // captured below (or ours again): the wrappers follow the original
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

  /**
   * Our own `setStyle`: its style events are not the application's. The `style.load` a diff fires
   * inside it (`Style.setState`) is swallowed (R15, R21): activation, re-apply, amend and restore
   * are as invisible to the application's `style.load` listeners as a native `setProjection`. The
   * count is returned. MapLibre's own `style.load` listener (`ui/map.ts:864`) only jumps to the
   * stylesheet's camera while the camera is unmodified, which our geographic centre in a map-space
   * style must not do anyway, and resizes the transform of a map created with a globe style, once.
   */
  #setStyle(style: StyleLike): number {
    const loads = { count: 0 };
    const outer = this.#ownLoads;
    this.#ownLoads = loads;
    this.#applying = true;
    try {
      this.#rawStyle.setStyle(style, { diff: true });
    } finally {
      this.#applying = false;
      this.#ownLoads = outer;
    }
    return loads.count;
  }

  /**
   * Put the original back (deactivation, abandon). Our `setStyle` aborts an application
   * `setStyle(url)` still fetching (R20), so ask for that style again: MapLibre then diffs it into
   * the original, as it would have without us, and fires its `style.load`.
   *
   * A loaded live style that is not ours (an activation still waiting for such a fetch, or the
   * application's style not yet re-applied) is left alone (R22), unless it carries zoom bounds
   * our rewrite left behind when the application's style was diffed over it: setting the original
   * would only abort that fetch and drop edits made to the live style meanwhile.
   */
  #restoreOriginal(original: StyleLike, live: StyleLike | undefined): void {
    const asked = this.#appRequest;
    const request = this.#diffStyleRequest();
    if (live && !hasOurMetadata(live) && restorableStyle(original, live) === original) return;
    takeLiveRoot(original, live);
    this.#setStyle(restorableStyle(original, live));
    if (asked && request && asked.request === request) this.#rawStyle.setStyle(asked.url, ...asked.rest);
  }

  /** MapLibre's `_diffStyleRequest` (both majors): `null` while no URL is fetched, `undefined` on a map without it. */
  #diffStyleRequest(): object | null | undefined {
    const host: object = this.#host;
    if (!('_diffStyleRequest' in host)) return undefined;
    const request = host._diffStyleRequest;
    return typeof request === 'object' ? request : null;
  }

  /**
   * Whether a `setStyle` of the plugin's own would cancel or overtake one of the application's
   * (R20). A URL is fetched with `_diffStyleRequest` set, which any `setStyle` of an object aborts
   * (`Map._diffStyle`, `ui/map.ts:2743`); only the application passes a URL. Once the request is
   * gone, the style has arrived (and `#onStyleLoad` has captured it), changed nothing (no event at
   * all), failed or was aborted. On a map without the field, the bookkeeping decides alone.
   */
  #appStyleInFlight(): boolean {
    const request = this.#diffStyleRequest();
    if (request) return true;
    if (this.#appStyle === 'fetch' && request === null) this.#appStyle = 'none';
    return this.#appStyle !== 'none';
  }

  /** Resolves once no application `setStyle` is in flight, or `generation` is stale. */
  async #appStyleSettled(generation: number): Promise<void> {
    while (generation === this.#generation && !this.#destroyed && this.#appStyleInFlight()) {
      await new Promise((resolve) => setTimeout(resolve, APP_STYLE_POLL_MS));
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
    unwrapGeoJSON(installed);
    // A fetch or `updateData` the wrappers started is stale once they are gone: whatever comes
    // next (a re-apply, a deactivation and later activation) starts from the live data.
    for (const [id, version] of this.#dataVersions) this.#dataVersions.set(id, version + 1);
    this.#installed = undefined;
    return view;
  }

  /** After the style is dealt with: world copies back, the camera back in geographic space. */
  #finishDeactivate(view: View): void {
    this.#view = undefined;
    this.#appStyle = 'none';
    this.#appRequest = undefined;
    this.#geojson.clear(); // the next activation fetches afresh

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
    if (this.#original && hasOurMetadata(live)) this.#restoreOriginal(this.#original, live);
    this.#rewritten = undefined;
    this.#finishDeactivate(view);
  }

  /**
   * The host the switcher writes its gates through: MapLibre's own `setPaintProperty` and
   * `setLayoutProperty` (rule 4). Through the wrappers, a gate write on the Mercator band's ids
   * (the original's) would be taken for the application's edit and fanned out.
   */
  #switcherHost(): SwitcherHost {
    const host = this.#host;
    const raw = this.#rawStyle;
    return {
      isSourceLoaded: (id) => host.isSourceLoaded(id),
      getZoom: () => host.getZoom(),
      isMoving: () => host.isMoving(),
      jumpTo: (options) => host.jumpTo(options),
      on: (type, listener) => host.on(type, listener),
      off: (type, listener) => host.off(type, listener),
      setPaintProperty: (layerId, name, value) => raw.setPaintProperty(layerId, name, value),
      setLayoutProperty: (layerId, name, value) => raw.setLayoutProperty(layerId, name, value),
    };
  }

  /** Wrap the seven style edits on the map instance; returns the undo (`destroy`/`dispose`). */
  #wrapStyleEdits(): () => void {
    type Edit = (...args: unknown[]) => unknown;
    const handlers: Record<(typeof STYLE_EDITS)[number], Edit> = {
      addSource: (id, source, ...rest) => this.#addSource(id, source, rest),
      removeSource: (id, ...rest) => this.#removeSource(id, rest),
      addLayer: (layer, beforeId, ...rest) => this.#addLayer(layer, beforeId, rest),
      removeLayer: (id, ...rest) => this.#removeLayer(id, rest),
      setPaintProperty: (layerId, name, value, ...rest) => this.#setProperty('paint', layerId, name, value, rest),
      setLayoutProperty: (layerId, name, value, ...rest) => this.#setProperty('layout', layerId, name, value, rest),
      setFilter: (layerId, filter, ...rest) => this.#setProperty('filter', layerId, undefined, filter, rest),
    };
    const host = this.#host;
    const raw = this.#rawStyle;
    const restores = STYLE_EDITS.map((name) => wrapMethod<Edit>(host, name, () => handlers[name]));
    // R16: the application's own `setStyle`; the plugin's calls use the raw one.
    restores.push(wrapMethod<Edit>(host, 'setStyle', () => (style, ...rest) => this.#appSetStyle(style, rest)));
    // R18: an original id that is not live reads as the copy shown, so that `getLayer` agrees
    // with what the wrappers accept and refuse; `queryRenderedFeatures`'s `layers` alike.
    for (const name of LAYER_READS) {
      restores.push(wrapMethod<Edit>(host, name, () => (id, ...rest) => raw[name](this.#resolveId(id), ...rest)));
    }
    restores.push(
      wrapMethod<Edit>(host, 'queryRenderedFeatures', () => (...args) => raw.queryRenderedFeatures(...this.#resolveQuery(args))),
    );
    // R15, R21: the plugin's own `setStyle` is invisible, as a native `addLayer` or `setProjection`
    // is: the `style.load` it fires (`Style.setState`, bubbling through the Map's `fire`) is
    // counted, not delivered.
    restores.push(
      wrapMethod<Edit>(host, 'fire', (original) => (event, ...rest) => {
        const type = eventType(event);
        const loads = this.#ownLoads;
        if (loads && type === 'style.load') {
          loads.count++;
          return host;
        }
        // A style the application asked for that failed to load (R16 bookkeeping); where MapLibre
        // has `_diffStyleRequest`, a URL's fetch is told by that instead (any `error` may come meanwhile).
        if (type === 'error' && (this.#appStyle === 'rebuild' || (this.#appStyle === 'fetch' && this.#diffStyleRequest() === undefined))) {
          this.#appStyle = 'none';
        }
        return original(event, ...rest);
      }),
    );
    return () => {
      for (const restore of restores) restore();
    };
  }

  /**
   * The original while Equal Earth is active and the live style is ours (R19): the application's
   * edits are kept in it, and its ids are translated and refused against it. Otherwise (an
   * application style not captured yet, such as a basemap a `setStyle(url)` diffed in from
   * MapLibre's own fetch, or one captured and awaiting its re-apply) edits go straight to the
   * live style, where the capture, or the re-apply's second look (`#applyNow`), finds them.
   */
  #following(): StyleLike | undefined {
    return this.active && this.#liveIsOurs() ? this.#original : undefined;
  }

  /**
   * Whether the live style is our rewrite: its sentinel layer ({@link #rewrite}) is live, one raw
   * `getLayer`. A rewrite without one (no banded layer, no cartography: nothing to translate) falls
   * back to the `setStyle` bookkeeping.
   */
  #liveIsOurs(): boolean {
    const rewritten = this.#rewritten;
    const sentinel = rewritten ? this.#sentinels.get(rewritten) : undefined;
    if (sentinel === undefined) return !this.#appStyleInFlight();
    return this.#rawStyle.getLayer(sentinel) !== undefined;
  }

  /**
   * The application's `setStyle`: bookkeeping until the style it asked for has arrived (R16, R20).
   * A URL is recorded while inactive too (R22): a restore that aborts it asks for it again.
   */
  #appSetStyle(style: unknown, rest: unknown[]): unknown {
    if (this.active) {
      this.#appStyleCalls++;
      this.#appStyle = 'call';
    }
    // Its `style.load` is the application's, even when it sets a style inside one of ours (R21),
    // the deactivation's restore included (R22).
    const own = this.#ownLoads;
    this.#ownLoads = undefined;
    try {
      return this.#rawStyle.setStyle(style, ...rest);
    } finally {
      this.#ownLoads = own;
      if (typeof style === 'string') this.#appRequest = { url: style, rest, request: this.#diffStyleRequest() };
      // An object diffed in synchronously (captured by `#onStyleLoad`, or nothing changed); a URL
      // arrives later, through MapLibre's own diff (or rebuild, `#onStyleLoading`).
      if (this.#appStyle === 'call') this.#appStyle = typeof style === 'string' ? 'fetch' : 'none';
    }
  }

  /** The live layer an application id reads as: itself if live, else its copy shown, else its first live copy (R18). */
  #resolveId(id: unknown): unknown {
    const original = this.#following();
    if (!original || typeof id !== 'string' || this.#rawStyle.getLayer(id) !== undefined) return id;
    if (!original.layers.some((layer) => layer.id === id)) return id;
    const copies = this.#liveCopies(id);
    const shown = this.#installed?.switcher.current();
    return copies.find((copy) => shown !== undefined && copy === `${id}__b${shown}`) ?? copies[0] ?? id;
  }

  /** `queryRenderedFeatures` arguments with the ids of `options.layers` resolved ({@link #resolveId}). */
  #resolveQuery(args: unknown[]): unknown[] {
    const at = args.findIndex((arg) => isRecord(arg) && 'layers' in arg);
    const options = args[at] as Record<string, unknown> | undefined;
    const layers = options?.['layers'];
    if (!options || !(Array.isArray(layers) || layers instanceof Set) || !this.#following()) return args;
    const resolved = [...(layers as Iterable<unknown>)].map((id) => this.#resolveId(id));
    const copy = [...args];
    copy[at] = { ...options, layers: layers instanceof Set ? new Set(resolved) : resolved };
    return copy;
  }

  #addSource(id: unknown, source: unknown, rest: unknown[]): unknown {
    const before = this.#following();
    if (before && typeof id === 'string' && id in before.sources && this.#host.getSource(id) === undefined) {
      // An original source the live style lacks: refused as MapLibre refuses a duplicate.
      throw new Error(`Source "${id}" already exists.`);
    }
    const result = this.#rawStyle.addSource(id, source, ...rest);
    this.#edits++;
    const original = this.#following();
    // MapLibre throws for a duplicate id, and refuses an invalid source with an `error` event.
    if (original && typeof id === 'string' && isRecord(source) && !(id in original.sources) && this.#host.getSource(id) !== undefined) {
      original.sources[id] = cloneSpec(source);
      this.#scheduleAmend();
    }
    return result;
  }

  #removeSource(id: unknown, rest: unknown[]): unknown {
    const original = this.#following();
    if (!original || typeof id !== 'string' || !(id in original.sources)) {
      const result = this.#rawStyle.removeSource(id, ...rest);
      this.#edits++;
      return result;
    }
    const user = original.layers.find((layer) => layer.source === id);
    if (user) {
      // MapLibre's refusal; under pure Equal Earth no live layer uses the original id, so it would not refuse.
      reportError(this.#host, new Error(`Source "${id}" cannot be removed while layer "${user.id}" is using it.`));
      return this.#host;
    }
    // An original source the live style lacks is removed from the original alone, without error.
    const result = this.#host.getSource(id) !== undefined ? this.#rawStyle.removeSource(id, ...rest) : this.#host;
    delete original.sources[id];
    this.#edits++;
    this.#scheduleAmend();
    return result;
  }

  #addLayer(layer: unknown, beforeId: unknown, rest: unknown[]): unknown {
    const original = this.#following();
    // The original's `beforeId` may have no layer of that id live (pure Equal Earth): insert
    // before its first live copy instead, where the amend puts the new layer's copies.
    const before = original && typeof beforeId === 'string' ? this.#liveBefore(original, beforeId) : beforeId;
    if (!original || !isRecord(layer) || typeof layer['id'] !== 'string' || layer['type'] === 'custom') {
      const result = this.#rawStyle.addLayer(layer, before, ...rest);
      this.#edits++;
      return result;
    }
    const id = layer['id'];
    // A live id (the application's, or a plugin layer's such as `water__b1`): MapLibre refuses it.
    if (this.#rawStyle.getLayer(id) !== undefined) return this.#rawStyle.addLayer(layer, before, ...rest);
    if (original.layers.some((existing) => existing.id === id)) {
      // An original layer that is not live (pure Equal Earth): `getLayer` reads it as its copy
      // (R18), so refuse it as MapLibre refuses a duplicate.
      reportError(this.#host, new Error(`Layer "${id}" already exists on this map.`));
      return this.#host;
    }
    const result = this.#rawStyle.addLayer(layer, before, ...rest);
    if (this.#rawStyle.getLayer(id) === undefined) return result; // refused; MapLibre reported why
    const spec = cloneSpec(layer) as StyleLayerLike;
    const source: unknown = spec.source;
    if (isRecord(source)) {
      // `Style.addLayer` adds an inline source under the layer's id.
      original.sources[id] = source;
      spec.source = id;
    }
    const at = typeof beforeId === 'string' ? original.layers.findIndex((existing) => existing.id === beforeId) : -1;
    original.layers.splice(at < 0 ? original.layers.length : at, 0, spec);
    this.#edits++;
    this.#scheduleAmend();
    return result;
  }

  #removeLayer(id: unknown, rest: unknown[]): unknown {
    const original = this.#following();
    const at = original && typeof id === 'string' ? original.layers.findIndex((layer) => layer.id === id) : -1;
    if (!original || typeof id !== 'string' || at < 0) {
      const result = this.#rawStyle.removeLayer(id, ...rest);
      this.#edits++;
      return result;
    }
    // Under pure Equal Earth, or outside the Mercator band's range, the id itself is not live.
    const result = this.#rawStyle.getLayer(id) !== undefined ? this.#rawStyle.removeLayer(id, ...rest) : this.#host;
    original.layers.splice(at, 1);
    this.#edits++;
    this.#scheduleAmend();
    return result;
  }

  /**
   * `setPaintProperty` (`paint`), `setLayoutProperty` (`layout`) or `setFilter` (`filter`, no
   * `name`) by the application: see the module comment.
   */
  #setProperty(kind: PropertyKind, layerId: unknown, name: unknown, value: unknown, rest: unknown[]): unknown {
    const raw = this.#rawStyle;
    const write = (id: unknown): unknown =>
      kind === 'paint'
        ? raw.setPaintProperty(id, name, value, ...rest)
        : kind === 'layout'
          ? raw.setLayoutProperty(id, name, value, ...rest)
          : raw.setFilter(id, value, ...rest);
    const original = this.#following();
    const layer = original && typeof layerId === 'string' ? original.layers.find((l) => l.id === layerId) : undefined;
    const property = typeof name === 'string' ? name : undefined;
    if (!original || !layer || (kind !== 'filter' && property === undefined)) {
      const result = write(layerId);
      this.#edits++;
      return result;
    }
    const installed = this.#installed;
    const rewritten = installed ? this.#rewritten : undefined;
    // The first background's copies are not plain clones (outside colour, world polygon): the
    // rewrite derives them, so its edits are amended in. With nothing installed, a re-apply is in
    // flight and rewrites the original. Either way only the layer under the id itself is written.
    const derived = layer.type === 'background' && original.layers.find((l) => l.type === 'background') === layer;
    const plain = rewritten !== undefined && !derived;
    const copies = this.#liveCopies(layer.id).filter((id) => plain || id === layer.id);
    const shown = installed?.switcher.current();
    const fading = new Set(installed?.switcher.pendingHides());
    const gateOf = (id: string): LayerGate | undefined => rewritten?.gates.find((gate) => gate.layerId === id);
    const gated = (gate: LayerGate | undefined): gate is LayerGate =>
      gate !== undefined &&
      (kind === 'paint' ? property! in gate.paint : kind === 'layout' && property === 'visibility' && gate.hideByVisibility);
    let checked = false;
    for (const id of copies) {
      const gate = gateOf(id);
      // A gated value is the gate's own: written only where the gate shows it.
      if (gated(gate) && gate.band !== shown && !(gate.holdWhileFading && fading.has(gate.band))) continue;
      write(id);
      if (!checked) {
        checked = true;
        if (!this.#accepted(kind, id, property, value)) return this.#host;
      }
    }
    if (plain) {
      for (const id of copies) {
        const gate = gateOf(id);
        if (!gated(gate)) continue;
        if (kind === 'paint') gate.paint = { ...gate.paint, [property!]: ownValue(value) };
        else gate.visibility = ownValue(value);
      }
    }
    setLayerProperty(layer, kind, property, value);
    this.#edits++;
    if (derived) this.#scheduleAmend();
    return this.#host;
  }

  /**
   * Whether MapLibre took `value` on live layer `id`, read back through its getter: an invalid
   * value is refused with an `error` event and must not reach the other copies or the original.
   * Without the getter, assumed.
   */
  #accepted(kind: PropertyKind, id: string, property: string | undefined, value: unknown): boolean {
    const raw = this.#rawStyle;
    let read: unknown;
    try {
      // A map without the getter throws here (`rawStyle`): assumed accepted.
      if (kind === 'paint') read = raw.getPaintProperty(id, property);
      else if (kind === 'layout') read = raw.getLayoutProperty(id, property);
      else read = raw.getFilter(id);
    } catch {
      return true;
    }
    return JSON.stringify(read ?? null) === JSON.stringify(value ?? null);
  }

  /** The live layers drawn for the original's layer `id`, in style order: its band copies, then itself. */
  #liveCopies(id: string): string[] {
    const ids = this.#bands.flatMap((band, k) => (band.blend < 1 ? [`${id}__b${k}`] : []));
    ids.push(id);
    return ids.filter((candidate) => this.#rawStyle.getLayer(candidate) !== undefined);
  }

  /** The live layer to insert before for the original's `beforeId`: its first live copy, else the next layer's. */
  #liveBefore(original: StyleLike, beforeId: string): string | undefined {
    const at = original.layers.findIndex((layer) => layer.id === beforeId);
    if (at < 0) return beforeId;
    for (const layer of original.layers.slice(at)) {
      const first = this.#liveCopies(layer.id)[0];
      if (first !== undefined) return first;
    }
    return undefined;
  }

  /** One amend per task, however many edits it holds. */
  #scheduleAmend(): void {
    if (this.#applying) {
      // An edit inside the plugin's own `setStyle` (an application listener of an event it fires):
      // amend in a new macrotask, never in the running amend loop, so no listener can spin it. An
      // amend that reads the original before then takes the edit, and the timer finds nothing to do.
      this.#amendDeferred = true;
      this.#amendTimer ??= setTimeout(() => {
        this.#amendTimer = undefined;
        if (!this.#amendDeferred) return;
        this.#amendDeferred = false;
        this.#scheduleAmend();
      }, 0);
      return;
    }
    this.#amendRequested = true;
    if (this.#amendQueued || this.#amendRunning) return;
    this.#amendQueued = true;
    queueMicrotask(() => {
      this.#amendQueued = false;
      void this.#runAmend();
    });
  }

  /**
   * Rewrite the original with the application's edits and diff it in (see the module comment).
   * Only while installed: a re-apply in flight reads the original itself and amends after it has
   * installed. Waits only to fetch a source that is not cached yet; edits made meanwhile join it.
   */
  async #runAmend(): Promise<void> {
    this.#amendRunning = true;
    try {
      while (this.#amendRequested) {
        // An apply in flight keeps the request: it re-schedules it once it has finished (R17).
        if (this.#inFlight !== undefined || this.#applying) return;
        this.#amendRequested = false;
        const installed = this.#installed;
        const original = this.#original;
        if (!this.active || !installed || !original) return;
        const generation = this.#generation;
        const failed = new Set<string>();
        for (;;) {
          if (this.#appStyleInFlight()) {
            // R20: our `setStyle` would abort the application's. Its style arrives (captured and
            // re-applied, which takes every edit: this amend is moot), or the fetch fails or
            // changes nothing, and the amend goes ahead.
            await this.#appStyleSettled(generation);
            if (generation !== this.#generation || this.#installed !== installed || this.#original !== original) return;
            this.#amendRequested = false; // the edits made meanwhile are in the original: this pass takes them
            continue;
          }
          this.#amendDeferred = false; // this pass reads the original: it takes every edit so far
          this.#refreshGeoJSONData(original);
          const { resolved, missing } = this.#resolveNow(original, failed);
          if (missing.length === 0) {
            this.#amendNow(installed, original, resolved);
            break;
          }
          await Promise.all(
            missing.map(({ id, load }) =>
              load().catch((error: unknown) => {
                failed.add(id);
                if (generation === this.#generation) reportError(this.#host, error);
              }),
            ),
          );
          if (generation !== this.#generation || this.#installed !== installed || this.#original !== original) return;
          this.#amendRequested = false; // the edits made meanwhile are in the original: this pass takes them
        }
      }
    } catch (error) {
      reportError(this.#host, error);
    } finally {
      this.#amendRunning = false;
      // An edit made while this loop waited, which it then gave up (a re-apply took over): no apply
      // in flight will pick it up, so run again (and stop at once if nothing is installed).
      if (this.#amendRequested && this.#inFlight === undefined && this.#installed) this.#scheduleAmend();
    }
  }

  /**
   * The sources of `style` resolved from the caches alone, and the fetches still missing. A source
   * that cannot be resolved at all (TMS, no tiles) is reported once and stays unbanded, as do those
   * in `failed`.
   */
  #resolveNow(
    style: StyleLike,
    failed: ReadonlySet<string>,
  ): { resolved: ResolvedSources; missing: { id: string; load: () => Promise<unknown> }[] } {
    const resolved: ResolvedSources = { templates: {}, geojson: {} };
    const missing: { id: string; load: () => Promise<unknown> }[] = [];
    for (const [id, source] of Object.entries(style.sources)) {
      if (failed.has(id)) continue;
      const data = source['data'];
      if (source['type'] === 'geojson' && typeof data === 'string') {
        const cached = this.#geojson.get(data);
        if (cached) resolved.geojson[id] = cached;
        else missing.push({ id, load: () => this.#loadGeoJSON(id, data, false) });
        continue;
      }
      try {
        const template = this.#templateNow(id, source);
        if (template) resolved.templates[id] = template;
        else if (template === undefined) missing.push({ id, load: () => this.#tileJsonTemplate(id, source['url'] as string) });
      } catch (error) {
        if (!this.#reported.has(source)) {
          this.#reported.add(source);
          reportError(this.#host, error);
        }
      }
    }
    return { resolved, missing };
  }

  /** Rewrite `original` in the band shown and diff it in over the live style. */
  #amendNow(installed: Installed, original: StyleLike, resolved: ResolvedSources): void {
    const previous = this.#rewritten;
    const live = this.#readStyle();
    if (!previous || !live) return;
    try {
      takeLiveRoot(original, live);
      const { switcher, camera } = installed;
      const rewritten = this.#rewrite(original, resolved, camera.requestedZoom, switcher.current());
      // A band still fading out keeps its live state (gated paint 0, but held bases shown and
      // labels visible) until its pending hide, which reads these gates, fires.
      const existed = new Set(previous.style.layers.map((layer) => layer.id));
      const into = gateHostOf(rewritten.style);
      for (const band of switcher.pendingHides()) {
        for (const gate of rewritten.gatesForBand(band)) {
          if (!existed.has(gate.layerId)) continue;
          applyGate(into, gate, 'shown');
          applyGate(into, gate, 'fading');
        }
      }
      const host = this.#host;
      let rebuilt = false;
      const onLoading = (): void => {
        rebuilt = true;
      };
      const calls = this.#appStyleCalls;
      host.on('styledataloading', onLoading);
      this.#rewritten = rewritten;
      let loads: number;
      try {
        loads = this.#setStyle(rewritten.style); // its `style.load` is swallowed (R15)
      } finally {
        host.off('styledataloading', onLoading);
      }
      if (rebuilt || this.#appStyleCalls !== calls) {
        // MapLibre could not diff ours, or an application listener of an event our `setStyle`
        // fired set a style of its own inside it, and `#applying` hid its events. Handle them
        // now, as if they had been heard.
        const after = this.#readStyle();
        if (after === undefined) this.#onStyleLoading();
        else if (!hasOurMetadata(after)) this.#onStyleLoad();
        return;
      }
      // No `style.load`: nothing changed, or MapLibre refused the style (its validation errors
      // are `error` events). A refused style left the previous rewrite live.
      const added = rewritten.style.layers.find((layer) => !existed.has(layer.id));
      if (loads === 0 && added && this.#rawStyle.getLayer(added.id) === undefined) {
        this.#rewritten = previous;
        throw new Error('Equal Earth: the map did not accept the amended style; the edit reaches the Mercator band only.');
      }
      this.#wrapGeoJSONSources(installed, rewritten.geojsonSources);
    } catch (error) {
      reportError(this.#host, error);
    }
  }

  /**
   * Wrap the live `setData`/`updateData` of each banded GeoJSON source (spec §7, rule 4) so every
   * band copy follows. The Mercator band keeps the original id, so `getSource(id)` is the
   * application's own source object under either type. `installed.geojson` ends up holding exactly
   * the sources of `ids`: one already wrapped keeps its wrappers, one that left the bands (an
   * amend after `removeSource`) or whose object was replaced loses them, and any fetch or
   * `updateData` its wrappers started is dropped.
   */
  #wrapGeoJSONSources(installed: Installed, ids: readonly string[]): void {
    type Method = (first: unknown, ...rest: unknown[]) => unknown;
    const wanted = new Set(ids);
    for (const [id, wrap] of installed.geojson) {
      if (wanted.has(id) && this.#host.getSource(id) === wrap.source) continue;
      wrap.restore();
      installed.geojson.delete(id);
      this.#nextDataVersion(id);
    }
    for (const id of ids) {
      const source = this.#host.getSource(id);
      if (installed.geojson.has(id) || typeof source !== 'object' || source === null) continue;
      const restores = [
        wrapMethod<Method>(source, 'setData', (original) => (data, ...rest) => {
          const result = original(data, ...rest);
          this.#onSetData(id, data);
          return result;
        }),
        wrapMethod<Method>(source, 'updateData', (original) => (diff, ...rest) => {
          const result = original(diff, ...rest);
          this.#onUpdateData(id, source);
          return result;
        }),
      ];
      installed.geojson.set(id, {
        source,
        restore: () => {
          for (const restore of restores) restore();
        },
      });
    }
  }

  /** The next data version of GeoJSON source `id`: a result for an older one is stale. */
  #nextDataVersion(id: string): number {
    const version = (this.#dataVersions.get(id) ?? 0) + 1;
    this.#dataVersions.set(id, version);
    return version;
  }

  /** The application set `data` on GeoJSON source `id`: keep it as the original's and fan it out. */
  #onSetData(id: string, data: unknown): void {
    const version = this.#nextDataVersion(id);
    if (typeof data === 'object' && data !== null) this.#warped.delete(data); // perhaps mutated since
    this.#keepOriginalData(id, data);
    if (typeof data !== 'string') {
      this.#fanOut(id, data);
      return;
    }
    // A URL: MapLibre loads it for the source itself; the copies need it here. Fetched afresh
    // (an application polling one URL expects new content) and cached for a re-apply.
    this.#loadGeoJSON(id, data, true).then(
      (resolved) => {
        if (this.#dataVersions.get(id) === version) this.#fanOut(id, resolved);
      },
      (error: unknown) => {
        if (this.#dataVersions.get(id) === version && this.active) reportError(this.#host, error);
      },
    );
  }

  /**
   * The application sent a diff to GeoJSON source `id`. MapLibre applies it to the source's data
   * only once the worker has answered (`_dispatchWorkerUpdate` → `_applyDiffToSource`, v6 and
   * v5.24), so a `getData()` right away would still read the old data: wait until the source is
   * loaded again, then fan the full data out. Should the worker fail (no `data` event), the wait
   * ends with the source's next update, whose own fan-out supersedes this one.
   */
  #onUpdateData(id: string, source: GeoJSONSourceLike): void {
    const version = this.#nextDataVersion(id);
    const settled = async (): Promise<unknown> => {
      while (source.loaded?.() === false && typeof source.once === 'function') {
        await new Promise<void>((resolve) => source.once!('data', () => resolve()));
        if (this.#dataVersions.get(id) !== version) return undefined;
      }
      return source.getData?.();
    };
    settled().then(
      (data) => {
        if (this.#dataVersions.get(id) !== version || data === undefined) return;
        this.#keepOriginalData(id, data);
        this.#fanOut(id, data);
      },
      (error: unknown) => {
        if (this.#dataVersions.get(id) === version && this.active) reportError(this.#host, error);
      },
    );
  }

  /** Make `data` the original's for GeoJSON source `id`, so a re-apply and the restore keep it. */
  #keepOriginalData(id: string, data: unknown): void {
    const source = this.active ? this.#original?.sources[id] : undefined;
    if (source?.['type'] === 'geojson') source['data'] = data;
  }

  /**
   * `setData` on every band copy of GeoJSON source `id`, with `data` warped for that band. A
   * failure (malformed GeoJSON) is reported, never thrown into the application's `setData`.
   */
  #fanOut(id: string, data: unknown): void {
    if (!this.active) return;
    const bands = this.#bands;
    const transition = this.#transition;
    try {
      bands.forEach((band, k) => {
        if (band.blend >= 1) return;
        const copy = this.#host.getSource(bandSourceId(id, bands, k)) as GeoJSONSourceLike | undefined;
        copy?.setData?.(this.#warp(data as GeoJSON.GeoJSON, band.blend, geojsonZoomForBand(transition, k)));
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reportError(this.#host, new Error(`Equal Earth: could not warp the GeoJSON of source "${id}": ${reason}`, { cause: error }));
    }
  }

  /**
   * The templates of the vector sources and the data of the GeoJSON sources given by URL. An
   * activation fetches GeoJSON afresh (`freshGeoJSON`: a feed polled while in Mercator has moved
   * on); a re-apply within one activation is served from the cache.
   */
  async #resolveSources(style: StyleLike, freshGeoJSON = false): Promise<ResolvedSources> {
    const [templates, geojson] = await Promise.all([this.#templates(style), this.#geojsonData(style, freshGeoJSON)]);
    return { templates, geojson };
  }

  /** The fetched data of every GeoJSON source of `style` given by URL, by source id. */
  async #geojsonData(style: StyleLike, fresh: boolean): Promise<Record<string, GeoJSON.GeoJSON>> {
    const resolved: Record<string, GeoJSON.GeoJSON> = {};
    await Promise.all(
      Object.entries(style.sources).map(async ([id, source]) => {
        const url = source['data'];
        if (source['type'] !== 'geojson' || typeof url !== 'string') return;
        resolved[id] = await this.#loadGeoJSON(id, url, fresh);
      }),
    );
    return resolved;
  }

  /**
   * Copy the live data of each GeoJSON source of `original` into it: the URL or the object that
   * `serialize()` reports (both majors: `_data.url`, `_data.geojson` or the updateable features).
   * `getSource(id)` is the application's source here, or the Mercator band's under our own style,
   * which keeps the original id and geographic data. A source the map lacks is left alone. Returns
   * whether some source's data became a URL other than the one `original` had, which must be
   * resolved before rewriting.
   *
   * An `updateData` still with the worker is not in `serialize()` yet; it reaches the copies only
   * through the wrappers' next fan-out.
   */
  #refreshGeoJSONData(original: StyleLike): boolean {
    let newUrl = false;
    for (const [id, source] of Object.entries(original.sources)) {
      if (source['type'] !== 'geojson') continue;
      const live = this.#host.getSource(id) as GeoJSONSourceLike | undefined;
      const serialized = typeof live?.serialize === 'function' ? live.serialize() : undefined;
      const data = typeof serialized === 'object' && serialized !== null ? (serialized as { data?: unknown }).data : undefined;
      if (typeof data === 'string') {
        if (data !== source['data']) newUrl = true;
        source['data'] = data;
      } else if (typeof data === 'object' && data !== null) {
        source['data'] = data;
      }
    }
    return newUrl;
  }

  /** GeoJSON source `id`'s data at `url`: from the cache unless `fresh`; cached either way. */
  async #loadGeoJSON(id: string, url: string, fresh: boolean): Promise<GeoJSON.GeoJSON> {
    const cached = fresh ? undefined : this.#geojson.get(url);
    if (cached) return cached;
    let json: unknown;
    try {
      json = await this.#fetchJson(url);
    } catch (error) {
      throw unloaded(id, error instanceof Error ? error.message : String(error), error);
    }
    if (!json || typeof json !== 'object' || typeof (json as { type?: unknown }).type !== 'string') {
      throw unloaded(id, 'the response is not GeoJSON');
    }
    this.#geojson.set(url, json as GeoJSON.GeoJSON);
    return json as GeoJSON.GeoJSON;
  }

  /** The vector sources' templates, from the inline source or its fetched TileJSON (P14). */
  async #templates(style: StyleLike): Promise<Record<string, SourceTemplate>> {
    const templates: Record<string, SourceTemplate> = {};
    await Promise.all(
      Object.entries(style.sources).map(async ([id, source]) => {
        let resolved = this.#templateNow(id, source);
        if (resolved === undefined) resolved = finishTemplate(id, source, await this.#tileJsonTemplate(id, source['url'] as string));
        if (resolved) templates[id] = resolved;
      }),
    );
    return templates;
  }

  /**
   * Source `id`'s template without fetching: `null` when it is not a vector source with tiles or a
   * TileJSON URL, `undefined` when its TileJSON is not cached yet. Throws as resolving does (TMS,
   * no tiles).
   */
  #templateNow(id: string, source: Record<string, unknown>): SourceTemplate | null | undefined {
    if (source['type'] !== 'vector') return null;
    if (Array.isArray(source['tiles'])) {
      const resolved = template(source);
      if (resolved.tiles.length === 0) throw unresolved(id, 'the source lists no tiles');
      return finishTemplate(id, source, resolved);
    }
    const url = source['url'];
    if (typeof url !== 'string') return null;
    const cached = this.#tileJson.get(url);
    return cached ? finishTemplate(id, source, cached) : undefined;
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
    return withoutRewriteBounds(structuredClone(style), this.#rewritten?.style, this.#original);
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

function unloaded(id: string, reason: string, cause?: unknown): Error {
  return new Error(`Equal Earth: could not load GeoJSON for source "${id}": ${reason}`, { cause });
}

/** MapLibre's style edits on `host` as found now, before the controller wraps them. */
function rawStyle(host: ControllerHost): RawStyle {
  const slots = host as unknown as Record<string, unknown>;
  const raw: Partial<Record<keyof RawStyle, (...args: unknown[]) => unknown>> = {};
  for (const name of RAW_METHODS) {
    const method = slots[name];
    raw[name] = (...args: unknown[]): unknown => {
      if (typeof method !== 'function') throw new TypeError(`Equal Earth: the map has no ${name}.`);
      return (method as (...args: unknown[]) => unknown).apply(host, args);
    };
  }
  return raw as RawStyle;
}

/** An event's type, as `Evented.fire` takes it: an event object or a type string. */
function eventType(event: unknown): unknown {
  return typeof event === 'string' ? event : (event as { type?: unknown } | null)?.type;
}

function unwrapGeoJSON(installed: Installed): void {
  for (const wrap of installed.geojson.values()) wrap.restore();
  installed.geojson.clear();
}

/**
 * Take the style's root properties from the live style into `original`: what the application
 * changed through setters the controller does not follow (`setLight`, `setSky`, `setGlyphs`, …),
 * so that a rewrite of `original` diffed over the live style, or its restore, does not revert it.
 * The properties the rewrite owns are left alone.
 */
function takeLiveRoot(original: StyleLike, live: StyleLike | undefined): void {
  if (!live) return;
  for (const [key, value] of Object.entries(live)) {
    if (!REWRITE_ROOT.has(key)) original[key] = structuredClone(value);
  }
  for (const key of SERIALIZED_ROOT) if (!(key in live)) delete original[key];
}

/** A {@link GateHost} that writes into a style object rather than a map. */
function gateHostOf(style: StyleLike): GateHost {
  const layers = new Map(style.layers.map((layer) => [layer.id, layer]));
  return {
    setPaintProperty: (id, name, value) => {
      const layer = layers.get(id);
      if (layer) setOrDelete((layer.paint ??= {}), name, value);
    },
    setLayoutProperty: (id, name, value) => {
      const layer = layers.get(id);
      if (layer) setOrDelete((layer.layout ??= {}), name, value);
    },
  };
}

function setLayerProperty(layer: StyleLayerLike, kind: PropertyKind, property: string | undefined, value: unknown): void {
  if (kind === 'filter') setOrDelete(layer, 'filter', value);
  else setOrDelete((layer[kind] ??= {}), property!, value);
}

/** `target[key] = value`, or its removal for `undefined` or `null` (MapLibre's reset to the default). */
function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null) delete target[key];
  else target[key] = structuredClone(value);
}

/** A gate's own value: `null` resets, as `undefined` does. */
function ownValue(value: unknown): unknown {
  return value === null || value === undefined ? undefined : structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A copy of an application's source or layer spec to keep; shallow if it holds what cannot be cloned. */
function cloneSpec(spec: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(spec);
  } catch {
    return { ...spec };
  }
}

/** A resolved template as a band source inherits it: refused for TMS, with the source's `promoteId`. */
function finishTemplate(id: string, source: Record<string, unknown>, resolved: SourceTemplate & { tms?: boolean }): SourceTemplate {
  if (source['scheme'] === 'tms' || resolved.tms) {
    // The eqearth URL's {z}/{x}/{y} are the output tile; MapLibre's TMS y-flip would corrupt them.
    throw new Error(`Equal Earth: TMS tile schemes are not supported yet (source "${id}").`);
  }
  const kept: SourceTemplate & { tms?: boolean } = { ...resolved };
  delete kept.tms;
  if (source['promoteId'] !== undefined) kept.promoteId = source['promoteId'];
  return kept;
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

