/**
 * The package version, inlined by every build that compiles `src/` (`define` in vite.config.ts,
 * vite.worker.config.ts, vitest.config.ts and tests/browser/vite.config.ts). It names the
 * persistent tile cache (`src/tiles/persistent-cache.ts`).
 */
declare const __EQE_VERSION__: string;

/**
 * Minimal ambient declarations for the two tile libraries that ship no types.
 *
 * `@types/geojson-vt` exists but describes the v3 namespace-style export, which does not
 * match v4's ESM default export, so it is declared here instead. geojson-vt is a dev
 * dependency only: `tests/clip.test.ts` keeps it as the reference the direct clip is
 * compared against.
 */

declare module 'geojson-vt' {
  export interface GeoJSONVTOptions {
    /** Max zoom to preserve detail on. */
    maxZoom?: number;
    /** Max zoom in the initial tile index. 0 makes indexing fully lazy. */
    indexMaxZoom?: number;
    /** Max points per tile in the index. */
    indexMaxPoints?: number;
    /** Simplification tolerance, relative to `extent`. */
    tolerance?: number;
    /** Tile extent. */
    extent?: number;
    /** Tile buffer, in the same units as `extent`. */
    buffer?: number;
    /** 0 disables logging. */
    debug?: 0 | 1 | 2;
    lineMetrics?: boolean;
    promoteId?: string | null;
    generateId?: boolean;
  }

  /**
   * A geometry in a tile returned by `getTile` (already transformed to tile units): points
   * `[[x, y], …]`, lines and polygons `[[[x, y], …], …]`.
   */
  export type GeoJSONVTGeometry = number[][] | number[][][];

  export interface GeoJSONVTFeature {
    /** 1 = point, 2 = linestring, 3 = polygon. */
    type: 1 | 2 | 3;
    geometry: GeoJSONVTGeometry;
    tags: Record<string, unknown> | null;
    id?: string | number;
  }

  export interface GeoJSONVTTile {
    features: GeoJSONVTFeature[];
    numPoints: number;
    numSimplified: number;
    numFeatures: number;
    source: unknown;
    x: number;
    y: number;
    z: number;
    transformed: boolean;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }

  export interface GeoJSONVTIndex {
    /** Returns `null` for a tile with no content. */
    getTile(z: number, x: number, y: number): GeoJSONVTTile | null;
    tiles: Record<number, GeoJSONVTTile>;
    tileCoords: { z: number; x: number; y: number }[];
  }

  export default function geojsonvt(
    data: GeoJSON.GeoJSON,
    options?: GeoJSONVTOptions,
  ): GeoJSONVTIndex;
}

declare module 'vt-pbf' {
  export interface FromGeojsonVtOptions {
    /** Vector tile spec version. MapLibre expects 2. */
    version?: number;
    extent?: number;
  }

  /**
   * Serialise tiles, keyed by layer name, to an uncompressed MVT buffer. Each layer needs only
   * `features`, each `{ type, geometry, tags, id? }` in tile units: `TileFeature` from
   * `src/tiles/clip.ts`, or a tile from geojson-vt's `getTile`. Typed loosely so both fit.
   */
  export function fromGeojsonVt(
    layers: Record<string, { readonly features: readonly unknown[] }>,
    options?: FromGeojsonVtOptions,
  ): Uint8Array;

  export function fromVectorTileJs(tile: unknown): Uint8Array;
}
