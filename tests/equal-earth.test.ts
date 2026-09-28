import { describe, expect, it } from 'vitest';

import {
  EARTH_RADIUS,
  EQUAL_EARTH_X_MAX,
  EQUAL_EARTH_Y_MAX,
  fromEqualEarth,
  toEqualEarth,
  type LngLatTuple,
} from '../src/math/equal-earth.js';

/**
 * A lon/lat sweep used by several suites. Deliberately includes the poles, the
 * antimeridian and the equator — the places where the projection or its inverse
 * is most likely to degenerate.
 */
function graticule(lngStep = 15, latStep = 10): LngLatTuple[] {
  const points: LngLatTuple[] = [];
  for (let lng = -180; lng <= 180; lng += lngStep) {
    for (let lat = -90; lat <= 90; lat += latStep) {
      points.push([lng, lat]);
    }
  }
  return points;
}

describe('toEqualEarth', () => {
  it('maps the origin to the origin', () => {
    expect(toEqualEarth([0, 0])).toEqual([0, 0]);
  });

  it('reproduces the published EPSG:8857 extent', () => {
    // epsg.io/8857 quotes the projected bounds as ±17243959.06 × ±8392927.60.
    // Those figures were computed with the authalic radius 6371007.1809 while the
    // CRS declares +R=6371008.7714, so our derived values are ~4.3 m / ~2.1 m larger.
    // Assert against the published numbers with a tolerance that admits exactly that.
    expect(toEqualEarth([180, 0])[0]).toBeCloseTo(17243959.06, -1);
    expect(toEqualEarth([0, 90])[1]).toBeCloseTo(8392927.6, -1);

    expect(EQUAL_EARTH_X_MAX).toBeCloseTo(17243963.37, 2);
    expect(EQUAL_EARTH_Y_MAX).toBeCloseTo(8392929.69, 2);
  });

  it('derives the x half-extent as R·π/(M·A1)', () => {
    const expected = (EARTH_RADIUS * Math.PI) / ((Math.sqrt(3) / 2) * 1.340264);
    expect(EQUAL_EARTH_X_MAX).toBeCloseTo(expected, 9);
  });

  it('is symmetric about both axes', () => {
    for (const [lng, lat] of graticule()) {
      const [x, y] = toEqualEarth([lng, lat]);
      expect(toEqualEarth([-lng, lat])[0]).toBeCloseTo(-x, 6);
      expect(toEqualEarth([lng, -lat])[1]).toBeCloseTo(-y, 6);
    }
  });

  it('is equal-area: equal-area graticule cells project to equal-area quadrilaterals', () => {
    // Sample cells spanning 10° of longitude and equal *sine of latitude* increments
    // (i.e. equal spherical area) must come out with equal projected area.
    const cellArea = (latLow: number, latHigh: number): number => {
      const corners: LngLatTuple[] = [
        [0, latLow],
        [10, latLow],
        [10, latHigh],
        [0, latHigh],
      ];
      const projected = corners.map(toEqualEarth);
      // Shoelace formula.
      let sum = 0;
      for (let i = 0; i < projected.length; i++) {
        const a = projected[i]!;
        const b = projected[(i + 1) % projected.length]!;
        sum += a[0] * b[1] - b[0] * a[1];
      }
      return Math.abs(sum) / 2;
    };

    const areas: number[] = [];
    for (let k = 0; k < 8; k++) {
      // Equal steps in sin(lat) ⇒ equal spherical area.
      const latLow = Math.asin(k / 8) * (180 / Math.PI);
      const latHigh = Math.asin((k + 1) / 8) * (180 / Math.PI);
      areas.push(cellArea(latLow, latHigh));
    }

    // Straight-edged quadrilaterals only approximate the curved cells, so allow a
    // few percent. An area-distorting projection (Mercator) would be out by orders
    // of magnitude here, which is what this guards against.
    const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
    for (const area of areas) {
      expect(Math.abs(area - mean) / mean).toBeLessThan(0.05);
    }
  });
});

describe('fromEqualEarth', () => {
  it('round-trips the graticule to sub-millimetre precision', () => {
    for (const point of graticule(5, 5)) {
      const [lng, lat] = fromEqualEarth(toEqualEarth(point));
      // At the poles longitude is degenerate (cos θ → the pole is a line, not a point),
      // so only latitude is meaningful there.
      if (Math.abs(point[1]) < 90) {
        expect(lng).toBeCloseTo(point[0], 9);
      }
      expect(lat).toBeCloseTo(point[1], 9);
    }
  });

  it('converges at the poles', () => {
    expect(fromEqualEarth(toEqualEarth([0, 90]))[1]).toBeCloseTo(90, 9);
    expect(fromEqualEarth(toEqualEarth([0, -90]))[1]).toBeCloseTo(-90, 9);
  });

  it('returns finite values across the full projected extent', () => {
    for (let fx = -1; fx <= 1; fx += 0.1) {
      for (let fy = -1; fy <= 1; fy += 0.1) {
        const result = fromEqualEarth([fx * EQUAL_EARTH_X_MAX, fy * EQUAL_EARTH_Y_MAX]);
        expect(Number.isFinite(result[0])).toBe(true);
        expect(Number.isFinite(result[1])).toBe(true);
      }
    }
  });
});
