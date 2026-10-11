/**
 * What a band step does to the picture around the camera centre, and how much of it the
 * camera can absorb.
 *
 * With the centre pinned, a step from blend `a` to blend `b` moves a feature at screen offset
 * `d` by `(M_b − M_a) · d` to first order, where `M_t = J_t · J_1⁻¹` is the local Jacobian of
 * the blended warp relative to Mercator. That is independent of zoom (spec §4.2). `M` splits
 * into a similarity — a rotation and an isotropic scale, which the camera's bearing and zoom
 * can cancel — and a shear, which nothing but a cross-fade can soften.
 *
 * Because the world blend is linear in `t`, `M_t = (1 − t) · M_0 + t · I`: one Jacobian at
 * blend 0 describes every band at a point.
 */

import { geographicToMapWorld } from './backproject.js';
import type { LngLatTuple } from './equal-earth.js';

/** `[[a, b], [c, d]]`, acting on column vectors: `(dx, dy) = (a·u + b·v, c·u + d·v)`. */
export type Matrix2 = [a: number, b: number, c: number, d: number];

export type CompensationMode = 'none' | 'zoom' | 'zoom+bearing';

export interface SimilarityOffsets {
  /** Add to the requested zoom. */
  deltaZoom: number;
  /** Add to the requested bearing, in degrees. */
  deltaBearing: number;
}

/**
 * Sign relating the warp's rotation (in world coordinates, y down) to MapLibre's bearing.
 * Pinned by `tests/band-camera.test.ts` ("reduces the geometry snap at a crossing to under
 * 60 % at San Francisco and Zürich"); prose cannot be trusted with this. `-1` won: with `+1`
 * the San Francisco snap grew from 30.7 px to 43.2 px; with `-1` it fell to 16.4 px (Zürich
 * 19.5 px to 6.9 px).
 */
const BEARING_SIGN = -1;

const H = 1e-4;
const IDENTITY: Matrix2 = [1, 0, 0, 1];

/** Jacobian of `geographicToMapWorld(·, blend)` at `point`, by central differences. */
function worldJacobian(point: LngLatTuple, blend: number): Matrix2 {
  const [lng, lat] = point;
  const [xe, ye] = geographicToMapWorld([lng + H, lat], blend);
  const [xw, yw] = geographicToMapWorld([lng - H, lat], blend);
  const [xn, yn] = geographicToMapWorld([lng, lat + H], blend);
  const [xs, ys] = geographicToMapWorld([lng, lat - H], blend);
  return [(xe - xw) / (2 * H), (xn - xs) / (2 * H), (ye - yw) / (2 * H), (yn - ys) / (2 * H)];
}

function multiply(m: Matrix2, n: Matrix2): Matrix2 {
  return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3]];
}

function invert(m: Matrix2): Matrix2 | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || det === 0) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
}

/** `M_t = J_t · J_1⁻¹` at `point`; the identity when the Jacobian cannot be formed. */
export function relativeJacobian(point: LngLatTuple, blend: number): Matrix2 {
  const inverseMercator = invert(worldJacobian(point, 1));
  if (!inverseMercator) return IDENTITY;
  const m = multiply(worldJacobian(point, blend), inverseMercator);
  return m.every(Number.isFinite) ? m : IDENTITY;
}

/** Rotation (radians) and isotropic scale of the similarity closest to `m`. */
export function similarity(m: Matrix2): { rotation: number; scale: number } {
  const [a, b, c, d] = m;
  return { rotation: Math.atan2(c - b, a + d), scale: Math.sqrt(Math.abs(a * d - b * c)) };
}

function blendMatrix(m0: Matrix2, t: number): Matrix2 {
  return [
    (1 - t) * m0[0] + t,
    (1 - t) * m0[1],
    (1 - t) * m0[2],
    (1 - t) * m0[3] + t,
  ];
}

const ZERO: SimilarityOffsets = { deltaZoom: 0, deltaBearing: 0 };

/**
 * Zoom and bearing offsets that make the rotation and scale at `point` look like blend
 * `targetBlend` while band `shownBlend` is drawn (spec §4.2).
 */
export function similarityOffsets(
  point: LngLatTuple,
  shownBlend: number,
  targetBlend: number,
  mode: CompensationMode,
): SimilarityOffsets {
  if (mode === 'none' || shownBlend === targetBlend) return ZERO;
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return ZERO;
  const m0 = relativeJacobian(point, 0);
  const shown = similarity(blendMatrix(m0, shownBlend));
  const target = similarity(blendMatrix(m0, targetBlend));
  const deltaZoom = Math.log2(target.scale / shown.scale);
  if (!Number.isFinite(deltaZoom)) return ZERO;
  const deltaBearing =
    mode === 'zoom+bearing' ? (BEARING_SIGN * (target.rotation - shown.rotation) * 180) / Math.PI : 0;
  return { deltaZoom, deltaBearing: Number.isFinite(deltaBearing) ? deltaBearing : 0 };
}
