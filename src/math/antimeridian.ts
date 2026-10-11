/**
 * Restricting geometry to the one real world, longitude ∈ [−180, 180].
 *
 * Source Mercator tiles carry geometry beyond the antimeridian: label points are repeated as
 * whole-world copies (a z0 tile holds the United Kingdom at −3°, +357° and −363°), and
 * polygons and lines overhang by the tile buffer. Mercator is periodic in longitude, so a
 * copy simply lands one world over. Equal Earth is not — easting is `lng × f(lat)` with
 * `f < 1` off the equator — so a copy lands *short* of one world over: in the empty corners
 * beside the rounded outline, or, through geojson-vt's `wrap()` (which the pipeline used to
 * clip with), folded back into the map at the wrong place. Equal Earth has no world copies
 * (`renderWorldCopies` is off), so anything beyond ±180° has no valid place and is removed
 * before warping.
 *
 * Geometry already inside the band is returned by reference: this runs per feature per tile.
 */

import type { Position } from 'geojson';

const LNG_MAX = 180;

const inBand = (p: Position): boolean => p[0]! >= -LNG_MAX && p[0]! <= LNG_MAX;

/** Where the segment a→b crosses the meridian `lng`, interpolated linearly in lng/lat. */
function crossing(a: Position, b: Position, lng: number): Position {
  const t = (lng - a[0]!) / (b[0]! - a[0]!);
  return [lng, a[1]! + t * (b[1]! - a[1]!)];
}

/** Drop every position with |lng| > 180. Exactly ±180 is kept. */
export function clipPointsToWorld(points: Position[]): Position[] {
  return points.every(inBand) ? points : points.filter(inBand);
}

/**
 * Clip a line to the band, splitting it where it leaves and re-enters. Parts with fewer than
 * two positions are dropped — on the in-range fast path too, so a degenerate input line is
 * dropped whether or not it lies in the band.
 */
export function clipLineToWorld(line: Position[]): Position[][] {
  if (line.length < 2) return [];
  if (line.every(inBand)) return [line];

  const parts: Position[][] = [];
  let current: Position[] = [];
  const flush = (): void => {
    if (current.length >= 2) parts.push(current);
    current = [];
  };

  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = b[0]! - a[0]!;

    // Parametric extent [t0, t1] of the segment inside the band (Liang-Barsky, one axis).
    let t0 = 0;
    let t1 = 1;
    if (dx === 0) {
      if (!inBand(a)) t1 = -1;
    } else {
      const ta = (-LNG_MAX - a[0]!) / dx;
      const tb = (LNG_MAX - a[0]!) / dx;
      t0 = Math.max(0, Math.min(ta, tb));
      t1 = Math.min(1, Math.max(ta, tb));
    }
    // A segment that only touches the band at a point contributes nothing of its own.
    if (t0 >= t1) {
      if (t1 < 1) flush();
      continue;
    }

    if (t0 > 0) {
      flush();
      current.push(crossing(a, b, dx > 0 ? -LNG_MAX : LNG_MAX));
    } else if (current.length === 0) {
      current.push(a);
    }
    if (t1 < 1) {
      current.push(crossing(a, b, dx > 0 ? LNG_MAX : -LNG_MAX));
      flush();
    } else {
      current.push(b);
    }
  }
  flush();
  return parts;
}

/**
 * Clip several lines; returns the input unchanged when every line is already in range and has
 * at least two positions.
 */
export function clipLinesToWorld(lines: Position[][]): Position[][] {
  return lines.every((line) => line.length >= 2 && line.every(inBand))
    ? lines
    : lines.flatMap(clipLineToWorld);
}

/** Sutherland–Hodgman against one vertical half-plane, over an open vertex list. */
function clipAgainst(vertices: Position[], edge: number, keepAbove: boolean): Position[] {
  const inside = (p: Position): boolean => (keepAbove ? p[0]! >= edge : p[0]! <= edge);
  const out: Position[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const cur = vertices[i]!;
    const prev = vertices[(i + vertices.length - 1) % vertices.length]!;
    if (inside(cur)) {
      if (!inside(prev)) out.push(crossing(prev, cur, edge));
      out.push(cur);
    } else if (inside(prev)) {
      out.push(crossing(prev, cur, edge));
    }
  }
  return out;
}

function clipRing(ring: Position[]): Position[] | null {
  if (ring.every(inBand)) return ring;
  // Work on the open ring, then close it again.
  let vertices = ring.slice(0, -1);
  vertices = clipAgainst(vertices, -LNG_MAX, true);
  vertices = clipAgainst(vertices, LNG_MAX, false);
  if (vertices.length < 3) return null;
  return [...vertices, [...vertices[0]!]];
}

/**
 * Clip a polygon's rings to the band. Returns `null` when the outer ring does not survive
 * (taking its holes with it); a hole that does not survive is simply dropped.
 */
export function clipPolygonToWorld(rings: Position[][]): Position[][] | null {
  if (rings.every((ring) => ring.every(inBand))) return rings;

  const shell = rings[0] ? clipRing(rings[0]) : null;
  if (!shell) return null;
  const clipped = [shell];
  for (let i = 1; i < rings.length; i++) {
    const hole = clipRing(rings[i]!);
    if (hole) clipped.push(hole);
  }
  return clipped;
}
