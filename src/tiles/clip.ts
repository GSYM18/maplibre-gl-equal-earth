/**
 * Clipping warped geometry straight into one output tile.
 *
 * This replaced `geojson-vt`, which builds a tile index per output tile and per layer (a
 * whole projection, wrap and clip pass to answer one `getTile`) inside a pipeline that cost
 * 100–750 ms per tile, and the transition gate waits on every one of them. Here each feature
 * is projected once into the output tile's integer units and clipped to the buffered tile
 * rectangle directly:
 *
 * - **Rings: Sutherland–Hodgman** against the four edges in turn. It walks a ring's
 *   consecutive vertex pairs and keeps the inside part, so the output is still one ring in the
 *   same orientation. Holes stay separate rings. vt-pbf and MapLibre classify rings into
 *   polygons and holes by winding relative to the feature's first ring, so the feature's first
 *   outer ring keeps its orientation, every later outer ring is made to match it and every
 *   hole to oppose it. MVT-decoded input already satisfies that (a no-op); it guards against
 *   a hole wound like its shell, which would otherwise render as a filled polygon. Clipping a
 *   concave ring can leave zero-width spurs along the tile edge; they lie in the buffer, which
 *   is never drawn.
 * - **Line segments: Liang–Barsky**, the parametric clip of `p0 → p1` to `[t0, t1]`.
 *   Consecutive surviving segments join into one run; a run ends where a segment leaves the
 *   rectangle, so a line that leaves and re-enters becomes two lines.
 * - **Points:** a bounds test.
 *
 * Coordinates are rounded to integer tile units right after projection, and clipping happens
 * in that integer space (intersections are rounded again), so the output is exactly what the
 * encoder will store. Consecutive duplicates that rounding produces are collapsed.
 *
 * Nothing is simplified: the vertices adaptive subdivision adds are the point of the warp.
 */

import { geographicToMapWorld } from '../math/backproject.js';
import type { TileId } from './tile-cover.js';

/**
 * One feature in vt-pbf's `fromGeojsonVt` input shape: points `[[x, y], …]`, lines and
 * polygons `[[[x, y], …], …]`, in integer tile units.
 */
export interface TileFeature {
  /** 1 point, 2 line, 3 polygon. */
  type: 1 | 2 | 3;
  geometry: number[][] | number[][][];
  tags: Record<string, unknown>;
  id?: number;
}

type Pt = [number, number];

/** The buffered tile rectangle, `[min, max]` on both axes. */
interface Box {
  min: number;
  max: number;
}

/**
 * Project a map-space feature into `output`'s tile units and clip it to the tile plus
 * `buffer`. Returns `null` when nothing is left.
 *
 * `feature.geometry` is in **map-space lng/lat** — `warpFeature`'s output — which Mercator
 * projects to the warped world position.
 */
export function clipFeatureToTile(
  feature: GeoJSON.Feature,
  output: TileId,
  extent: number,
  buffer: number,
): TileFeature | null {
  const geometry = feature.geometry;
  if (!geometry) return null;

  const scale = 2 ** output.z;
  const project = (p: GeoJSON.Position): Pt => {
    const world = geographicToMapWorld([p[0]!, p[1]!], 1);
    // Mercator's world ends at the pole clamp; never let a latitude push past it.
    const wy = world[1] < 0 ? 0 : world[1] > 1 ? 1 : world[1];
    return [
      Math.round((world[0] * scale - output.x) * extent),
      Math.round((wy * scale - output.y) * extent),
    ];
  };
  const box: Box = { min: -buffer, max: extent + buffer };

  let type: 1 | 2 | 3;
  let clipped: number[][] | number[][][];
  switch (geometry.type) {
    case 'Point':
    case 'MultiPoint': {
      const positions = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
      const points: number[][] = [];
      for (const position of positions) {
        const p = project(position);
        if (p[0] >= box.min && p[0] <= box.max && p[1] >= box.min && p[1] <= box.max) points.push(p);
      }
      type = 1;
      clipped = points;
      break;
    }
    case 'LineString':
    case 'MultiLineString': {
      const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
      const runs: number[][][] = [];
      for (const line of lines) clipLine(line.map(project), box, runs);
      type = 2;
      clipped = runs;
      break;
    }
    case 'Polygon':
    case 'MultiPolygon': {
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      const rings: number[][][] = [];
      // Sign of the first surviving outer ring's area: the feature's reference orientation.
      let outerSign = 0;
      for (const polygon of polygons) {
        const outer = polygon[0] ? clipRing(polygon[0].map(project), box) : null;
        // A polygon whose outer ring is gone takes its holes with it.
        if (!outer) continue;
        if (outerSign === 0) outerSign = Math.sign(outer.area);
        rings.push(closeRing(outer, outerSign));
        for (let i = 1; i < polygon.length; i++) {
          const hole = clipRing(polygon[i]!.map(project), box);
          if (hole) rings.push(closeRing(hole, -outerSign));
        }
      }
      type = 3;
      clipped = rings;
      break;
    }
    default:
      return null;
  }

  if (clipped.length === 0) return null;
  const result: TileFeature = {
    type,
    geometry: clipped,
    tags: feature.properties ?? {},
  };
  if (typeof feature.id === 'number') result.id = feature.id;
  return result;
}

/* -------------------------------------------------------------------------- lines */

/**
 * Liang–Barsky: the parameter range `[t0, t1]` of `a → b` inside the box, or `null` when the
 * segment misses it.
 */
function liangBarsky(a: Pt, b: Pt, box: Box): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const range: [number, number] = [0, 1];
  // Each (p, q) pair is one edge: the segment is inside that edge where p·t <= q.
  return clipT(-dx, a[0] - box.min, range) &&
    clipT(dx, box.max - a[0], range) &&
    clipT(-dy, a[1] - box.min, range) &&
    clipT(dy, box.max - a[1], range)
    ? range
    : null;
}

/** Narrow `range` by one Liang–Barsky edge; `false` when the segment is wholly outside it. */
function clipT(p: number, q: number, range: [number, number]): boolean {
  if (p === 0) return q >= 0;
  const r = q / p;
  if (p < 0) {
    if (r > range[1]) return false;
    if (r > range[0]) range[0] = r;
  } else {
    if (r < range[0]) return false;
    if (r < range[1]) range[1] = r;
  }
  return true;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [
  Math.round(a[0] + t * (b[0] - a[0])),
  Math.round(a[1] + t * (b[1] - a[1])),
];

/** Append a point unless it repeats the previous one. */
function pushDistinct(run: number[][], p: Pt): void {
  const last = run[run.length - 1];
  if (!last || last[0] !== p[0] || last[1] !== p[1]) run.push(p);
}

/** Clip one projected line, appending its surviving runs (each ≥ 2 distinct points) to `runs`. */
function clipLine(points: Pt[], box: Box, runs: number[][][]): void {
  // Wholly inside, the common case: one run, no per-segment work.
  if (points.every((p) => p[0] >= box.min && p[0] <= box.max && p[1] >= box.min && p[1] <= box.max)) {
    const run: number[][] = [];
    for (const p of points) pushDistinct(run, p);
    if (run.length >= 2) runs.push(run);
    return;
  }

  let run: number[][] = [];
  const flush = (): void => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const range = liangBarsky(a, b, box);
    if (!range) {
      flush();
      continue;
    }
    const [t0, t1] = range;
    // Entering from outside: whatever came before ended at the rectangle's edge.
    if (t0 > 0) flush();
    pushDistinct(run, t0 > 0 ? lerp(a, b, t0) : a);
    pushDistinct(run, t1 < 1 ? lerp(a, b, t1) : b);
    if (t1 < 1) flush();
  }
  flush();
}

/* -------------------------------------------------------------------------- rings */

/**
 * Sutherland–Hodgman against one edge: `axis` 0 is x, 1 is y; `keepAbove` keeps the side
 * where the coordinate is ≥ `edge`. Works on an open vertex list (first not repeated).
 */
function clipEdge(vertices: Pt[], axis: 0 | 1, edge: number, keepAbove: boolean): Pt[] {
  const inside = (p: Pt): boolean => (keepAbove ? p[axis] >= edge : p[axis] <= edge);
  const intersect = (a: Pt, b: Pt): Pt => {
    const t = (edge - a[axis]) / (b[axis] - a[axis]);
    const other = Math.round(a[1 - axis]! + t * (b[1 - axis]! - a[1 - axis]!));
    return axis === 0 ? [edge, other] : [other, edge];
  };

  const out: Pt[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const current = vertices[i]!;
    const previous = vertices[(i + vertices.length - 1) % vertices.length]!;
    if (inside(current)) {
      if (!inside(previous)) out.push(intersect(previous, current));
      out.push(current);
    } else if (inside(previous)) {
      out.push(intersect(previous, current));
    }
  }
  return out;
}

/** A ring as an open vertex list: consecutive duplicates collapsed, closing point removed. */
function openDistinct(points: Pt[]): Pt[] {
  const vertices: Pt[] = [];
  for (const p of points) {
    const last = vertices[vertices.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) vertices.push(p);
  }
  while (vertices.length > 1) {
    const first = vertices[0]!;
    const last = vertices[vertices.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) break;
    vertices.pop();
  }
  return vertices;
}

/** A clipped ring, open, with its signed shoelace area (×2) in tile units, y down. */
interface ClippedRing {
  vertices: Pt[];
  area: number;
}

/**
 * Clip one projected ring. Returns its open vertex list in the original orientation, or
 * `null` when fewer than three distinct vertices or no area remain.
 */
function clipRing(points: Pt[], box: Box): ClippedRing | null {
  let vertices = openDistinct(points);
  if (vertices.length < 3) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of vertices) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // Wholly outside: nothing to clip. Wholly inside, the common case: nothing to do.
  if (maxX < box.min || minX > box.max || maxY < box.min || minY > box.max) return null;
  if (minX < box.min || maxX > box.max || minY < box.min || maxY > box.max) {
    vertices = clipEdge(vertices, 0, box.min, true);
    vertices = clipEdge(vertices, 0, box.max, false);
    vertices = clipEdge(vertices, 1, box.min, true);
    vertices = clipEdge(vertices, 1, box.max, false);
    vertices = openDistinct(vertices);
    if (vertices.length < 3) return null;
  }

  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i]!;
    const q = vertices[(i + 1) % vertices.length]!;
    area += p[0] * q[1] - q[0] * p[1];
  }
  if (area === 0) return null;
  return { vertices, area };
}

/** Close a clipped ring (first point repeated last), wound so its area has sign `sign`. */
function closeRing(ring: ClippedRing, sign: number): number[][] {
  const vertices: number[][] = Math.sign(ring.area) === sign ? ring.vertices : ring.vertices.reverse();
  vertices.push([vertices[0]![0]!, vertices[0]![1]!]);
  return vertices;
}
