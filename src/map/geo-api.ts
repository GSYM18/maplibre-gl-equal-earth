/**
 * The geographic API (spec §7, audit `docs/superpowers/audits/2026-10-11-geo-api-audit.md`):
 * while Equal Earth is active, a map's `project`, `unproject`, `getCenter` and `getBounds` speak
 * geographic coordinates instead of the map space the Mercator renderer is fed.
 *
 * Each method is wrapped **per instance** ({@link wrapMethod}); MapLibre captures no method
 * references (audit §0.2), so its own callers (Marker, Popup, mouse events, `Hash`,
 * `ScaleControl`) see the wrapped reads as well, and all of them want geographic values
 * (audit §1, §8). Reads convert with the blend of the band **shown** now (audit §3): T's centre
 * is in that band's map space.
 *
 * Camera targets (`center` and `around` of `jumpTo`, `easeTo`, `flyTo` and the options-only
 * methods, `setCenter`'s and `panTo`'s position) convert with the blend of the **baseline** band,
 * the space of the requested camera state R, read after the stop the original would make
 * (audit §3, §4). Whether a value needs converting is decided per **value**, never per caller
 * (audit §7): MapLibre's own handlers and Camera chains hand these methods map-space values (the
 * rendered or requested centre by identity, or a value marked with {@link markMapSpace}), while
 * application listeners run synchronously inside camera calls and must still be converted.
 * `cameraForBounds`/`fitBounds` are reimplemented across bands (audit §5, {@link fitAcrossBands}).
 *
 * Every wrapper reads its {@link GeoApiState} live and passes the call through untouched while
 * the state is inactive (Mercator, globe, before the first activation).
 *
 * Like every `map/` module this has no runtime dependency on `maplibre-gl`.
 */

import {
  geographicToMap,
  mapSpaceMaxLatitude,
  mapSpaceMaxLongitude,
  mapToGeographic,
  wrapLongitude,
} from '../math/backproject.js';
import type { LngLatTuple } from '../math/equal-earth.js';
import { bandIndexForZoom, type Band } from './bands.js';
import { wrapMethod } from './instance-wrap.js';

export type { LngLatTuple };

/** What the wrappers read from the controller, live, on every call. */
export interface GeoApiState {
  /** False while inactive, during globe, or before the first activation: everything passes through. */
  readonly active: boolean;
  /** Blend of the band shown now (T's centre): reads convert with it. */
  readonly blend: number;
  /** Blend of the band the requested camera state R is in: targets convert with it (Task 7). */
  readonly baselineBlend: number;
  /** The bands in effect (Task 7's fitBounds solves over them). */
  readonly bands: readonly Band[];
  /**
   * The zoom and bearing offsets the requested camera state R carries (`BandCamera`'s baseline
   * offsets): the camera hook subtracts them from a requested zoom and bearing. Zero without
   * compensation.
   */
  readonly baselineOffsets: CameraOffsets;
  /**
   * The offsets the camera hook renders band `band` with at `geographic` for the requested zoom
   * `requestedZoom` (`similarityOffsets` with the controller's mode and transition); zero
   * without compensation. `cameraForBounds` solves with them (Ruling R11).
   */
  offsets: OffsetsAt;
}

/** Zoom and bearing offsets of the camera's compensation (spec §4.2), structurally `SimilarityOffsets`. */
export interface CameraOffsets {
  readonly deltaZoom: number;
  readonly deltaBearing: number;
}

/** The offsets the camera hook renders `band` with at `geographic` for `requestedZoom`. */
export type OffsetsAt = (geographic: LngLatTuple, band: number, requestedZoom: number) => CameraOffsets;

export interface GeoApiFactories {
  lngLat(lng: number, lat: number): { lng: number; lat: number };
  lngLatBounds(sw: LngLatTuple, ne: LngLatTuple): unknown;
}

/** What MapLibre's `cameraForBounds` returns (`CenterZoomBearing`, every field optional). */
export interface CameraFit {
  center?: unknown;
  zoom?: number;
  bearing?: number;
}

/** The map methods the geographic API wraps (both majors have them). */
export interface GeoApiHost {
  project(lngLat: unknown): { x: number; y: number };
  unproject(point: unknown): { lng: number; lat: number };
  getCenter(): { lng: number; lat: number };
  getBounds(): unknown;
  jumpTo(options: object, eventData?: unknown): unknown;
  setCenter(center: unknown, eventData?: unknown): unknown;
  easeTo(options: object, eventData?: unknown): unknown;
  flyTo(options: object, eventData?: unknown): unknown;
  panTo(lngLat: unknown, options?: object, eventData?: unknown): unknown;
  panBy(offset: unknown, options?: object, eventData?: unknown): unknown;
  zoomTo(zoom: number, options?: object, eventData?: unknown): unknown;
  zoomIn(options?: object, eventData?: unknown): unknown;
  zoomOut(options?: object, eventData?: unknown): unknown;
  rotateTo(bearing: number, options?: object, eventData?: unknown): unknown;
  resetNorth(options?: object, eventData?: unknown): unknown;
  resetNorthPitch(options?: object, eventData?: unknown): unknown;
  snapToNorth(options?: object, eventData?: unknown): unknown;
  cameraForBounds(bounds: unknown, options?: object): CameraFit | undefined;
  fitBounds(bounds: unknown, options?: object, eventData?: unknown): unknown;
  stop(): unknown;
}

/** The camera methods of {@link GeoApiHost}: what a host may have for the targets to be wrapped. */
export type GeoCameraMethods = Omit<GeoApiHost, 'project' | 'unproject' | 'getCenter' | 'getBounds' | 'jumpTo'>;

/** MapLibre's own methods, unconverted, captured before wrapping: what the plugin itself calls. */
export interface RawCamera {
  getCenter(): { lng: number; lat: number };
  jumpTo(options: object, eventData?: unknown): unknown;
  unproject(point: unknown): { lng: number; lat: number };
  /** MapLibre's `stop()`; a no-op on a host without one. */
  stop(): unknown;
}

export interface GeoApi {
  readonly raw: RawCamera;
  uninstall(): void;
}

/** The part of a transform `getBounds` samples (both majors). */
export interface BoundsTransform {
  readonly width: number;
  readonly height: number;
  screenPointToLocation(point: { x: number; y: number }): { lng: number; lat: number };
  isPointOnMapSurface(point: { x: number; y: number }): boolean;
}

const MAP_SPACE_KEY = Symbol.for('equal-earth:map-space');

/**
 * Values MapLibre (or the plugin) produced in map space. Shared through the global symbol
 * registry, like the `TransformProvider` patch's marker ({@link markTransformProviders}): a
 * second copy of this module on the page (HMR, two bundles) must see the same marks, or it
 * would convert what the first copy's patch marked.
 */
const mapSpace: WeakSet<object> = ((globalThis as Record<symbol, unknown>)[MAP_SPACE_KEY] ??= new WeakSet<object>()) as WeakSet<object>;

/** Mark a value MapLibre produced in map space: target wrappers pass it through unconverted. */
export function markMapSpace<T extends object>(value: T): T {
  mapSpace.add(value);
  return value;
}

export function isMarkedMapSpace(value: unknown): boolean {
  return typeof value === 'object' && value !== null && mapSpace.has(value);
}

/**
 * `[lng, lat]`, `{lng, lat}` or `{lon, lat}` → tuple; `undefined` for anything else. Read
 * exactly as MapLibre's `LngLat.convert` reads it: an array of two or three (the third,
 * altitude, ignored), or an object with `lng` (else `lon`) and `lat`, each coerced with
 * `Number()` (so `'10'` is 10 and `null` is 0). Unlike `LngLat`, which would throw on them,
 * a value that coerces to a non-finite number gives `undefined`.
 */
export function lngLatTuple(value: unknown): LngLatTuple | undefined {
  let lng: unknown;
  let lat: unknown;
  if (Array.isArray(value)) {
    if (value.length !== 2 && value.length !== 3) return undefined;
    [lng, lat] = value as unknown[];
  } else if (typeof value === 'object' && value !== null) {
    const object = value as { lng?: unknown; lon?: unknown; lat?: unknown };
    lng = 'lng' in object ? object.lng : object.lon;
    lat = object.lat;
  } else {
    return undefined;
  }
  const tuple: LngLatTuple = [Number(lng), Number(lat)];
  return Number.isFinite(tuple[0]) && Number.isFinite(tuple[1]) ? tuple : undefined;
}

/**
 * Geographic → map space of `blend`, for any longitude: world copies are kept
 * (`k = round(lng / 360)`, convert `lng − 360k`, add `360k` back), as MapLibre's Marker
 * `smartWrap` can hand `project` a longitude beyond ±180° (audit §8).
 *
 * ±180° themselves are not shifted: on Equal Earth they are the opposite edges of the world,
 * so `k` is the shift {@link wrapLongitude} applies (0 on `[-180, 180]`), not `round`, which
 * would move 180° onto the western edge.
 */
export function mapSpaceOf(lngLat: LngLatTuple, blend: number): LngLatTuple {
  const wrapped = wrapLongitude(lngLat[0]);
  const shift = lngLat[0] - wrapped;
  const mapped = geographicToMap([wrapped, lngLat[1]], blend);
  return [mapped[0] + shift, mapped[1]];
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * Map space of `blend` → geographic, first clamped into the band's world as the camera
 * does (moved here from the controller's private `centreToGeographic`). Always finite with
 * |lat| ≤ 90: MapLibre's `new LngLat` throws otherwise, inside every mousemove (audit §1).
 *
 * A point beyond the rounded outline has no geographic meaning; it reads as the nearest point
 * of the outline along its parallel, or as the pole (exactly ±90°) on or above the pole line.
 * A non-finite input coordinate is returned as it came.
 */
export function geographicUnder(mapLngLat: LngLatTuple, blend: number): LngLatTuple {
  const maxLat = mapSpaceMaxLatitude(blend);
  const lat = clamp(mapLngLat[1], -maxLat, maxLat);
  const maxLng = mapSpaceMaxLongitude(lat, blend);
  const lng = clamp(mapLngLat[0], -maxLng, maxLng);
  const geographic = mapToGeographic([lng, lat], blend);
  if (Number.isFinite(geographic[0]) && Number.isFinite(geographic[1])) {
    // Equal Earth's pole is a line: a point on or above it is the pole itself, exactly (the
    // blended inverse is only ~1e-6° accurate there). Mercator's edge is 85.05°, not a pole.
    const pole = blend < 1 && Math.abs(lat) === maxLat;
    return [clamp(geographic[0], -180, 180), pole ? Math.sign(lat) * 90 : clamp(geographic[1], -90, 90)];
  }
  return [clamp(lng, -180, 180), clamp(lat, -90, 90)];
}

/** Samples per viewport edge for {@link geographicBounds}. */
const BOUNDS_SAMPLES_PER_EDGE = 16;
/** Bisection steps for the top of the visible ground under pitch. */
const HORIZON_STEPS = 20;

/**
 * Audit §6: the geographic bbox of the visible part of the world.
 *
 * The geographic extremes of the visible region lie on its boundary: the viewport's perimeter
 * below the horizon, plus whatever part of the world's outline is inside it. So the perimeter is
 * sampled (16 points per edge, from the top of the visible ground), each sample clamped onto the
 * band's world as the camera does, and converted. A sample clamped to the world's top or bottom
 * edge means that edge is in view: under Equal Earth it is the pole line, so the bound is ±90°
 * (in the Mercator band the edge is Mercator's ±85.05°, kept as it is). One clamped to a side
 * edge extends the longitude to ∓180°. World copies are off while active, so west < east.
 */
export function geographicBounds(transform: BoundsTransform, blend: number): [sw: LngLatTuple, ne: LngLatTuple] {
  const { width, height } = transform;
  let top = 0;
  if (!transform.isPointOnMapSurface({ x: width / 2, y: 0 })) {
    let above = 0;
    let below = height;
    for (let i = 0; i < HORIZON_STEPS; i++) {
      const mid = (above + below) / 2;
      if (transform.isPointOnMapSurface({ x: width / 2, y: mid })) below = mid;
      else above = mid;
    }
    top = below;
  }

  const maxLat = mapSpaceMaxLatitude(blend);
  const poleIsLine = blend < 1;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let northEdge = false;
  let southEdge = false;
  let westEdge = false;
  let eastEdge = false;

  const corners: [number, number][] = [[0, top], [width, top], [width, height], [0, height]];
  for (let edge = 0; edge < 4; edge++) {
    const [x0, y0] = corners[edge]!;
    const [x1, y1] = corners[(edge + 1) % 4]!;
    for (let i = 0; i < BOUNDS_SAMPLES_PER_EDGE; i++) {
      const t = i / BOUNDS_SAMPLES_PER_EDGE;
      const location = transform.screenPointToLocation({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
      let lat = location.lat;
      let lng = location.lng;
      if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
      if (lat >= maxLat) {
        lat = maxLat;
        northEdge = true;
      } else if (lat <= -maxLat) {
        lat = -maxLat;
        southEdge = true;
      }
      const maxLng = mapSpaceMaxLongitude(lat, blend);
      if (lng <= -maxLng) {
        lng = -maxLng;
        westEdge = true;
      } else if (lng >= maxLng) {
        lng = maxLng;
        eastEdge = true;
      }
      const [gLng, gLat] = mapToGeographic([lng, lat], blend);
      if (!Number.isFinite(gLng) || !Number.isFinite(gLat)) continue;
      if (gLng < west) west = gLng;
      if (gLng > east) east = gLng;
      if (gLat < south) south = gLat;
      if (gLat > north) north = gLat;
    }
  }
  if (!(west <= east && south <= north)) return [[-180, -90], [180, 90]];
  if (northEdge && poleIsLine) north = 90;
  if (southEdge && poleIsLine) south = -90;
  if (westEdge) west = -180;
  if (eastEdge) east = 180;
  return [
    [clamp(west, -180, 180), clamp(south, -90, 90)],
    [clamp(east, -180, 180), clamp(north, -90, 90)],
  ];
}

/** The rendered transform T: `map.transform` on v5, `map._camera.transform` on v6. */
function renderedTransform(host: object): BoundsTransform | undefined {
  const usable = (transform: unknown): transform is BoundsTransform => {
    const t = transform as Partial<BoundsTransform> | null | undefined;
    return (
      typeof t?.screenPointToLocation === 'function' &&
      typeof t.isPointOnMapSurface === 'function' &&
      typeof t.width === 'number' &&
      typeof t.height === 'number'
    );
  };
  const v5 = (host as { transform?: unknown }).transform;
  if (usable(v5)) return v5;
  const v6 = (host as { _camera?: { transform?: unknown } })._camera?.transform;
  return usable(v6) ? v6 : undefined;
}

/** South-west and north-east of a bounds object MapLibre returned, or `undefined`. */
function boundsCorners(bounds: unknown): [LngLatTuple, LngLatTuple] | undefined {
  if (typeof bounds !== 'object' || bounds === null) return undefined;
  const b = bounds as {
    getSouthWest?: () => unknown;
    getNorthEast?: () => unknown;
    _sw?: unknown;
    _ne?: unknown;
    sw?: unknown;
    ne?: unknown;
  };
  const sw = lngLatTuple(typeof b.getSouthWest === 'function' ? b.getSouthWest() : (b._sw ?? b.sw));
  const ne = lngLatTuple(typeof b.getNorthEast === 'function' ? b.getNorthEast() : (b._ne ?? b.ne));
  return sw && ne ? [sw, ne] : undefined;
}

/** `RawCamera` without wrapping anything: for `geographicApi: false`. */
export function rawCamera(host: GeoApiHost): RawCamera {
  // Captured now, so that wrappers installed later are bypassed.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with `host` below
  const { getCenter, jumpTo, unproject, stop } = host;
  return {
    getCenter: () => getCenter.call(host),
    jumpTo: (options, eventData) => jumpTo.call(host, options, eventData),
    unproject: (point) => unproject.call(host, point),
    // The structural fakes of the controller tests have no `stop`; every MapLibre map has.
    stop: () => (typeof stop === 'function' ? stop.call(host) : undefined),
  };
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const PROVIDER_MARKED = Symbol.for('equal-earth:provider-marked');

/**
 * Mark what MapLibre's handlers read through `TransformProvider` (`unproject` results and the
 * `center` getter's result) as map space, once per prototype (`Symbol.for('equal-earth:provider-marked')`).
 * Safe for every map: the provider always answers in R/T space (audit §7, B1/B2).
 *
 * That is what neutralises the double-click and tap zoom's `around` and the keyboard's `center`.
 * `provider` is the prototype (`Object.getPrototypeOf(map.keyboard._tr)`): v6 shares one provider
 * per map, v5 gives each handler its own, all of the same class.
 */
export function markTransformProviders(provider: object): void {
  if (Object.prototype.hasOwnProperty.call(provider, PROVIDER_MARKED)) return;
  const unproject = Object.getOwnPropertyDescriptor(provider, 'unproject');
  if (typeof unproject?.value === 'function') {
    const original = unproject.value as (this: unknown, ...args: unknown[]) => unknown;
    Object.defineProperty(provider, 'unproject', {
      ...unproject,
      value: function (this: unknown, ...args: unknown[]): unknown {
        const location = original.apply(this, args);
        return isObject(location) ? markMapSpace(location) : location;
      },
    });
  }
  const center = Object.getOwnPropertyDescriptor(provider, 'center');
  if (typeof center?.get === 'function') {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the provider below
    const get = center.get as (this: unknown) => unknown;
    Object.defineProperty(provider, 'center', {
      ...center,
      get(this: unknown): unknown {
        const value = get.call(this);
        return isObject(value) ? markMapSpace(value) : value;
      },
    });
  }
  Object.defineProperty(provider, PROVIDER_MARKED, { value: true });
}

let providerWarned = false;

/**
 * The owner of the rendered transform T and the requested state R: the map on v5
 * (`map.transform`, `map._requestedCameraState`), its Camera on v6 (`map._camera.…`; a v6 `Map`
 * has no `transform`).
 */
function cameraOwner(host: object): { transform?: { center?: unknown }; _requestedCameraState?: { center?: unknown } } {
  const camera = (host as { _camera?: unknown })._camera;
  return isObject(camera) && 'transform' in camera ? (camera as object) : host;
}

/** Rule 2 (audit §7): a value MapLibre handed us in map space, judged by identity alone. */
function isMapSpaceValue(value: unknown, host: object): boolean {
  if (!isObject(value)) return false;
  if (mapSpace.has(value)) return true;
  const owner = cameraOwner(host);
  return value === owner.transform?.center || value === owner._requestedCameraState?.center;
}

interface Context {
  readonly host: object;
  readonly state: GeoApiState;
  readonly raw: RawCamera;
  readonly toLngLat: (tuple: LngLatTuple) => { lng: number; lat: number };
}

/**
 * Convert the target values of one call (audit §3, §7). Returns `undefined` when nothing needs
 * converting; otherwise a copy of `values` with each converted value replaced by a marked
 * map-space LngLat of the baseline band.
 *
 * The stop comes first: the original's own first statement is a stop (`stop()`, or
 * `_stop(false, easeId)` for the `easeTo` family, which stops nothing that `easeId` continues),
 * and that stop can fire the Camera's `moveend` or the handlers' `*end` events, which re-base
 * the camera. Only then is the baseline the original will run against known.
 */
function convertTargets(
  values: Record<string, unknown>,
  ctx: Context,
  easeId: unknown,
): Record<string, unknown> | undefined {
  const pending = Object.keys(values).filter((key) => values[key] !== undefined && values[key] !== null && !isMapSpaceValue(values[key], ctx.host));
  if (pending.length === 0) return undefined;
  // As MapLibre's `_afterEase`, an empty easeId continues nothing.
  if (!easeId) ctx.raw.stop();
  const blend = ctx.state.baselineBlend;
  const copy = { ...values };
  for (const key of pending) {
    const tuple = lngLatTuple(values[key]);
    // MapLibre throws its own error for what it cannot read; a latitude beyond ±90° as well.
    if (!tuple || Math.abs(tuple[1]) > 90) continue;
    // World copies are off while active: one world, so a longitude beyond ±180° is its place in
    // it (as `project`, Ruling R8). Kept as a copy it would be clamped to the world's edge.
    const onTheWorld: LngLatTuple = [wrapLongitude(tuple[0]), tuple[1]];
    copy[key] = markMapSpace(ctx.toLngLat(mapSpaceOf(onTheWorld, blend)));
  }
  return copy;
}

/** Where a camera method carries its targets. */
interface TargetSlots {
  /** Index of a positional target (`setCenter`'s `center`, `panTo`'s `lngLat`). */
  readonly position?: number;
  /** Index of an options object whose `center` and `around` are targets. */
  readonly options?: number;
  /**
   * The method ends in `easeTo`, whose stop spares the ease an `options.easeId` continues; the
   * others (`jumpTo`, `flyTo`, `setCenter`) always stop.
   */
  readonly easeFamily: boolean;
  /** Index of `eventData`, for Rule 4's fallback (`easeTo` only). */
  readonly handlerEventData?: number;
}

const TARGET_METHODS: Readonly<Record<string, TargetSlots>> = {
  jumpTo: { options: 0, easeFamily: false },
  flyTo: { options: 0, easeFamily: false },
  setCenter: { position: 0, easeFamily: false },
  easeTo: { options: 0, easeFamily: true, handlerEventData: 1 },
  panTo: { position: 0, options: 1, easeFamily: true },
  panBy: { options: 1, easeFamily: true },
  zoomTo: { options: 1, easeFamily: true },
  rotateTo: { options: 1, easeFamily: true },
  zoomIn: { options: 0, easeFamily: true },
  zoomOut: { options: 0, easeFamily: true },
  resetNorth: { options: 0, easeFamily: true },
  resetNorthPitch: { options: 0, easeFamily: true },
  snapToNorth: { options: 0, easeFamily: true },
};

const TARGET_KEYS = ['center', 'around'] as const;

const isDomEvent = (value: unknown): boolean => typeof Event === 'function' && value instanceof Event;

/** The arguments to call the original with: the caller's own, or copies with targets converted. */
function convertCall(args: unknown[], slots: TargetSlots, ctx: Context, handlerFallback: boolean): unknown[] {
  if (handlerFallback && slots.handlerEventData !== undefined) {
    // Rule 4's fallback without a TransformProvider to mark: what a DOM event drove came from
    // a handler, in map space (audit §7, a heuristic).
    const eventData = args[slots.handlerEventData];
    if (isObject(eventData) && isDomEvent((eventData as { originalEvent?: unknown }).originalEvent)) return args;
  }
  const options = slots.options === undefined ? undefined : args[slots.options];
  const fields = isObject(options) ? (options as Record<string, unknown>) : undefined;
  const values: Record<string, unknown> = {};
  if (slots.position !== undefined) values['position'] = args[slots.position];
  for (const key of TARGET_KEYS) if (fields && key in fields) values[key] = fields[key];
  const copy = convertTargets(values, ctx, slots.easeFamily ? fields?.['easeId'] : undefined);
  if (!copy) return args;
  const converted = args.slice();
  if (slots.position !== undefined) converted[slots.position] = copy['position'];
  if (fields && slots.options !== undefined && TARGET_KEYS.some((key) => copy[key] !== fields[key])) {
    const next = { ...fields };
    for (const key of TARGET_KEYS) if (key in fields) next[key] = copy[key];
    converted[slots.options] = next;
  }
  return converted;
}

/** One band's fit, from MapLibre's own `cameraForBounds` on a map-space bbox. */
export type BandFit = (
  sw: LngLatTuple,
  ne: LngLatTuple,
) => { center: { lng: number; lat: number }; zoom: number; bearing: number } | undefined;

/** Points per edge of the bounds' densified boundary in {@link fitAcrossBands}. */
const FIT_SAMPLES_PER_EDGE = 32;
/** How far below a band boundary a 2-cycle resolves. */
const BOUNDARY_EPSILON = 1e-6;

/** Geographic longitude spans of `west…east`, split at the antimeridian (one world while active). */
function longitudeSpans(west: number, east: number): [number, number][] {
  if (east - west >= 360) return [[-180, 180]];
  const w = wrapLongitude(west);
  const e = wrapLongitude(east);
  return w <= e ? [[w, e]] : [[w, 180], [-180, e]];
}

/** The geographic boundary of `bounds`, densified (the warp maps boundary to boundary). */
function boundaryPoints([sw, ne]: [LngLatTuple, LngLatTuple]): LngLatTuple[] {
  const clampLat = (lat: number): number => clamp(lat, -90, 90);
  const south = clampLat(Math.min(sw[1], ne[1]));
  const north = clampLat(Math.max(sw[1], ne[1]));
  const points: LngLatTuple[] = [];
  for (const [w, e] of longitudeSpans(sw[0], ne[0])) {
    for (let i = 0; i <= FIT_SAMPLES_PER_EDGE; i++) {
      const t = i / FIT_SAMPLES_PER_EDGE;
      const lng = w + (e - w) * t;
      const lat = south + (north - south) * t;
      points.push([lng, south], [lng, north], [w, lat], [e, lat]);
    }
  }
  return points;
}

/** Fixed-point steps for {@link requestedZoomFor}, and when to stop early. */
const OFFSET_SOLVE_STEPS = 8;
const OFFSET_SOLVE_TOLERANCE = 1e-6;

/**
 * The requested zoom `r` the camera hook renders as `rendered`: `r + offset(r) = rendered`, by
 * fixed-point iteration (the offset changes slowly with the zoom, so it settles in a few steps).
 */
function requestedZoomFor(rendered: number, offsetAt: (requestedZoom: number) => number): number {
  let zoom = rendered;
  for (let i = 0; i < OFFSET_SOLVE_STEPS; i++) {
    const next = rendered - offsetAt(zoom);
    if (!Number.isFinite(next)) return zoom;
    const done = Math.abs(next - zoom) < OFFSET_SOLVE_TOLERANCE;
    zoom = next;
    if (done) break;
  }
  return zoom;
}

const NO_OFFSETS: CameraOffsets = { deltaZoom: 0, deltaBearing: 0 };

/**
 * Audit §5: fit geographic bounds across bands. For every band k, the map-space bbox of the
 * densified boundary (32 points per edge, lat clamped to ±90 before and to
 * `mapSpaceMaxLatitude(blend_k)` after the warp; split at the antimeridian when west > east)
 * is fitted with `fit`. Picks the band whose fit zoom falls in it (highest zoom if several);
 * a 2-cycle at a boundary β resolves to the lower band at `β − 1e-6`.
 *
 * With `offsets` (Ruling R11, the camera's compensation), each band's fit zoom z_k is what the
 * camera must *render*; the band test and the result use the requested zoom r_k the hook renders
 * as z_k in band k (`r_k + offsets(c_k, k, r_k).deltaZoom = z_k`), since the hook picks the band
 * from the requested zoom. `zoom` and `bearing` are then the requested values, before the
 * baseline offsets: the hook renders them as the fit's zoom and bearing. Without `offsets` they
 * are the fit's own.
 *
 * Bounds crossing the antimeridian are fitted as the union of their two halves, near the full
 * width of the one world. `center` is the geographic point under the fitted view's centre, not
 * the geographic midpoint of the bounds. `undefined` when no band can be fitted (MapLibre's
 * `cameraForBounds` returned nothing, say for a padding larger than the viewport).
 */
export function fitAcrossBands(
  bounds: [sw: LngLatTuple, ne: LngLatTuple],
  bands: readonly Band[],
  fit: BandFit,
  offsets: OffsetsAt = () => NO_OFFSETS,
): { band: number; center: LngLatTuple; zoom: number; bearing: number } | undefined {
  const boundary = boundaryPoints(bounds);
  const fits = bands.map((band, k) => {
    const maxLat = mapSpaceMaxLatitude(band.blend);
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const point of boundary) {
      const [lng, mapLat] = geographicToMap(point, band.blend);
      const lat = clamp(mapLat, -maxLat, maxLat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    if (!(west <= east && south <= north)) return undefined;
    const result = fit([west, south], [east, north]);
    if (!result || !Number.isFinite(result.zoom)) return undefined;
    const center = geographicUnder([result.center.lng, result.center.lat], band.blend);
    const requested = requestedZoomFor(result.zoom, (zoom) => offsets(center, k, zoom).deltaZoom);
    return { center, requested, bearing: result.bearing };
  });

  let best: { band: number; zoom: number } | undefined;
  const consider = (band: number, zoom: number): void => {
    if (!best || zoom > best.zoom) best = { band, zoom };
  };
  for (const [k, result] of fits.entries()) {
    if (result && bandIndexForZoom(bands, result.requested) === k) consider(k, result.requested);
    // A 2-cycle at the boundary β above band k: band k's request is above β, band k + 1's below
    // it. Band k requested just below β is consistent, and fits: it renders below z_k, as the
    // rendered zoom `r + offset(r)` grows with r.
    const next = fits[k + 1];
    const beta = bands[k + 1]?.minZoom;
    if (result && next && beta !== undefined && result.requested >= beta && next.requested < beta) {
      consider(k, beta - BOUNDARY_EPSILON);
    }
  }
  if (!best) return undefined;
  const { band, zoom } = best;
  const chosen = fits[band]!;
  return {
    band,
    center: chosen.center,
    zoom,
    bearing: chosen.bearing - offsets(chosen.center, band, zoom).deltaBearing,
  };
}

/** `LngLatBounds` (`getSouthWest()`/`getNorthEast()`), `[[w, s], [e, n]]` or `[w, s, e, n]`, as MapLibre's `LngLatBounds.convert`. */
function boundsTuple(bounds: unknown): [LngLatTuple, LngLatTuple] | undefined {
  if (Array.isArray(bounds)) {
    const items = bounds as unknown[];
    const [sw, ne] = items.length === 4 ? [[items[0], items[1]], [items[2], items[3]]] : items.length === 2 ? items : [];
    const a = lngLatTuple(sw);
    const b = lngLatTuple(ne);
    return a && b ? [a, b] : undefined;
  }
  return boundsCorners(bounds);
}

/** A MapLibre `cameraForBounds` result as a {@link BandFit} result. */
function readFit(result: CameraFit | undefined): ReturnType<BandFit> {
  const center = lngLatTuple(result?.center);
  if (!result || !center || typeof result.zoom !== 'number') return undefined;
  return { center: { lng: center[0], lat: center[1] }, zoom: result.zoom, bearing: result.bearing ?? 0 };
}

type Read<R> = (...args: unknown[]) => R;
type Method = (...args: unknown[]) => unknown;

/**
 * Wrap `host`'s reads (audit §1, §6) and camera targets (audit §3–§5, §7). A method the host
 * lacks is left alone. `raw` holds MapLibre's own `getCenter`, `jumpTo`, `unproject` and `stop`,
 * captured first: the plugin keeps calling those in map space.
 *
 * Also, once per page, patches MapLibre's `TransformProvider` so that what the handlers read
 * through it is marked map space ({@link markTransformProviders}); and on v5, wraps the map's
 * `_cameraForBoxAndBearing` to mark the box zoom's centre (audit B6).
 */
export function installGeoApi(host: GeoApiHost, state: GeoApiState, factories: GeoApiFactories): GeoApi {
  const raw = rawCamera(host);
  const toLngLat = ([lng, lat]: LngLatTuple): { lng: number; lat: number } => factories.lngLat(lng, lat);
  const ctx: Context = { host, state, raw, toLngLat };

  const provider = (host as { keyboard?: { _tr?: unknown } }).keyboard?._tr;
  const providerPrototype: unknown = isObject(provider) ? Object.getPrototypeOf(provider) : undefined;
  const handlerFallback = !isObject(providerPrototype);
  if (isObject(providerPrototype)) {
    markTransformProviders(providerPrototype);
  } else if (!providerWarned) {
    providerWarned = true;
    console.warn(
      "[equal-earth] could not find MapLibre's TransformProvider; double-click, tap and keyboard zoom may land off target",
    );
  }

  const restores = [
    wrapMethod<Read<{ lng: number; lat: number }>>(host, 'getCenter', (original) => (...args) => {
      if (!state.active) return original(...args);
      const centre = original(...args);
      return toLngLat(geographicUnder([centre.lng, centre.lat], state.blend));
    }),
    wrapMethod<Read<{ x: number; y: number }>>(host, 'project', (original) => (...args) => {
      if (!state.active) return original(...args);
      const [lngLat, ...rest] = args;
      const tuple = lngLatTuple(lngLat);
      // MapLibre throws its own error for what it cannot read, or for a latitude beyond ±90°.
      if (!tuple || Math.abs(tuple[1]) > 90) return original(...args);
      // World copies are off while active: there is one world, so any longitude projects onto
      // its place in it. This supersedes audit §1's note to keep copies here: Marker `smartWrap`
      // still runs (Mercator's `allowWorldCopies()` is always true) and can move a marker at
      // 179.5° to −180.5° when the view is at the world's west edge; kept as a copy, it would be
      // drawn in the empty space west of the world (Ruling R8). `mapSpaceOf` keeps copies.
      const onTheWorld: LngLatTuple = [wrapLongitude(tuple[0]), tuple[1]];
      return original(toLngLat(mapSpaceOf(onTheWorld, state.blend)), ...rest);
    }),
    wrapMethod<Read<{ lng: number; lat: number }>>(host, 'unproject', (original) => (...args) => {
      if (!state.active) return original(...args);
      const location = original(...args);
      return toLngLat(geographicUnder([location.lng, location.lat], state.blend));
    }),
    wrapMethod<Read<unknown>>(host, 'getBounds', (original) => (...args) => {
      if (!state.active) return original(...args);
      const blend = state.blend;
      const transform = renderedTransform(host);
      if (transform) return factories.lngLatBounds(...geographicBounds(transform, blend));
      // No transform to sample: the original box's corners, converted (a looser box).
      const bounds = original(...args);
      const corners = boundsCorners(bounds);
      if (!corners) return bounds;
      const [[w, s], [e, n]] = corners;
      const converted = ([[w, s], [e, s], [e, n], [w, n]] as LngLatTuple[]).map((c) => geographicUnder(c, blend));
      const lngs = converted.map((c) => c[0]);
      const lats = converted.map((c) => c[1]);
      return factories.lngLatBounds(
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      );
    }),
    ...Object.entries(TARGET_METHODS).map(([name, slots]) =>
      wrapMethod<Method>(host, name, (original) => (...args) => {
        if (!state.active) return original(...args);
        return original(...convertCall(args, slots, ctx, handlerFallback));
      }),
    ),
    // Audit §5: never the original `fitBounds`, which on v6 would read geographic bounds as map
    // space and fly through the unwrapped Camera `flyTo`.
    wrapMethod<Method>(host, 'cameraForBounds', (original) => (...args) => {
      if (!state.active) return original(...args);
      const [bounds, options] = args;
      const corners = boundsTuple(bounds);
      if (!corners) return original(...args); // MapLibre's own error for what it cannot read
      // Ruling R11: solved against the camera's compensation, so that the camera renders exactly
      // the framing MapLibre computed; the request carries the baseline offsets the hook subtracts.
      const result = fitAcrossBands(
        corners,
        state.bands,
        (sw, ne) => readFit(original([sw, ne], options) as CameraFit | undefined),
        state.offsets,
      );
      if (!result) return undefined;
      const baseline = state.baselineOffsets;
      return {
        center: toLngLat(result.center),
        zoom: result.zoom + baseline.deltaZoom,
        bearing: result.bearing + baseline.deltaBearing,
      };
    }),
    wrapMethod<Method>(host, 'fitBounds', (original) => (...args) => {
      if (!state.active) return original(...args);
      // MapLibre's `_fitInternal`, through the wrapped methods: the geographic centre is then
      // converted with the baseline band like any other target.
      const [bounds, options, eventData] = args;
      const fitOptions = isObject(options) ? options : undefined;
      // As `_fitInternal`: nothing to fit, nothing done (a running animation goes on).
      let camera = host.cameraForBounds(bounds, fitOptions);
      if (!camera) return host;
      // The flyTo/easeTo below stops first, and that stop can re-base the camera. Stop now, and
      // fit again if it did: the fit must use the baseline the animation runs against (R11).
      const before = { offsets: state.baselineOffsets, blend: state.baselineBlend };
      raw.stop();
      const after = state.baselineOffsets;
      if (
        after.deltaZoom !== before.offsets.deltaZoom ||
        after.deltaBearing !== before.offsets.deltaBearing ||
        state.baselineBlend !== before.blend
      ) {
        camera = host.cameraForBounds(bounds, fitOptions);
        if (!camera) return host;
      }
      // The fit's bearing is `options.bearing`, already in `camera` with the compensation applied.
      const animation: Record<string, unknown> = { ...camera, ...fitOptions, bearing: camera.bearing };
      delete animation['padding'];
      if (animation['linear']) host.easeTo(animation, eventData);
      else host.flyTo(animation, eventData);
      return host;
    }),
    // v5 only (a v6 `Map` has no such method): box zoom's `fitScreenCoordinates` runs
    // `_fitInternal` through the map's own `easeTo`, with this fresh map-space centre (B6).
    // Only while active: under Mercator the centre is geographic, and an application may keep a
    // `cameraForBounds` result and fly to it once Equal Earth is on; marked, it would pass unconverted.
    wrapMethod<Read<CameraFit | undefined>>(host, '_cameraForBoxAndBearing', (original) => (...args) => {
      const result = original(...args);
      if (state.active && isObject(result?.center)) markMapSpace(result.center);
      return result;
    }),
  ];

  return {
    raw,
    uninstall: () => {
      for (const restore of restores) restore();
    },
  };
}
