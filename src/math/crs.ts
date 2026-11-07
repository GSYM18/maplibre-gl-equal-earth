/**
 * Equal Earth as a coordinate reference system for MapLibre's experimental `addProjection`
 * (6.15+; spec `2026-11-07-native-equal-earth-addprojection-design.md` §2).
 *
 * A registered CRS makes MapLibre convert lng/lat to and from a planar tile grid itself, while
 * the tiles must already be cut in that grid: MapLibre does not reproject them. The grid here is
 * chosen so that it is *exactly* the blend-0 map space the `eqearth://` tiles are warped into:
 * `world = (EE + X_MAX) / 2·X_MAX`, which is `geographicToMapWorld(p, 0)` (`backproject.ts`,
 * where `GRID_FACTOR` scales the Equal Earth width onto the Mercator world). So the plugin's
 * existing pure Equal Earth tiles, zoom levels and URLs feed it unchanged.
 *
 * Pure and without MapLibre types: the worker bundle builds the GeoJSON projection handler from
 * it too.
 */

import { EQUAL_EARTH_X_MAX, EQUAL_EARTH_Y_MAX, fromEqualEarth, toEqualEarth, type LngLatTuple } from './equal-earth.js';

/** The name the plugin registers. MapLibre requires a colon in a registered projection's name. */
export const EQUAL_EARTH_CRS_NAME = 'equal-earth:native';

/**
 * The CRS as a PROJ string, handed by MapLibre to the workers' projection handler for GeoJSON.
 * The sphere is the plugin's (`EARTH_RADIUS`), not EPSG:8857's ellipsoid: the tiles are warped on
 * it, and only the handler below ever reads this string.
 */
export const EQUAL_EARTH_DEFINITION = '+proj=eqearth +R=6371008.7714 +units=m +no_defs';

/** The shape of MapLibre's `CRS['projection']` (and of a proj4 converter). */
export interface CrsConverter {
  forward: (position: number[]) => number[];
  inverse: (position: number[]) => number[] | null;
}

/** The shape of MapLibre's `CRS` (`src/geo/projection/crs.ts`, v6.15+). */
export interface CrsDefinition {
  name: string;
  definition?: string;
  projection: CrsConverter;
  tileMatrixSet: { origin: [number, number]; extentAtZoom0: number };
}

/** Slack for positions on the world edge that round to just outside it. */
const EDGE_EPSILON = 1e-9;

/**
 * Equal Earth metres ↔ lng/lat. The inverse answers `null` beside or beyond the world (|lng| >
 * 180° or |northing| > Y_MAX): MapLibre then uses the edge of the answers on the line to the
 * grid's centre, which is the world's centre here.
 */
export function equalEarthConverter(): CrsConverter {
  return {
    forward: (position) => toEqualEarth([position[0]!, position[1]!]),
    inverse: (position) => {
      const x = position[0]!;
      const y = position[1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (Math.abs(y) > EQUAL_EARTH_Y_MAX * (1 + EDGE_EPSILON)) return null;
      const lngLat: LngLatTuple = fromEqualEarth([x, y]);
      if (!(Math.abs(lngLat[0]) <= 180 + EDGE_EPSILON)) return null;
      return lngLat;
    },
  };
}

/** A fresh CRS object for `maplibregl.addProjection`. */
export function equalEarthCrs(): CrsDefinition {
  return {
    name: EQUAL_EARTH_CRS_NAME,
    definition: EQUAL_EARTH_DEFINITION,
    projection: equalEarthConverter(),
    tileMatrixSet: { origin: [-EQUAL_EARTH_X_MAX, EQUAL_EARTH_X_MAX], extentAtZoom0: 2 * EQUAL_EARTH_X_MAX },
  };
}

/**
 * The workers' projection handler (`self.setProjectionHandler`): MapLibre calls it with a
 * registered CRS's `definition` when a GeoJSON source loads under that CRS. MapLibre keeps one
 * handler per worker, so any other definition is refused loudly rather than drawn wrongly.
 */
export function equalEarthProjectionHandler(definition: string): CrsConverter {
  if (definition !== EQUAL_EARTH_DEFINITION) {
    throw new Error(
      `[equal-earth] the workers' projection handler is the Equal Earth plugin's and cannot build "${definition}"; ` +
        'set a handler that answers both definitions.',
    );
  }
  return equalEarthConverter();
}
