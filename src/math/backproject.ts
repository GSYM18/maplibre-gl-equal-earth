/**
 * Backprojection: making a Mercator renderer draw Equal Earth.
 *
 * MapLibre GL JS has no public API for registering a projection — `createProjectionFromName`
 * is a hard-coded switch that falls back to Mercator for unknown names. So instead of adding
 * a projection, we feed the Mercator renderer *fabricated* longitude/latitude values chosen
 * such that, once Mercator projects them, the result is the Equal Earth image:
 *
 *     real lng/lat → Equal Earth metres → scale to the Mercator extent → inverse Mercator
 *
 * The technique is Development Seed's "dirty reprojectors" (2016), also used by Mapbox for
 * Albers USA election maps and by `willcohen/backproj`. The output values are *not* geographic
 * coordinates; we call this "map space" throughout.
 */

import {
  EQUAL_EARTH_X_MAX,
  fromEqualEarth,
  toEqualEarth,
  type LngLatTuple,
  type PointTuple,
} from './equal-earth.js';

/** WGS84 semi-major axis — the sphere radius Web Mercator (EPSG:3857) is defined on. */
export const WEB_MERCATOR_RADIUS = 6378137;

/** Half the width of the Web Mercator world, in metres: `π · a`. */
export const WEB_MERCATOR_MAX = Math.PI * WEB_MERCATOR_RADIUS;

/**
 * Scale factor stretching the Equal Earth extent to fill the Web Mercator tile grid
 * horizontally, so an Equal Earth world can be addressed with ordinary XYZ tile numbers.
 *
 * ≈ 1.162. `equal.bbox.earth` quotes the same figure for its pre-baked tiles.
 *
 * Note this ratio is independent of the sphere radius chosen for Equal Earth: that radius
 * appears in both `EQUAL_EARTH_X_MAX` and the easting it scales, and cancels.
 */
export const GRID_FACTOR = WEB_MERCATOR_MAX / EQUAL_EARTH_X_MAX;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** The latitude at which Web Mercator is conventionally truncated to a square world. */
export const MERCATOR_MAX_LATITUDE = 85.051128779806589;

/** Spherical Web Mercator forward. Latitude beyond ±85.051129° is clamped, as in EPSG:3857. */
function toWebMercator(lngLat: LngLatTuple): PointTuple {
  const lat = clamp(lngLat[1], -MERCATOR_MAX_LATITUDE, MERCATOR_MAX_LATITUDE);
  const phi = lat * DEG_TO_RAD;
  return [
    WEB_MERCATOR_RADIUS * lngLat[0] * DEG_TO_RAD,
    WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + phi / 2)),
  ];
}

/** Spherical Web Mercator inverse. */
function fromWebMercator(point: PointTuple): LngLatTuple {
  return [
    (point[0] / WEB_MERCATOR_RADIUS) * RAD_TO_DEG,
    (2 * Math.atan(Math.exp(point[1] / WEB_MERCATOR_RADIUS)) - Math.PI / 2) * RAD_TO_DEG,
  ];
}

/**
 * Convert real geographic coordinates to the map-space coordinates MapLibre must be given
 * for the point to land in the right place on an Equal Earth map.
 *
 * Every overlay coordinate — deck.gl accessors, GeoJSON, marker positions, `flyTo` targets —
 * must pass through here while Equal Earth is active.
 */
export function geographicToMap(lngLat: LngLatTuple): LngLatTuple {
  const equalEarth = toEqualEarth(lngLat);
  return fromWebMercator([equalEarth[0] * GRID_FACTOR, equalEarth[1] * GRID_FACTOR]);
}

/**
 * Inverse of {@link geographicToMap}: recover real geographic coordinates from the values
 * MapLibre reports (`map.getCenter()`, `map.unproject()`, `queryRenderedFeatures` geometry)
 * while Equal Earth is active.
 */
export function mapToGeographic(lngLat: LngLatTuple): LngLatTuple {
  const mercator = toWebMercator(lngLat);
  return fromEqualEarth([mercator[0] / GRID_FACTOR, mercator[1] / GRID_FACTOR]);
}

/**
 * The map-space latitude corresponding to the geographic pole — the top edge of the Equal
 * Earth world once it sits on the Mercator grid (≈ ±65.46°).
 *
 * Useful for constraining the camera: there is nothing to show beyond it, whereas Mercator
 * itself would happily pan on to ±85°.
 */
export const MAP_SPACE_MAX_LATITUDE = geographicToMap([0, 90])[1];

/**
 * A point in normalised Mercator world space: `[0,1]²`, origin at the top-left
 * (north-west) corner, y increasing southward. This is MapLibre's tile coordinate space —
 * tile `(z, x, y)` covers `[x, x+1] × [y, y+1]` divided by `2^z`.
 */
export type WorldTuple = [number, number];

/**
 * Geographic coordinates straight to normalised Mercator world space, for the tile pipeline.
 *
 * This deliberately skips the inverse-Mercator step that {@link geographicToMap} ends with:
 * world coordinates are an *affine* function of Mercator metres, which the Equal Earth warp
 * has already produced. So where `geographicToMap` costs a `log`/`tan` pair to express the
 * result as fabricated lng/lat for MapLibre's camera API, this costs two multiplies — and
 * avoids a needless round trip through a transcendental function.
 *
 * Use this for every tile vertex; use {@link geographicToMap} only at the camera boundary.
 */
export function geographicToMapWorld(lngLat: LngLatTuple): WorldTuple {
  const equalEarth = toEqualEarth(lngLat);
  const scale = GRID_FACTOR / (2 * WEB_MERCATOR_MAX);
  return [0.5 + equalEarth[0] * scale, 0.5 - equalEarth[1] * scale];
}

/** Inverse of {@link geographicToMapWorld}. */
export function mapWorldToGeographic(world: WorldTuple): LngLatTuple {
  const inverseScale = (2 * WEB_MERCATOR_MAX) / GRID_FACTOR;
  return fromEqualEarth([(world[0] - 0.5) * inverseScale, (0.5 - world[1]) * inverseScale]);
}

/**
 * World-space y of the north edge of the Equal Earth world (≈0.2566).
 *
 * Equal Earth has a ~2.05:1 aspect ratio, so once stretched to fill the Mercator grid
 * horizontally it occupies only the middle ~49% of it vertically. Tiles wholly above this
 * (or below {@link WORLD_Y_MAX}) contain no map at all and can be skipped outright.
 */
export const WORLD_Y_MIN = geographicToMapWorld([0, 90])[1];

/** World-space y of the south edge of the Equal Earth world (≈0.7434). */
export const WORLD_Y_MAX = geographicToMapWorld([0, -90])[1];

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
