import { describe, expect, it } from 'vitest';

import { geographicToMapWorld } from '../src/math/backproject.js';
import {
  EQUAL_EARTH_CRS_NAME,
  EQUAL_EARTH_DEFINITION,
  equalEarthConverter,
  equalEarthCrs,
  equalEarthProjectionHandler,
} from '../src/math/crs.js';
import { EQUAL_EARTH_X_MAX, EQUAL_EARTH_Y_MAX, toEqualEarth } from '../src/math/equal-earth.js';

/** World coordinates of a CRS position, as MapLibre's `CRSWorldCoordinateHelper` computes them. */
function crsWorld(lngLat: [number, number]): [number, number] {
  const crs = equalEarthCrs();
  const [x, y] = crs.projection.forward(lngLat);
  const { origin, extentAtZoom0 } = crs.tileMatrixSet;
  return [(x! - origin[0]) / extentAtZoom0, (origin[1] - y!) / extentAtZoom0];
}

describe('equalEarthCrs', () => {
  it('has a name MapLibre accepts for a registered projection (it contains a colon)', () => {
    expect(EQUAL_EARTH_CRS_NAME).toContain(':');
    expect(equalEarthCrs().name).toBe(EQUAL_EARTH_CRS_NAME);
    expect(equalEarthCrs().definition).toBe(EQUAL_EARTH_DEFINITION);
  });

  it('lays its tile grid exactly over the blend-0 map space the eqearth:// tiles are cut in', () => {
    for (const p of [[0, 0], [8.54, 47.37], [-122.42, 37.77], [151.21, -33.87], [180, 90], [-180, -90], [179.5, 0]] as [number, number][]) {
      const [x, y] = crsWorld(p);
      const [wx, wy] = geographicToMapWorld(p, 0);
      expect(x).toBeCloseTo(wx, 12);
      expect(y).toBeCloseTo(wy, 12);
    }
  });

  it('is a square grid centred on the world', () => {
    const { origin, extentAtZoom0 } = equalEarthCrs().tileMatrixSet;
    expect(origin).toEqual([-EQUAL_EARTH_X_MAX, EQUAL_EARTH_X_MAX]);
    expect(extentAtZoom0).toBe(2 * EQUAL_EARTH_X_MAX);
  });

  it('round-trips inside the world', () => {
    const { forward, inverse } = equalEarthCrs().projection;
    for (let lng = -180; lng <= 180; lng += 30) {
      for (let lat = -90; lat <= 90; lat += 15) {
        const back = inverse(forward([lng, lat]));
        expect(back).not.toBeNull();
        if (Math.abs(lat) < 90) expect(back![0]).toBeCloseTo(lng, 7);
        expect(back![1]).toBeCloseTo(lat, 6);
      }
    }
  });

  it('has no answer outside the world, so MapLibre uses its edge', () => {
    const { inverse } = equalEarthCrs().projection;
    // Beside the rounded outline: the inverse longitude would exceed 180°.
    const corner = toEqualEarth([180, 60]);
    expect(inverse([corner[0] * 1.05, corner[1]])).toBeNull();
    // Above and below the world.
    expect(inverse([0, EQUAL_EARTH_Y_MAX * 1.01])).toBeNull();
    expect(inverse([0, -EQUAL_EARTH_Y_MAX * 1.01])).toBeNull();
    // The edge itself still answers.
    expect(inverse(toEqualEarth([180, 0]))).not.toBeNull();
    expect(inverse([0, EQUAL_EARTH_Y_MAX])).not.toBeNull();
  });

  it('returns a fresh object each time (MapLibre may keep it)', () => {
    expect(equalEarthCrs()).not.toBe(equalEarthCrs());
  });
});

describe('equalEarthProjectionHandler', () => {
  it('builds the Equal Earth converter for our definition', () => {
    const converter = equalEarthProjectionHandler(EQUAL_EARTH_DEFINITION);
    expect(converter.forward([10, 20])).toEqual(equalEarthConverter().forward([10, 20]));
    expect(converter.inverse(converter.forward([10, 20]))![0]).toBeCloseTo(10, 9);
  });

  it('refuses any other definition', () => {
    expect(() => equalEarthProjectionHandler('+proj=stere +lat_0=90')).toThrow(/Equal Earth/);
  });
});
