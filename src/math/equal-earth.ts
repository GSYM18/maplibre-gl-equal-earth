/**
 * Equal Earth projection, implemented directly from the closed form given in
 *
 *   Šavrič, B., Patterson, T. & Jenny, B. (2019). "The Equal Earth map projection."
 *   International Journal of Geographical Information Science, 33(3), 454–465.
 *   https://doi.org/10.1080/13658816.2018.1504949
 *
 * This is deliberately not delegated to proj4: the forward transform runs once per
 * vertex per tile inside a worker, where proj4's generic dispatch is far too costly,
 * and registering `EPSG:8857` on proj4's shared singleton would collide with a host
 * application that defines the same code differently.
 */

/** Polynomial coefficients from the paper (Table 2). */
const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;

/** sin(60°) — the parallel-spacing constant of the underlying pseudocylindrical form. */
const M = Math.sqrt(3) / 2;

/**
 * Authalic-ish sphere radius used by EPSG:8857 (`+R=6371008.7714`, the IUGG mean radius).
 *
 * Note this radius cancels out of the Mercator-grid backprojection (see `backproject.ts`),
 * so it only affects the absolute metre values returned by {@link toEqualEarth}.
 */
export const EARTH_RADIUS = 6371008.7714;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** A `[longitude, latitude]` pair in degrees. */
export type LngLatTuple = [number, number];
/** An `[easting, northing]` pair in metres. */
export type PointTuple = [number, number];

/**
 * `y / R` as a function of the parametric latitude θ.
 * Expanded: `A1·θ + A2·θ³ + A3·θ⁷ + A4·θ⁹`.
 */
function northingForTheta(theta: number): number {
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
}

/**
 * `d(y/R) / dθ`. Also the denominator of the easting term, which is what makes the
 * projection equal-area.
 */
function northingDerivative(theta: number): number {
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);
}

/**
 * Half the width of the Equal Earth world, in metres — the easting at (180°, 0°).
 *
 * Derived rather than hardcoded. The widely-quoted EPSG:8857 bound `17243959.06`
 * is this quantity computed with the *authalic* radius 6371007.1809, which
 * disagrees with the `+R=6371008.7714` the CRS itself declares. The difference is
 * 4.3 m (~2.5e-7 relative), but hardcoding it silently decouples the constant from
 * {@link EARTH_RADIUS}.
 */
export const EQUAL_EARTH_X_MAX = (EARTH_RADIUS * Math.PI) / (M * A1);

/** Half the height of the Equal Earth world, in metres — the northing at (0°, 90°). */
export const EQUAL_EARTH_Y_MAX = EARTH_RADIUS * northingForTheta(Math.asin(M));

/**
 * Project geographic coordinates to Equal Earth metres (EPSG:8857).
 *
 * Latitude is clamped to ±90°, which the `asin` domain requires. Longitude is **not**
 * clamped: easting is exactly linear in λ, so values beyond ±180° extrapolate meaningfully.
 * That matters for vector-tile buffers, whose geometry legitimately extends a little past
 * the tile — and past the antimeridian — and would be distorted by a silent clamp.
 */
export function toEqualEarth(lngLat: LngLatTuple): PointTuple {
  const lng = lngLat[0];
  const lat = clamp(lngLat[1], -90, 90);

  const lambda = lng * DEG_TO_RAD;
  const phi = lat * DEG_TO_RAD;

  const theta = Math.asin(clamp(M * Math.sin(phi), -1, 1));

  const x = (EARTH_RADIUS * lambda * Math.cos(theta)) / (M * northingDerivative(theta));
  const y = EARTH_RADIUS * northingForTheta(theta);

  return [x, y];
}

/** Newton iteration budget for the inverse. Convergence is quadratic; 4 is plenty. */
const INVERSE_MAX_ITERATIONS = 12;
/** Convergence threshold on θ, in radians. ~1e-9 rad is well under a micrometre on the ground. */
const INVERSE_EPSILON = 1e-11;

/**
 * Inverse of {@link toEqualEarth}: Equal Earth metres back to geographic degrees.
 *
 * There is no closed-form inverse for θ, so this solves `northingForTheta(θ) = y/R`
 * by Newton's method, as the paper prescribes.
 */
export function fromEqualEarth(point: PointTuple): LngLatTuple {
  const targetNorthing = point[1] / EARTH_RADIUS;

  // Initial guess. northingForTheta is very nearly linear with slope A1 near the
  // equator, so dividing by A1 lands close enough for quadratic convergence to bite.
  let theta = clamp(targetNorthing / A1, -Math.PI / 2, Math.PI / 2);

  for (let i = 0; i < INVERSE_MAX_ITERATIONS; i++) {
    const delta = (northingForTheta(theta) - targetNorthing) / northingDerivative(theta);
    theta -= delta;
    if (Math.abs(delta) < INVERSE_EPSILON) break;
  }

  const phi = Math.asin(clamp(Math.sin(theta) / M, -1, 1));
  const lambda =
    (point[0] * M * northingDerivative(theta)) / (EARTH_RADIUS * Math.cos(theta));

  return [lambda * RAD_TO_DEG, phi * RAD_TO_DEG];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
