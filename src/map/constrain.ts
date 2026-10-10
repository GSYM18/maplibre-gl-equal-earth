/**
 * Camera constraint for the Equal Earth world.
 *
 * On the Mercator grid the Equal Earth world only reaches map-space latitude ±65.46°
 * (see `MAP_SPACE_MAX_LATITUDE`), but Mercator itself will happily pan on to ±85°, showing
 * empty background above and below the map. This clamps the centre to keep the world in view.
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

/** The bits of `Map` this module touches. */
export interface ConstrainHost {
  setTransformConstrain(constrain?: TransformConstrainFn | null): unknown;
}

export interface EqualEarthConstrainOptions {
  /**
   * Builds the returned centre object. Pass `maplibregl.LngLat` — MapLibre's own default
   * constrain returns a real `LngLat`, and downstream code may call its methods.
   */
  lngLatFactory: LngLatFactory;
  /**
   * Whether the constraint is currently in force. Returning `false` passes the camera
   * through untouched, so Mercator and globe behave exactly as they would without the plugin.
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
   * requested zoom falls in, and the Mercator band (blend 1) is left unconstrained.
   *
   * @defaultValue a single Equal Earth band — the world edge at ≈ ±65.54° at every zoom
   */
  bands?: readonly Band[];
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
  const { lngLatFactory } = options;
  const isActive = options.isActive ?? (() => true);
  const margin = options.latitudeMargin ?? 0;
  const bands = options.bands ?? [{ minZoom: 0, blend: 0 }];
  validateBands(bands);
  // Constrain runs on every camera change; the edge is a transcendental function of the
  // blend, so compute it once per band.
  const limits = bands.map((band) => mapSpaceMaxLatitude(band.blend) + margin);

  return (lngLat, zoom) => {
    if (!isActive()) {
      return { center: lngLat, zoom };
    }
    const index = bandIndexForZoom(bands, zoom);
    if (bands[index]!.blend === 1) {
      return { center: lngLat, zoom };
    }
    const limit = limits[index]!;
    const clamped = lngLat.lat < -limit ? -limit : lngLat.lat > limit ? limit : lngLat.lat;
    if (clamped === lngLat.lat) {
      return { center: lngLat, zoom };
    }
    return { center: lngLatFactory(lngLat.lng, clamped), zoom };
  };
}

/**
 * Install {@link createEqualEarthConstrain} on a map and return a teardown function.
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
  host.setTransformConstrain(createEqualEarthConstrain(options));
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    host.setTransformConstrain(null);
  };
}
