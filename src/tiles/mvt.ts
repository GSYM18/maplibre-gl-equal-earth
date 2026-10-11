/**
 * The tile warp: decode → densify → warp → clip → encode.
 *
 * Clipping to the output tile is `clip.ts` (Sutherland–Hodgman / Liang–Barsky straight into
 * integer tile units). It replaced `geojson-vt`, which built a tile index per output tile and
 * per layer; the encoder is still vt-pbf, fed the same tile structure. Decoding is the largest
 * cost, which is why the protocol caches decoded source tiles (`protocol.ts`).
 */

import { VectorTile } from '@mapbox/vector-tile';
// pbf 5 split the old default-exported `Pbf` class into PbfReader/PbfWriter.
import { PbfReader } from 'pbf';
import { fromGeojsonVt } from 'vt-pbf';

import {
  clipLinesToWorld,
  clipLineToWorld,
  clipPointsToWorld,
  clipPolygonToWorld,
} from '../math/antimeridian.js';
import { geographicToMap } from '../math/backproject.js';
import type { LngLatTuple } from '../math/equal-earth.js';
import { densify, TILE_EXTENT, toleranceForZoom } from '../math/subdivide.js';
import { clipFeatureToTile, type TileFeature } from './clip.js';
import { preimageBBox, type BBox, type TileId } from './tile-cover.js';

export interface WarpTileOptions {
  /** Output tile extent. @defaultValue 4096 */
  extent?: number;
  /** Output tile buffer, in tile units. @defaultValue 64 */
  buffer?: number;
  /**
   * Subdivision budget, as a permitted deviation in output tile units. 1 is roughly one
   * screen pixel at the tile's native zoom.
   *
   * @defaultValue 1
   */
  toleranceTileUnits?: number;
  /** Hard recursion cap for subdivision. @defaultValue 8 */
  maxDepth?: number;
  /** Restrict to these source layers. Omit to keep all. */
  layers?: readonly string[];
  /** Blend of the zoom band this tile is built for: 0 Equal Earth … 1 Mercator. @defaultValue 0 */
  blend?: number;
}

/** One decoded source tile: GeoJSON features in true geographic coordinates, by layer. */
export type GeographicLayers = Map<string, GeoJSON.Feature[]>;

/**
 * Decode a Mercator MVT into geographic GeoJSON, by layer.
 *
 * `feature.toGeoJSON(x, y, z)` does the tile-local → lng/lat conversion for us, including
 * the buffer region, so geometry that overhangs the source tile is preserved rather than
 * being silently cut at the tile edge.
 */
export function decodeToGeographic(
  data: ArrayBuffer | Uint8Array,
  tile: TileId,
  layers?: readonly string[],
): GeographicLayers {
  const reader = new PbfReader(data instanceof Uint8Array ? data : new Uint8Array(data));
  const vectorTile = new VectorTile(reader);
  const result: GeographicLayers = new Map();

  for (const name of Object.keys(vectorTile.layers)) {
    if (layers && !layers.includes(name)) continue;
    const layer = vectorTile.layers[name];
    if (!layer) continue;

    const features: GeoJSON.Feature[] = [];
    for (let i = 0; i < layer.length; i++) {
      features.push(layer.feature(i).toGeoJSON(tile.x, tile.y, tile.z));
    }
    if (features.length > 0) result.set(name, features);
  }

  return result;
}

/**
 * Merge decoded source tiles into one set of layers.
 *
 * A label point near a source tile edge is repeated in the neighbouring tile's buffer, at the
 * same integer global position, so it decodes to identical coordinates from both; low-zoom
 * OpenFreeMap tiles carry a label in up to nine source tiles. A `Point` that repeats an
 * earlier one in the same layer with the same `id` and coordinates is that duplicate and is
 * dropped; otherwise the output tile would place the label once per source tile.
 *
 * Some tiles carry the same label as a `MultiPoint` with a world copy (Algeria at 3° and
 * −357°), others as a plain `Point`. The copy beyond ±180° is removed before warping anyway, so
 * only positions inside the world are compared, per position: a `Point` or `MultiPoint` none
 * of whose in-world positions is new for its `id` is dropped, and a `MultiPoint` with some
 * seen and some new positions is replaced by a copy holding only the new ones (the input is
 * not mutated). Features without an `id` are kept: nothing says they are the same feature.
 */
export function mergeLayers(tiles: readonly GeographicLayers[]): GeographicLayers {
  const merged: GeographicLayers = new Map();
  const seenPoints = new Map<string, Set<string>>();
  for (const tile of tiles) {
    for (const [name, features] of tile) {
      let target = merged.get(name);
      if (!target) {
        target = [];
        merged.set(name, target);
      }
      for (const feature of features) {
        const geometry = feature.geometry;
        if (feature.id !== undefined && (geometry.type === 'Point' || geometry.type === 'MultiPoint')) {
          let seen = seenPoints.get(name);
          if (!seen) {
            seen = new Set();
            seenPoints.set(name, seen);
          }
          const positions = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
          const fresh: GeoJSON.Position[] = [];
          let repeated = false;
          for (const position of positions) {
            if (Math.abs(position[0]!) > 180) continue;
            const key = `${feature.id}|${position[0]}|${position[1]}`;
            if (seen.has(key)) {
              repeated = true;
            } else {
              seen.add(key);
              fresh.push(position);
            }
          }
          if (fresh.length === 0) continue;
          if (repeated) {
            target.push({ ...feature, geometry: { type: 'MultiPoint', coordinates: fresh } });
            continue;
          }
        }
        target.push(feature);
      }
    }
  }
  return merged;
}

/**
 * Clip, densify and warp a feature's geometry from geographic into map space.
 *
 * Geometry is first clipped to longitude [-180, 180]. Equal Earth is not periodic in
 * longitude, so world copies cannot be warped faithfully: they would land in the map at the
 * wrong place (see `antimeridian.ts`). Returns `null` when nothing is left.
 *
 * Points are warped without densification — there is nothing between a point and itself.
 */
export function warpFeature(
  feature: GeoJSON.Feature,
  tolerance: number,
  maxDepth: number,
  blend = 0,
): GeoJSON.Feature | null {
  const geometry = feature.geometry;
  if (!geometry || geometry.type === 'GeometryCollection') return null;

  const warpPosition = (p: GeoJSON.Position): GeoJSON.Position =>
    geographicToMap([p[0]!, p[1]!], blend);

  const warpLine = (line: GeoJSON.Position[]): GeoJSON.Position[] =>
    densify(
      line.map((p) => [p[0]!, p[1]!] as LngLatTuple),
      { tolerance, maxDepth, blend },
    ).map((p) => geographicToMap(p, blend) as GeoJSON.Position);

  let warped: GeoJSON.Geometry;
  switch (geometry.type) {
    case 'Point': {
      if (Math.abs(geometry.coordinates[0]!) > 180) return null;
      warped = { type: 'Point', coordinates: warpPosition(geometry.coordinates) };
      break;
    }
    case 'MultiPoint': {
      const points = clipPointsToWorld(geometry.coordinates);
      if (points.length === 0) return null;
      warped = { type: 'MultiPoint', coordinates: points.map(warpPosition) };
      break;
    }
    case 'LineString': {
      const parts = clipLineToWorld(geometry.coordinates);
      if (parts.length === 0) return null;
      warped =
        parts.length === 1
          ? { type: 'LineString', coordinates: warpLine(parts[0]!) }
          : { type: 'MultiLineString', coordinates: parts.map(warpLine) };
      break;
    }
    case 'MultiLineString': {
      const parts = clipLinesToWorld(geometry.coordinates);
      if (parts.length === 0) return null;
      warped = { type: 'MultiLineString', coordinates: parts.map(warpLine) };
      break;
    }
    case 'Polygon': {
      const rings = clipPolygonToWorld(geometry.coordinates);
      if (!rings) return null;
      warped = { type: 'Polygon', coordinates: rings.map(warpLine) };
      break;
    }
    case 'MultiPolygon': {
      const polygons: GeoJSON.Position[][][] = [];
      for (const polygon of geometry.coordinates) {
        const rings = clipPolygonToWorld(polygon);
        if (rings) polygons.push(rings);
      }
      if (polygons.length === 0) return null;
      warped = {
        type: 'MultiPolygon',
        coordinates: polygons.map((polygon) => polygon.map(warpLine)),
      };
      break;
    }
  }

  return { type: 'Feature', id: feature.id, properties: feature.properties, geometry: warped };
}

/**
 * Build one output tile from already-decoded source layers.
 *
 * Returns an empty `Uint8Array` when nothing survives — MapLibre's `addProtocol` contract
 * treats a zero-length `ArrayBuffer` as a legitimately empty tile, not an error.
 */
export function buildTile(
  sourceLayers: GeographicLayers,
  output: TileId,
  options: WarpTileOptions = {},
): Uint8Array {
  const extent = options.extent ?? TILE_EXTENT;
  const buffer = options.buffer ?? 64;
  const maxDepth = options.maxDepth ?? 8;
  const tolerance = toleranceForZoom(output.z, options.toleranceTileUnits ?? 1);
  const blend = options.blend ?? 0;

  // Most features handed in lie wholly outside this output tile: the source cover overlaps
  // several output tiles, and low-zoom source tiles carry wide buffers. Rejecting them on
  // their geographic bounding box skips the warp, which dominates the cost.
  //
  // Why this never drops a feature that reaches the buffered tile: the blended warp is
  // pseudocylindrical (northing depends on latitude alone; easting is linear in longitude at
  // a fixed latitude). So the tile's horizontal edges map back to parallels, and on its
  // vertical edges `lng(x, lat)` is monotone in |lat|; the geographic pre-image's extremes
  // therefore sit at the edge endpoints (or at latitude 0, itself a tile boundary for z ≥ 1),
  // which `preimageBBox` samples. A feature whose bbox misses that box has every vertex
  // outside the buffered tile, and its densified chords deviate from the true curve by about
  // one tile unit, far inside the margin: the box is taken with twice the tile buffer (64 extra
  // units). `tests/clip.test.ts` "buildTile pre-warp reject" fails with a reach buffer of 0.
  const reachBuffer = (2 * buffer * TILE_EXTENT) / extent;
  const reach = preimageBBox(output, { blend, buffer: reachBuffer });
  if (!reach) return new Uint8Array(0);

  const encoded: Record<string, { features: TileFeature[] }> = {};

  for (const [name, features] of sourceLayers) {
    const clipped: TileFeature[] = [];
    for (const feature of features) {
      if (!mayReach(feature.geometry, reach)) continue;
      const warped = warpFeature(feature, tolerance, maxDepth, blend);
      if (!warped) continue;
      const result = clipFeatureToTile(warped, output, extent, buffer);
      if (result) clipped.push(result);
    }
    if (clipped.length > 0) encoded[name] = { features: clipped };
  }

  if (Object.keys(encoded).length === 0) return new Uint8Array(0);

  return fromGeojsonVt(encoded, { version: 2, extent });
}

/** Whether a geometry's geographic bounding box intersects `bbox` (`[west, south, east, north]`). */
function mayReach(geometry: GeoJSON.Geometry | null, bbox: BBox): boolean {
  if (!geometry || geometry.type === 'GeometryCollection') return false;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const extend = (p: GeoJSON.Position): void => {
    const lng = p[0]!;
    const lat = p[1]!;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  };
  switch (geometry.type) {
    case 'Point':
      extend(geometry.coordinates);
      break;
    case 'MultiPoint':
    case 'LineString':
      geometry.coordinates.forEach(extend);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const line of geometry.coordinates) line.forEach(extend);
      break;
    case 'MultiPolygon':
      for (const polygon of geometry.coordinates) for (const ring of polygon) ring.forEach(extend);
      break;
  }
  return west <= bbox[2] && east >= bbox[0] && south <= bbox[3] && north >= bbox[1];
}

/**
 * Full pipeline for one output tile, given the raw bytes of its source tiles.
 *
 * Source tiles whose bytes are `null` (a 204, or a tile the server does not have) are
 * skipped rather than failing the whole output tile.
 */
export function warpTiles(
  sources: readonly { tile: TileId; data: ArrayBuffer | Uint8Array | null }[],
  output: TileId,
  options: WarpTileOptions = {},
): Uint8Array {
  const decoded: GeographicLayers[] = [];
  for (const source of sources) {
    if (!source.data) continue;
    const byteLength =
      source.data instanceof Uint8Array ? source.data.byteLength : source.data.byteLength;
    if (byteLength === 0) continue;
    decoded.push(decodeToGeographic(source.data, source.tile, options.layers));
  }

  if (decoded.length === 0) return new Uint8Array(0);

  return buildTile(mergeLayers(decoded), output, options);
}
