/**
 * Camera constraint for the Equal Earth world.
 *
 * On the Mercator grid the Equal Earth world only reaches map-space latitude ±65.54° at blend 0
 * (see `MAP_SPACE_MAX_LATITUDE`), and each band of the adaptive projection has its own, higher
 * edge (`mapSpaceMaxLatitude(blend)`), but Mercator itself will happily pan on to ±85°, showing
 * empty background above and below the map. This clamps the centre to keep the world in view.
 *
 * It *composes* with MapLibre's own constraint rather than replacing it. An override set with
 * `setTransformConstrain` is called *instead of* the transform's `defaultConstrain` (v6
 * `TransformHelper.applyConstrain`, dev.mjs 9051-9054), and the default is where zoom is clamped
 * to `[minZoom, maxZoom]`, `maxBounds` is enforced and Mercator keeps the world filling the
 * viewport. So the default runs first, and Equal Earth bands then tighten its latitude.
 *
 * Implemented against `transformConstrain` rather than `transformCameraUpdate` deliberately:
 * `transformConstrain` is threaded through `createProjectionFromName` and so survives a
 * projection switch, whereas `migrateProjection` replaces the transform wholesale and leaves
 * `transformCameraUpdate`'s requested-camera state stale.
 */

import { mapSpaceMaxLatitude } from '../math/backproject.js';
import { bandIndexForZoom, validateBands, type Band } from './bands.js';
import type { LngLatFactory } from './camera.js';

/** Structural view of `maplibregl.LngLat`. */
export interface LngLatLike {
  lng: number;
  lat: number;
}

/** Matches `maplibregl.TransformConstrainFunction`. */
export type TransformConstrainFn = (
  lngLat: LngLatLike,
  zoom: number,
) => { center: LngLatLike; zoom: number };

/**
 * The part of MapLibre's `ITransform` this module calls: the constraint an override replaces.
 *
 * Declared with *method* syntax so it is bivariant in its parameter: MapLibre types
 * `defaultConstrain` with its `LngLat` class, and under `strictFunctionTypes` a plain function
 * type would reject a real map (`tests/host-types.test.ts` guards this).
 */
export interface DefaultConstrainOwner {
  defaultConstrain(lngLat: LngLatLike, zoom: number): { center: LngLatLike; zoom: number };
}

/**
 * The bits of `Map` this module touches.
 *
 * MapLibre v5's `Map` extends `Camera` and so carries the rendered `transform`. A v6 `Map` has
 * no `transform` at all: it lives on the private `_camera`, where `setTransformConstrain`
 * writes the override (v6 24448). {@link installEqualEarthConstrain} reads either.
 */
export interface ConstrainHost {
  setTransformConstrain(constrain?: TransformConstrainFn | null): unknown;
  /** MapLibre v5, and test doubles. Read on every call: `migrateProjection` replaces it. */
  readonly transform?: DefaultConstrainOwner;
}

export interface EqualEarthConstrainOptions {
  /**
   * Builds the returned centre object. Pass `maplibregl.LngLat` — MapLibre's own default
   * constrain returns a real `LngLat`, and downstream code may call its methods.
   */
  lngLatFactory: LngLatFactory;
  /**
   * Whether the constraint is currently in force. While it returns `false` the camera is
   * handed to {@link fallback} alone, so Mercator and globe keep MapLibre's own constraint.
   *
   * @defaultValue always active
   */
  isActive?: () => boolean;
  /**
   * Extra latitude, in degrees, permitted beyond the world edge. A little slack stops the
   * clamp feeling like a wall when the user flicks the map.
   *
   * @defaultValue 0
   */
  latitudeMargin?: number;
  /**
   * Zoom bands, for the adaptive projection. The world edge then depends on the band the
   * zoom falls in, and the Mercator band (blend 1) gets no Equal Earth clamp.
   *
   * @defaultValue a single Equal Earth band — the world edge at ≈ ±65.54° at every zoom
   */
  bands?: readonly Band[];
  /**
   * The constraint to compose with: it runs first, and its result is what Equal Earth bands
   * tighten. {@link installEqualEarthConstrain} passes the map's own `defaultConstrain`.
   *
   * @defaultValue none — the camera is passed through, then clamped
   */
  fallback?: TransformConstrainFn;
  /**
   * Index into {@link bands} of the band whose map space the requested camera state is in:
   * `BandCamera.baselineBand`.
   *
   * MapLibre applies the constraint to the requested state on every `setZoom`/`setCenter`
   * (dev.mjs 9286, 9298), with the *requested* zoom, while that state's centre is still in the
   * baseline band's space. Zooming out across a boundary would then clamp it against the lower
   * band's tighter edge, permanently: Svalbard would land at 70.65°. So the edge used is never
   * tighter than the baseline band's, and a Mercator baseline is not clamped at all.
   *
   * @defaultValue the band of the zoom alone
   */
  baselineBand?: () => number;
}

/**
 * Build a constrain function clamping the camera centre to the Equal Earth world.
 *
 * Only latitude is clamped. Equal Earth spans the full ±180° of map-space longitude at the
 * equator but narrows towards the poles, so the world is a rounded shape rather than a
 * rectangle — clamping longitude per-latitude would fight the user near the top and bottom
 * edges for the sake of hiding corners that are empty anyway.
 *
 * Note the callback receives only a centre and a zoom, with no viewport dimensions, so this
 * constrains the *centre* rather than the visible extent. The world can still be partly
 * off-screen when zoomed out; it can no longer be scrolled away entirely.
 */
export function createEqualEarthConstrain(
  options: EqualEarthConstrainOptions,
): TransformConstrainFn {
  const { lngLatFactory, fallback, baselineBand } = options;
  const isActive = options.isActive ?? (() => true);
  const margin = options.latitudeMargin ?? 0;
  const bands = options.bands ?? [{ minZoom: 0, blend: 0 }];
  validateBands(bands);
  // Constrain runs on every camera change; the edge is a transcendental function of the
  // blend, so compute it once per band. The Mercator band has no Equal Earth edge.
  const limits = bands.map((band) =>
    band.blend === 1 ? Infinity : mapSpaceMaxLatitude(band.blend) + margin,
  );

  return (lngLat, zoom) => {
    const base = fallback ? fallback(lngLat, zoom) : { center: lngLat, zoom };
    if (!isActive()) return base;
    // The band of the zoom the fallback settled on, since that is what will be rendered.
    let limit = limits[bandIndexForZoom(bands, base.zoom)]!;
    const baseline = baselineBand?.();
    if (baseline !== undefined) limit = Math.max(limit, limits[baseline] ?? -Infinity);
    if (limit === Infinity) return base;

    const lat = base.center.lat;
    const clamped = lat < -limit ? -limit : lat > limit ? limit : lat;
    if (clamped === lat) return base;
    return { center: lngLatFactory(base.center.lng, clamped), zoom: base.zoom };
  };
}

/**
 * Install {@link createEqualEarthConstrain} on a map and return a teardown function.
 *
 * Unless the options name a `fallback`, it composes with the map's own `defaultConstrain`,
 * read on every call because `migrateProjection` swaps the transform (v6 22077-22079): the
 * v5 `map.transform`, or the v6 `map._camera.transform`. If neither can be found the camera
 * is clamped without composing, as before.
 *
 * `setTransformConstrain(null)` reverts to the transform's default constrain, so unlike
 * `transformCameraUpdate` there is no prior value to preserve.
 */
export function installEqualEarthConstrain(
  host: ConstrainHost,
  options: EqualEarthConstrainOptions,
): () => void {
  if (!host || typeof host.setTransformConstrain !== 'function') {
    throw new TypeError(
      'installEqualEarthConstrain requires a map exposing setTransformConstrain() ' +
        '(maplibre-gl >= 5.24).',
    );
  }
  const fallback: TransformConstrainFn = (lngLat, zoom) => {
    const transform = currentTransform(host);
    return transform ? transform.defaultConstrain(lngLat, zoom) : { center: lngLat, zoom };
  };
  host.setTransformConstrain(
    createEqualEarthConstrain({ ...options, fallback: options.fallback ?? fallback }),
  );
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    host.setTransformConstrain(null);
  };
}

/** The transform whose `defaultConstrain` our override replaces, on v5 or v6. */
function currentTransform(host: ConstrainHost): DefaultConstrainOwner | undefined {
  const transform =
    host.transform ??
    (host as { _camera?: { transform?: DefaultConstrainOwner } })._camera?.transform;
  return typeof transform?.defaultConstrain === 'function' ? transform : undefined;
}
