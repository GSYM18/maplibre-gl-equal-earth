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
import type { Band } from './bands.js';
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
}

export interface GeoApiFactories {
  lngLat(lng: number, lat: number): { lng: number; lat: number };
  lngLatBounds(sw: LngLatTuple, ne: LngLatTuple): unknown;
}

/** The map methods Task 6 wraps (both majors have them). Task 7 extends it. */
export interface GeoApiHost {
  project(lngLat: unknown): { x: number; y: number };
  unproject(point: unknown): { lng: number; lat: number };
  getCenter(): { lng: number; lat: number };
  getBounds(): unknown;
  jumpTo(options: object, eventData?: unknown): unknown;
}

/** MapLibre's own methods, unconverted, captured before wrapping: what the plugin itself calls. */
export interface RawCamera {
  getCenter(): { lng: number; lat: number };
  jumpTo(options: object, eventData?: unknown): unknown;
  unproject(point: unknown): { lng: number; lat: number };
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

/** Values MapLibre (or the plugin) produced in map space. */
const mapSpace = new WeakSet<object>();

/** Mark a value MapLibre produced in map space: target wrappers (Task 7) pass it through. */
export function markMapSpace<T extends object>(value: T): T {
  mapSpace.add(value);
  return value;
}

export function isMarkedMapSpace(value: unknown): boolean {
  return typeof value === 'object' && value !== null && mapSpace.has(value);
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * `[lng, lat]`, `{lng, lat}` or `{lon, lat}` → tuple; `undefined` for anything else. As
 * MapLibre's `LngLat.convert`, an array may carry a third element (altitude), which is ignored;
 * unlike it, nothing is coerced: both values must be finite numbers.
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
  return isFiniteNumber(lng) && isFiniteNumber(lat) ? [lng, lat] : undefined;
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
  const { getCenter, jumpTo, unproject } = host;
  return {
    getCenter: () => getCenter.call(host),
    jumpTo: (options, eventData) => jumpTo.call(host, options, eventData),
    unproject: (point) => unproject.call(host, point),
  };
}

type Read<R> = (...args: unknown[]) => R;

/**
 * Wrap `host`'s four reads (spec §7, audit §1 and §6). A method the host lacks is left alone.
 * `raw` holds MapLibre's own `getCenter`, `jumpTo` and `unproject`, captured first: the plugin
 * keeps calling those in map space.
 */
export function installGeoApi(host: GeoApiHost, state: GeoApiState, factories: GeoApiFactories): GeoApi {
  const raw = rawCamera(host);
  const toLngLat = ([lng, lat]: LngLatTuple): { lng: number; lat: number } => factories.lngLat(lng, lat);

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
  ];

  return {
    raw,
    uninstall: () => {
      for (const restore of restores) restore();
    },
  };
}
