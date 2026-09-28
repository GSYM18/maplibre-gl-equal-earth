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
 *
 * `blend` selects a zoom band of the adaptive projection (see {@link geographicToMapWorld});
 * at 1 map space *is* geographic space and this is the identity.
 */
export function geographicToMap(lngLat: LngLatTuple, blend = 0): LngLatTuple {
  if (blend === 0) {
    const equalEarth = toEqualEarth(lngLat);
    return fromWebMercator([equalEarth[0] * GRID_FACTOR, equalEarth[1] * GRID_FACTOR]);
  }
  if (blend === 1) return [lngLat[0], lngLat[1]];
  return worldToMercatorLngLat(geographicToMapWorld(lngLat, blend));
}

/**
 * Inverse of {@link geographicToMap}: recover real geographic coordinates from the values
 * MapLibre reports (`map.getCenter()`, `map.unproject()`, `queryRenderedFeatures` geometry)
 * while Equal Earth is active.
 */
export function mapToGeographic(lngLat: LngLatTuple, blend = 0): LngLatTuple {
  if (blend === 0) {
    const mercator = toWebMercator(lngLat);
    return fromEqualEarth([mercator[0] / GRID_FACTOR, mercator[1] / GRID_FACTOR]);
  }
  if (blend === 1) return [lngLat[0], lngLat[1]];
  return mapWorldToGeographic(mercatorWorld(lngLat), blend);
}

/**
 * The map-space latitude of the geographic pole — the top edge of the world once it sits
 * on the Mercator grid. ≈ ±65.54° for pure Equal Earth, rising to Mercator's ±85.05° as the
 * blend approaches 1.
 *
 * Useful for constraining the camera: there is nothing to show beyond it, whereas Mercator
 * itself would happily pan on to ±85°.
 */
export function mapSpaceMaxLatitude(blend = 0): number {
  return Math.min(geographicToMap([0, 90], blend)[1], MERCATOR_MAX_LATITUDE);
}

/** {@link mapSpaceMaxLatitude} for pure Equal Earth (≈ ±65.54°). */
export const MAP_SPACE_MAX_LATITUDE = mapSpaceMaxLatitude(0);

/**
 * A point in normalised Mercator world space: `[0,1]²`, origin at the top-left
 * (north-west) corner, y increasing southward. This is MapLibre's tile coordinate space —
 * tile `(z, x, y)` covers `[x, x+1] × [y, y+1]` divided by `2^z`.
 */
export type WorldTuple = [number, number];

/**
 * Geographic coordinates straight to normalised world space, for the tile pipeline.
 *
 * `blend` mixes Equal Earth (0) and Web Mercator (1) *world positions* linearly — the zoom
 * bands of the adaptive `equal` projection each render one fixed blend:
 *
 *     world_t(p) = (1 − t) · equalEarthWorld(p) + t · mercatorWorld(p)
 *
 * The mix is continuous in p, so warped geometry never tears. And because in both
 * projections northing depends on latitude alone and easting is linear in longitude for a
 * fixed latitude, so does the mix — which is what makes {@link mapWorldToGeographic} cheap.
 *
 * At blend 0 this skips the inverse-Mercator step that {@link geographicToMap} ends with:
 * world coordinates are an *affine* function of Equal Earth metres, so it costs two
 * multiplies instead of a `log`/`tan` pair. Use this for every tile vertex; use
 * {@link geographicToMap} only at the camera boundary.
 */
export function geographicToMapWorld(lngLat: LngLatTuple, blend = 0): WorldTuple {
  if (blend === 0) return equalEarthWorld(lngLat);
  const mercator = mercatorWorld(lngLat);
  if (blend === 1) return mercator;
  const equalEarth = equalEarthWorld(lngLat);
  return [
    equalEarth[0] + blend * (mercator[0] - equalEarth[0]),
    equalEarth[1] + blend * (mercator[1] - equalEarth[1]),
  ];
}

/** Bisection steps for the blended inverse: 64 halvings of 180° exhaust double precision. */
const BLEND_INVERSE_STEPS = 64;

/** Slack for points on the world edge that round to just outside it. */
const WORLD_EDGE_EPSILON = 1e-12;

/**
 * Inverse of {@link geographicToMapWorld}. Returns `[NaN, NaN]` for a point above or below
 * the world band — there is no geographic location there.
 *
 * For an intermediate blend, latitude is found by bisection: the blended northing depends on
 * latitude alone and strictly decreases with it. Newton would converge faster, but its
 * derivative vanishes at the poles, where Equal Earth's northing flattens and Mercator's is
 * clamped; bisection is immune to both. That same flattening limits accuracy near the poles
 * to ~1e-6° — about 0.1 m, and inherent to the projection, not the solver.
 */
export function mapWorldToGeographic(world: WorldTuple, blend = 0): LngLatTuple {
  if (blend === 0) {
    const inverseScale = (2 * WEB_MERCATOR_MAX) / GRID_FACTOR;
    return fromEqualEarth([(world[0] - 0.5) * inverseScale, (0.5 - world[1]) * inverseScale]);
  }
  if (blend === 1) return worldToMercatorLngLat(world);

  const [north, south] = worldYRange(blend);
  if (!(world[1] >= north - WORLD_EDGE_EPSILON && world[1] <= south + WORLD_EDGE_EPSILON)) {
    return [Number.NaN, Number.NaN];
  }
  const y = clamp(world[1], north, south);

  let low = -90;
  let high = 90;
  for (let i = 0; i < BLEND_INVERSE_STEPS; i++) {
    const mid = (low + high) / 2;
    // World y grows southward: a point south of the target means the latitude is higher.
    if (geographicToMapWorld([0, mid], blend)[1] > y) low = mid;
    else high = mid;
  }
  const lat = (low + high) / 2;

  // Easting is linear in longitude for a fixed latitude: x = 0.5 + lng · slope(lat).
  const slope = geographicToMapWorld([1, lat], blend)[0] - 0.5;
  return [(world[0] - 0.5) / slope, lat];
}

/**
 * World-space y of the north and south edges of the world at a blend.
 *
 * Equal Earth has a ~2.05:1 aspect ratio, so once stretched to fill the Mercator grid
 * horizontally it occupies only the middle ~49% of it vertically; the band widens to the
 * whole grid as the blend approaches Mercator. Tiles wholly outside it contain no map at all
 * and can be skipped outright.
 */
export function worldYRange(blend = 0): [north: number, south: number] {
  return [geographicToMapWorld([0, 90], blend)[1], geographicToMapWorld([0, -90], blend)[1]];
}

/** World-space y of the north edge of the Equal Earth world (≈0.2566). */
export const WORLD_Y_MIN = worldYRange(0)[0];

/** World-space y of the south edge of the Equal Earth world (≈0.7434). */
export const WORLD_Y_MAX = worldYRange(0)[1];

function equalEarthWorld(lngLat: LngLatTuple): WorldTuple {
  const equalEarth = toEqualEarth(lngLat);
  const scale = GRID_FACTOR / (2 * WEB_MERCATOR_MAX);
  return [0.5 + equalEarth[0] * scale, 0.5 - equalEarth[1] * scale];
}

function mercatorWorld(lngLat: LngLatTuple): WorldTuple {
  const mercator = toWebMercator(lngLat);
  return [
    0.5 + mercator[0] / (2 * WEB_MERCATOR_MAX),
    0.5 - mercator[1] / (2 * WEB_MERCATOR_MAX),
  ];
}

function worldToMercatorLngLat(world: WorldTuple): LngLatTuple {
  return fromWebMercator([
    (world[0] - 0.5) * 2 * WEB_MERCATOR_MAX,
    (0.5 - world[1]) * 2 * WEB_MERCATOR_MAX,
  ]);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
