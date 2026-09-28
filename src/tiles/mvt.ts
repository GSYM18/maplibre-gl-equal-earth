/**
 * The tile warp: decode → densify → warp → reslice → encode.
 *
 * Clipping and reslicing are delegated to `geojson-vt` rather than hand-written. That is a
 * deliberate call: correct polygon clipping with winding preservation, buffers and
 * simplification is a large amount of subtle geometry code, and `geojson-vt` is the very
 * library MapLibre uses for its own GeoJSON sources — so its output is exactly what the
 * renderer already expects.
 */

import { VectorTile } from '@mapbox/vector-tile';
import geojsonvt, { type GeoJSONVTTile } from 'geojson-vt';
// pbf 5 split the old default-exported `Pbf` class into PbfReader/PbfWriter.
import { PbfReader } from 'pbf';
import { fromGeojsonVt } from 'vt-pbf';

import { geographicToMap } from '../math/backproject.js';
import type { LngLatTuple } from '../math/equal-earth.js';
import { densify, TILE_EXTENT, toleranceForZoom } from '../math/subdivide.js';
import type { TileId } from './tile-cover.js';

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
  /**
   * `geojson-vt` simplification tolerance, in tile units.
   *
   * **Defaults to 0 (disabled), unlike geojson-vt's own default of 3.** Douglas–Peucker
   * drops any vertex lying within the tolerance of its neighbours' chord — which is
   * precisely the set of vertices adaptive subdivision just added. With geojson-vt's
   * default of 3 against a subdivision target of 1, simplification removed essentially all
   * of them and the warp degenerated to plain vertex displacement (measured: 1.00–1.04×
   * vertex count, i.e. no curvature recovered at all).
   *
   * Densification is already adaptive and emits a near-minimal vertex set, so there is
   * little left to simplify. If you do enable it, keep it below `toleranceTileUnits`.
   *
   * @defaultValue 0
   */
  simplifyTolerance?: number;
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

/** Merge decoded source tiles into one set of layers. */
export function mergeLayers(tiles: readonly GeographicLayers[]): GeographicLayers {
  const merged: GeographicLayers = new Map();
  for (const tile of tiles) {
    for (const [name, features] of tile) {
      const existing = merged.get(name);
      if (existing) existing.push(...features);
      else merged.set(name, [...features]);
    }
  }
  return merged;
}

/**
 * Densify and warp a feature's geometry from geographic into map space.
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
    case 'Point':
      warped = { type: 'Point', coordinates: warpPosition(geometry.coordinates) };
      break;
    case 'MultiPoint':
      warped = { type: 'MultiPoint', coordinates: geometry.coordinates.map(warpPosition) };
      break;
    case 'LineString':
      warped = { type: 'LineString', coordinates: warpLine(geometry.coordinates) };
      break;
    case 'MultiLineString':
      warped = { type: 'MultiLineString', coordinates: geometry.coordinates.map(warpLine) };
      break;
    case 'Polygon':
      warped = { type: 'Polygon', coordinates: geometry.coordinates.map(warpLine) };
      break;
    case 'MultiPolygon':
      warped = {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map((polygon) => polygon.map(warpLine)),
      };
      break;
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

  const encoded: Record<string, GeoJSONVTTile> = {};

  for (const [name, features] of sourceLayers) {
    const warped: GeoJSON.Feature[] = [];
    for (const feature of features) {
      const result = warpFeature(feature, tolerance, maxDepth, blend);
      if (result) warped.push(result);
    }
    if (warped.length === 0) continue;

    // `indexMaxZoom: 0` keeps indexing lazy, so only the requested tile is clipped
    // rather than a whole pyramid being materialised for a single request.
    const index = geojsonvt(
      { type: 'FeatureCollection', features: warped },
      {
        maxZoom: Math.max(output.z, 1),
        indexMaxZoom: 0,
        tolerance: options.simplifyTolerance ?? 0,
        extent,
        buffer,
        debug: 0,
      },
    );

    const tile = index.getTile(output.z, output.x, output.y);
    if (tile && tile.features.length > 0) encoded[name] = tile;
  }

  if (Object.keys(encoded).length === 0) return new Uint8Array(0);

  return fromGeojsonVt(encoded, { version: 2, extent });
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
