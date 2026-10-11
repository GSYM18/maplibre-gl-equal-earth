import { describe, expect, it } from 'vitest';

import { GEOJSON_MAX_DENSIFY_ZOOM, geojsonZoomForBand, warpGeoJSON } from '../src/map/geojson.js';
import { resolveTransition } from '../src/map/bands.js';
import { geographicToMap } from '../src/math/backproject.js';

const zurich: GeoJSON.Feature = { type: 'Feature', properties: { name: 'Zürich' }, geometry: { type: 'Point', coordinates: [8.54, 47.37] } };

describe('warpGeoJSON', () => {
  it("warps a point into the band's map space", () => {
    const out = warpGeoJSON(zurich, 0.5, 6);
    expect(out.features[0]!.geometry).toEqual({ type: 'Point', coordinates: geographicToMap([8.54, 47.37], 0.5) });
    expect(out.features[0]!.properties).toEqual({ name: 'Zürich' });
  });

  it('accepts a bare geometry and a FeatureCollection', () => {
    expect(warpGeoJSON({ type: 'Point', coordinates: [0, 0] }, 0, 2).features).toHaveLength(1);
    expect(warpGeoJSON({ type: 'FeatureCollection', features: [zurich, zurich] }, 0, 2).features).toHaveLength(2);
  });

  // Equal Earth, and every blend of it with Mercator, is pseudocylindrical: a parallel stays a
  // straight horizontal line and needs no vertices, while a meridian curves.
  it('densifies a long meridian so it curves in Equal Earth', () => {
    const line: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[170, -70], [170, 70]] } };
    const coords = (warpGeoJSON(line, 0, 4).features[0]!.geometry as GeoJSON.LineString).coordinates;
    expect(coords.length).toBeGreaterThan(10);
    const parallel: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-170, 60], [170, 60]] } };
    expect((warpGeoJSON(parallel, 0, 4).features[0]!.geometry as GeoJSON.LineString).coordinates).toHaveLength(2);
  });

  it('drops features that lie entirely beyond ±180°', () => {
    expect(warpGeoJSON({ type: 'Point', coordinates: [200, 0] }, 0, 2).features).toHaveLength(0);
  });

  it('keeps feature ids and leaves no undefined id behind', () => {
    const [withId] = warpGeoJSON({ ...zurich, id: 7 }, 0, 2).features;
    expect(withId!.id).toBe(7);
    const [without] = warpGeoJSON(zurich, 0, 2).features;
    expect('id' in without!).toBe(false);
  });

  it('warps each member of a GeometryCollection and drops the members that clip away', () => {
    const collection: GeoJSON.Feature = {
      type: 'Feature',
      properties: { k: 1 },
      geometry: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [8.54, 47.37] }, { type: 'Point', coordinates: [200, 0] }] },
    };
    const [out] = warpGeoJSON(collection, 0, 2).features;
    expect(out!.geometry).toEqual({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: geographicToMap([8.54, 47.37], 0) }] });
    expect(warpGeoJSON({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [200, 0] }] }, 0, 2).features).toHaveLength(0);
  });

  it('does not mutate its input', () => {
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [structuredClone(zurich)] };
    const snapshot = JSON.stringify(data);
    warpGeoJSON(data, 0, 2);
    expect(JSON.stringify(data)).toBe(snapshot);
  });
});

describe('geojsonZoomForBand', () => {
  it("uses the top of the band's parse range, capped", () => {
    const six = resolveTransition();
    expect(geojsonZoomForBand(six, 0)).toBeCloseTo(4.8, 9); // band 0 parses up to b_1 + s = 4 + 0.8
    expect(geojsonZoomForBand(six, 6)).toBe(GEOJSON_MAX_DENSIFY_ZOOM); // Mercator: parsed to the top
    expect(geojsonZoomForBand(null, 0)).toBe(GEOJSON_MAX_DENSIFY_ZOOM);
  });
});
