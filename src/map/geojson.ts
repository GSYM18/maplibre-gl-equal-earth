/**
 * GeoJSON sources under Equal Earth (spec §7).
 *
 * A vector source is warped tile by tile in the worker (`tiles/`); a GeoJSON source is warped
 * whole, on the main thread, once per band: the style rewrite fans it out into one source per
 * band with blend < 1, each holding the data warped into that band's map space, and the
 * controller keeps those copies in step with the application's `setData`/`updateData`. MapLibre
 * then tiles, clusters and simplifies the warped data like any other, so clustering happens in
 * map space (accepted: the cluster radius is in pixels, and pixels are what the map shows).
 *
 * Each copy is densified once, for the highest zoom its band is parsed at, capped at
 * {@link GEOJSON_MAX_DENSIFY_ZOOM}: densifying for the deepest zoom MapLibre could request would
 * multiply the vertices of every long line for zooms at which that band is never shown.
 */

import { parseRange, type ResolvedTransition } from './bands.js';
import { toleranceForZoom } from '../math/subdivide.js';
import { warpFeature } from '../tiles/mvt.js';

/** Densification of a band's GeoJSON copy never targets a zoom beyond this. */
export const GEOJSON_MAX_DENSIFY_ZOOM = 12;

/** Subdivision recursion cap, as for tiles. */
const MAX_DEPTH = 8;

/**
 * The zoom whose tolerance a band's GeoJSON is densified for: the top of its parse range, capped
 * at {@link GEOJSON_MAX_DENSIFY_ZOOM} (pure Equal Earth, without a transition: the cap).
 */
export function geojsonZoomForBand(transition: ResolvedTransition | null, band: number): number {
  return transition ? Math.min(parseRange(transition, band)[1], GEOJSON_MAX_DENSIFY_ZOOM) : GEOJSON_MAX_DENSIFY_ZOOM;
}

/** `geometry` clipped, densified and warped, or `null` when nothing of it is left. */
function warpGeometry(geometry: GeoJSON.Geometry, tolerance: number, blend: number): GeoJSON.Geometry | null {
  if (geometry.type === 'GeometryCollection') {
    const geometries: GeoJSON.Geometry[] = [];
    for (const member of geometry.geometries) {
      const warped = warpGeometry(member, tolerance, blend);
      if (warped) geometries.push(warped);
    }
    return geometries.length > 0 ? { type: 'GeometryCollection', geometries } : null;
  }
  const warped = warpFeature({ type: 'Feature', properties: null, geometry }, tolerance, MAX_DEPTH, blend);
  return warped ? warped.geometry : null;
}

/**
 * Clip to ±180°, densify for `zoom` and warp into the map space of `blend`. Features that clip
 * away, and features without a geometry, are dropped. A bare geometry becomes a feature with
 * empty properties. Ids and properties are carried; the input is not mutated.
 */
export function warpGeoJSON(data: GeoJSON.GeoJSON, blend: number, zoom: number): GeoJSON.FeatureCollection {
  const tolerance = toleranceForZoom(zoom);
  const features: GeoJSON.Feature[] =
    data.type === 'FeatureCollection'
      ? data.features
      : data.type === 'Feature'
        ? [data]
        : [{ type: 'Feature', properties: {}, geometry: data }];
  const out: GeoJSON.Feature[] = [];
  for (const feature of features) {
    if (!feature.geometry) continue;
    const geometry = warpGeometry(feature.geometry, tolerance, blend);
    if (!geometry) continue;
    out.push({
      type: 'Feature',
      ...(feature.id === undefined ? {} : { id: feature.id }),
      properties: feature.properties,
      geometry,
    });
  }
  return { type: 'FeatureCollection', features: out };
}
