/**
 * Working out which source tiles feed an output tile.
 *
 * This is the "stitching and reslicing" problem. Backprojection keeps the Mercator tile grid
 * but moves every vertex, so geometry does not stay inside the tile it came from: an Equal
 * Earth tile's *pre-image* under the warp is a curved quadrilateral that generally overlaps
 * several Mercator tiles, and near the poles overlaps a great many. Passing source tile
 * `(z,x,y)` straight through as output tile `(z,x,y)` therefore loses content — which is why
 * this module exists rather than the pipeline just warping in place.
 */

import {
  MERCATOR_MAX_LATITUDE,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
  mapWorldToGeographic,
} from '../math/backproject.js';

/** An XYZ tile address. */
export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** A geographic bounding box, `[west, south, east, north]` in degrees. */
export type BBox = [number, number, number, number];

export interface TileCoverOptions {
  /**
   * Zoom to read source tiles at. Higher than the output zoom buys detail at 4× the tiles
   * per level; Equal Earth compresses geometry vertically, so +1 visibly helps at z0–2 but
   * OpenFreeMap z2 tiles are ~1.3 MB each, which adds up fast.
   *
   * @defaultValue the output zoom
   */
  sourceZoom?: number;
  /** Highest zoom the source tileset actually has. OpenFreeMap is 14. @defaultValue 14 */
  sourceMaxZoom?: number;
  /**
   * Tile buffer in tile units, matching what the encoder will use. The pre-image is computed
   * for the buffered rect so clipped geometry has something to clip.
   *
   * @defaultValue 64
   */
  buffer?: number;
  /** Boundary samples per tile edge when estimating the pre-image. @defaultValue 8 */
  samplesPerEdge?: number;
}

const DEFAULT_BUFFER = 64;
const DEFAULT_SAMPLES_PER_EDGE = 8;
const DEFAULT_SOURCE_MAX_ZOOM = 14;
const TILE_EXTENT = 4096;

/**
 * The geographic bounding box of an output tile's pre-image under the warp.
 *
 * Returns `null` when the tile lies entirely outside the Equal Earth world — the empty bands
 * above and below it, which at low zoom is a meaningful share of the grid.
 *
 * The boundary is sampled rather than reasoned about analytically. The warp is separately
 * monotone in each coordinate (northing depends on latitude alone; easting is linear in
 * longitude for fixed latitude), so the extremes do lie on the boundary — but the longitude
 * extreme depends on *which* latitude, and a tile straddling the equator has an interior
 * extremum in the narrowing factor. Sampling sidesteps all of that for ~32 inverse warps.
 */
export function preimageBBox(output: TileId, options: TileCoverOptions = {}): BBox | null {
  const buffer = options.buffer ?? DEFAULT_BUFFER;
  const samples = Math.max(1, options.samplesPerEdge ?? DEFAULT_SAMPLES_PER_EDGE);

  const scale = Math.pow(2, output.z);
  const pad = buffer / TILE_EXTENT / scale;

  const west = output.x / scale - pad;
  const east = (output.x + 1) / scale + pad;
  const north = output.y / scale - pad;
  const south = (output.y + 1) / scale + pad;

  // Wholly outside the Equal Earth world's vertical band.
  if (south <= WORLD_Y_MIN || north >= WORLD_Y_MAX) return null;

  // Clamp to the world band so the inverse warp stays in domain.
  const top = Math.max(north, WORLD_Y_MIN);
  const bottom = Math.min(south, WORLD_Y_MAX);

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  const consider = (wx: number, wy: number): void => {
    const [lng, lat] = mapWorldToGeographic([wx, wy]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const x = west + (east - west) * t;
    const y = top + (bottom - top) * t;
    consider(x, top);
    consider(x, bottom);
    consider(west, y);
    consider(east, y);
  }

  if (minLng === Infinity) return null;

  return [minLng, minLat, maxLng, maxLat];
}

/**
 * The source tiles needed to build an output tile.
 *
 * Empty when the output tile falls outside the Equal Earth world.
 */
export function sourceTilesFor(output: TileId, options: TileCoverOptions = {}): TileId[] {
  const bbox = preimageBBox(output, options);
  if (!bbox) return [];

  const maxZoom = options.sourceMaxZoom ?? DEFAULT_SOURCE_MAX_ZOOM;
  const sourceZoom = Math.min(options.sourceZoom ?? output.z, maxZoom);

  return tilesForBBox(bbox, sourceZoom);
}

/** Mercator XYZ tiles at `zoom` covering a geographic bounding box. */
export function tilesForBBox(bbox: BBox, zoom: number): TileId[] {
  const scale = Math.pow(2, zoom);
  const limit = scale - 1;

  const [west, south, east, north] = bbox;

  const xMin = clampInt(Math.floor(lngToTileX(west, scale)), 0, limit);
  const xMax = clampInt(Math.floor(lngToTileX(east, scale)), 0, limit);
  // Tile y increases southward, so north gives the smaller index.
  const yMin = clampInt(Math.floor(latToTileY(north, scale)), 0, limit);
  const yMax = clampInt(Math.floor(latToTileY(south, scale)), 0, limit);

  const tiles: TileId[] = [];
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      tiles.push({ z: zoom, x, y });
    }
  }
  return tiles;
}

/**
 * World-space rectangle of a tile, `[west, north, east, south]`, y increasing southward.
 */
export function tileWorldBounds(tile: TileId): [number, number, number, number] {
  const scale = Math.pow(2, tile.z);
  return [tile.x / scale, tile.y / scale, (tile.x + 1) / scale, (tile.y + 1) / scale];
}

function lngToTileX(lng: number, scale: number): number {
  return ((lng + 180) / 360) * scale;
}

function latToTileY(lat: number, scale: number): number {
  const clamped = Math.min(MERCATOR_MAX_LATITUDE, Math.max(-MERCATOR_MAX_LATITUDE, lat));
  const phi = (clamped * Math.PI) / 180;
  return (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * scale;
}

function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
