/**
 * The cartographic finish of the Equal Earth world (spec §5): the world's boundary as a
 * polygon and a line, and a graticule, all in map space at a band's blend.
 *
 * Pure functions; `style-rewrite.ts` turns them into generated sources and layers.
 */

import { geographicToMap } from '../math/backproject.js';

export interface OutlineOptions {
  /** @defaultValue '#9a9a9a' */
  color?: string;
  /** @defaultValue 1 */
  width?: number;
}

export interface GraticuleOptions {
  /** Degrees between lines; must divide 180. @defaultValue 30 */
  step?: number;
  /** @defaultValue 'rgba(0,0,0,0.2)' */
  color?: string;
  /** @defaultValue 0.75 */
  width?: number;
}

export interface CartographyOptions {
  /** Colour outside the Equal Earth world, in bands with blend < 1. @defaultValue 'transparent' */
  outsideColor?: string;
  /** The world's edge as a line, in bands with blend < 1. Off unless given. */
  outline?: OutlineOptions | boolean;
  /** Meridians and parallels in every band. Off unless given. */
  graticule?: GraticuleOptions | boolean;
}

/** Prefix of every source and layer id this module's output generates. */
export const CARTOGRAPHY_PREFIX = 'equal-earth:';

type Position = [number, number];

/** The ±180° boundary: east meridian pole to pole, then west meridian back, closed. */
function boundary(blend: number, stepDeg: number): Position[] {
  if (!(stepDeg > 0)) throw new TypeError('world: stepDeg must be positive');
  const count = Math.round(180 / stepDeg);
  const ring: Position[] = [];
  for (let i = 0; i <= count; i++) ring.push(geographicToMap([180, -90 + i * stepDeg], blend));
  for (let i = 0; i <= count; i++) ring.push(geographicToMap([-180, 90 - i * stepDeg], blend));
  ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

/** The Equal Earth world at `blend`, in map space: ±180° meridians (sampled every `stepDeg`) closed by the pole lines. */
export function worldPolygon(blend: number, stepDeg = 0.5): GeoJSON.Feature<GeoJSON.Polygon> {
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [boundary(blend, stepDeg)] } };
}

/** The same boundary as one closed LineString. */
export function worldOutline(blend: number, stepDeg = 0.5): GeoJSON.Feature<GeoJSON.LineString> {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: boundary(blend, stepDeg) } };
}

/**
 * Meridians every `step`° from −180 + step to 180 − step, parallels every `step`° strictly
 * between the poles; sampled every 1°, in map space at `blend`.
 */
export function graticule(blend: number, step: number): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  if (!(step > 0) || 180 % step !== 0) {
    throw new TypeError(`graticule: step must be positive and divide 180, got ${step}`);
  }
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  const line = (kind: 'meridian' | 'parallel', value: number, points: Position[]): void => {
    features.push({
      type: 'Feature',
      properties: { kind, value },
      geometry: { type: 'LineString', coordinates: points.map((p) => geographicToMap(p, blend)) },
    });
  };
  for (let lng = -180 + step; lng < 180; lng += step) {
    const points: Position[] = [];
    for (let lat = -90; lat <= 90; lat++) points.push([lng, lat]);
    line('meridian', lng, points);
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    const points: Position[] = [];
    for (let lng = -180; lng <= 180; lng++) points.push([lng, lat]);
    line('parallel', lat, points);
  }
  return { type: 'FeatureCollection', features };
}
