/**
 * Adaptive subdivision for the tile warp.
 *
 * Backprojection moves vertices but leaves edges straight, and a straight line in Mercator is
 * a *curve* in Equal Earth. At z0–3 the map is almost entirely large polygons — country fills,
 * coastlines, long boundary lines — so without densification those edges render as visible
 * chords. Adding vertices before warping is therefore the single biggest determinant of
 * visual quality at exactly the zooms Equal Earth is for.
 *
 * Refinement is adaptive rather than fixed-grid: vertices are spent only where the projection
 * actually bends. That pays off unusually well here, because of the shape of the projection:
 *
 * Equal Earth is *pseudocylindrical*. Easting is `x = λ · g(φ)` and northing depends on φ
 * alone, so **parallels stay perfectly straight** and need no subdivision at all, while
 * **meridians bend** — increasingly so with |λ| (a meridian at λ=0 stays straight, since
 * x ≡ 0) and with |φ|. So the vertex budget goes almost entirely to north–south edges far
 * from the prime meridian, and a fixed grid would be simultaneously wasteful on east–west
 * edges and insufficient on the worst meridians.
 */

import { geographicToMapWorld, type WorldTuple } from './backproject.js';
import type { LngLatTuple } from './equal-earth.js';

/** MapLibre's vector tile extent. Tile-local coordinates run 0..EXTENT. */
export const TILE_EXTENT = 4096;

export interface SubdivideOptions {
  /**
   * Maximum permitted deviation, in normalised world units, between the true warped curve
   * and the straight segment approximating it. Derive it with {@link toleranceForZoom}.
   */
  tolerance: number;
  /**
   * Hard cap on recursion depth. Each level can double the vertex count, so this bounds the
   * output at `2^maxDepth` points per input segment no matter how badly behaved the geometry.
   *
   * @defaultValue 8
   */
  maxDepth?: number;
  /**
   * Blend between Equal Earth (0) and Web Mercator (1) that deviation is measured in. Each
   * zoom band of the adaptive projection warps with its own blend, so it subdivides with it
   * too. Refinement stays a pure function of the endpoints *and* the blend, so tiles of the
   * same band still meet exactly.
   *
   * @defaultValue 0
   */
  blend?: number;
}

const DEFAULT_MAX_DEPTH = 8;

/**
 * Deviation tolerance for a given zoom, expressed as a number of tile units.
 *
 * A tile spans `1 / 2^z` world units and `TILE_EXTENT` tile units, so one tile unit is
 * `1 / (2^z · TILE_EXTENT)` world units. Roughly one tile unit ≈ one screen pixel at the
 * tile's native zoom, so `tileUnits` of 1–2 is imperceptible and 8+ starts to show.
 */
export function toleranceForZoom(zoom: number, tileUnits = 1): number {
  return tileUnits / (Math.pow(2, zoom) * TILE_EXTENT);
}

/**
 * Densify a geographic polyline and warp it into normalised world space.
 *
 * Returns world-space points; the input is never returned unwarped, because every caller
 * needs the warped form and computing the warp twice would double the cost of the hot loop.
 *
 * **Seam safety.** Every refinement decision is a pure function of the segment's two
 * *geographic* endpoints and the tolerance — never of tile identity, traversal direction, or
 * accumulated state. Two adjacent tiles that share an edge therefore subdivide it identically
 * and their geometry meets exactly. The midpoint test is symmetric in its endpoints, so a
 * shared edge traversed in opposite directions still yields the same point set.
 */
export function densifyAndWarp(
  points: readonly LngLatTuple[],
  options: SubdivideOptions,
): WorldTuple[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const toleranceSquared = options.tolerance * options.tolerance;
  const blend = options.blend ?? 0;

  if (points.length === 0) return [];

  const first = points[0]!;
  const output: WorldTuple[] = [geographicToMapWorld(first, blend)];

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    refine(
      a,
      output[output.length - 1]!,
      b,
      geographicToMapWorld(b, blend),
      0,
      maxDepth,
      toleranceSquared,
      blend,
      output,
    );
  }

  return output;
}

/**
 * Densify a geographic polyline, returning **geographic** points.
 *
 * Same refinement decisions as {@link densifyAndWarp} — deviation is still measured in world
 * space, because that is what the renderer sees — but the output stays in lng/lat. This is
 * what the tile pipeline wants: `geojson-vt` performs its own Mercator projection when
 * indexing, so it must be handed lng/lat, and pre-projecting would be undone.
 */
export function densify(
  points: readonly LngLatTuple[],
  options: SubdivideOptions,
): LngLatTuple[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const toleranceSquared = options.tolerance * options.tolerance;
  const blend = options.blend ?? 0;

  if (points.length === 0) return [];

  const output: LngLatTuple[] = [points[0]!];

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    refineGeographic(
      a,
      geographicToMapWorld(a, blend),
      b,
      geographicToMapWorld(b, blend),
      0,
      maxDepth,
      toleranceSquared,
      blend,
      output,
    );
  }

  return output;
}

function refineGeographic(
  a: LngLatTuple,
  aWorld: WorldTuple,
  b: LngLatTuple,
  bWorld: WorldTuple,
  depth: number,
  maxDepth: number,
  toleranceSquared: number,
  blend: number,
  output: LngLatTuple[],
): void {
  if (depth >= maxDepth) {
    output.push(b);
    return;
  }

  const mid: LngLatTuple = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const midWorld = geographicToMapWorld(mid, blend);

  const dx = midWorld[0] - (aWorld[0] + bWorld[0]) / 2;
  const dy = midWorld[1] - (aWorld[1] + bWorld[1]) / 2;

  if (dx * dx + dy * dy <= toleranceSquared) {
    output.push(b);
    return;
  }

  refineGeographic(a, aWorld, mid, midWorld, depth + 1, maxDepth, toleranceSquared, blend, output);
  refineGeographic(mid, midWorld, b, bWorld, depth + 1, maxDepth, toleranceSquared, blend, output);
}

/**
 * Append the warped approximation of the segment `a → b`, excluding `a` (already emitted)
 * and including `b`.
 */
function refine(
  a: LngLatTuple,
  aWorld: WorldTuple,
  b: LngLatTuple,
  bWorld: WorldTuple,
  depth: number,
  maxDepth: number,
  toleranceSquared: number,
  blend: number,
  output: WorldTuple[],
): void {
  if (depth >= maxDepth) {
    output.push(bWorld);
    return;
  }

  // Geographic midpoint — a plain arithmetic mean, which is what makes the decision
  // reproducible from the endpoints alone.
  const mid: LngLatTuple = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const midWorld = geographicToMapWorld(mid, blend);

  // How far the true warped midpoint sits from the chord's midpoint.
  const chordX = (aWorld[0] + bWorld[0]) / 2;
  const chordY = (aWorld[1] + bWorld[1]) / 2;
  const dx = midWorld[0] - chordX;
  const dy = midWorld[1] - chordY;

  if (dx * dx + dy * dy <= toleranceSquared) {
    output.push(bWorld);
    return;
  }

  refine(a, aWorld, mid, midWorld, depth + 1, maxDepth, toleranceSquared, blend, output);
  refine(mid, midWorld, b, bWorld, depth + 1, maxDepth, toleranceSquared, blend, output);
}

/** Warp a ring or line without densifying — for point geometry, or when detail is irrelevant. */
export function warpOnly(points: readonly LngLatTuple[], blend = 0): WorldTuple[] {
  return points.map((point) => geographicToMapWorld(point, blend));
}
