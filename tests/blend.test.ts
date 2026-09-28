import { describe, expect, it } from 'vitest';

import {
  MAP_SPACE_MAX_LATITUDE,
  MERCATOR_MAX_LATITUDE,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
  geographicToMap,
  geographicToMapWorld,
  mapSpaceMaxLatitude,
  mapToGeographic,
  mapWorldToGeographic,
  worldYRange,
} from '../src/math/backproject.js';
import type { LngLatTuple } from '../src/math/equal-earth.js';

/** Web Mercator in normalised world space, written out independently of the module under test. */
function mercatorWorld([lng, lat]: LngLatTuple): [number, number] {
  const clamped = Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, lat));
  const phi = (clamped * Math.PI) / 180;
  return [lng / 360 + 0.5, 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)];
}

function grid(filter: (lat: number) => boolean = () => true): LngLatTuple[] {
  const points: LngLatTuple[] = [];
  for (let lng = -180; lng <= 180; lng += 15) {
    for (let lat = -90; lat <= 90; lat += 7.5) {
      if (filter(lat)) points.push([lng, lat]);
    }
  }
  return points;
}

const INTERMEDIATE = [1 / 3, 2 / 3];
const awayFromPoles = (lat: number) => Math.abs(lat) <= 82.5;
const nearPoles = (lat: number) => Math.abs(lat) > 82.5;

function maxError(a: LngLatTuple, b: LngLatTuple): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

describe('blended warp', () => {
  it('leaves the published blend-0 constants unchanged', () => {
    expect(worldYRange(0)).toEqual([WORLD_Y_MIN, WORLD_Y_MAX]);
    expect(WORLD_Y_MIN).toBeCloseTo(0.2566, 4);
    expect(mapSpaceMaxLatitude(0)).toBe(MAP_SPACE_MAX_LATITUDE);
    expect(MAP_SPACE_MAX_LATITUDE).toBeCloseTo(65.54, 2);
  });

  it('is plain Web Mercator at blend 1', () => {
    for (const p of grid((lat) => Math.abs(lat) <= 85)) {
      const world = geographicToMapWorld(p, 1);
      const expected = mercatorWorld(p);
      expect(world[0]).toBeCloseTo(expected[0], 12);
      expect(world[1]).toBeCloseTo(expected[1], 12);
      expect(geographicToMap(p, 1)).toEqual(p);
      expect(mapToGeographic(p, 1)).toEqual(p);
    }
  });

  it('mixes the two world positions linearly', () => {
    for (const t of INTERMEDIATE) {
      for (const p of grid()) {
        const world = geographicToMapWorld(p, t);
        const equalEarth = geographicToMapWorld(p, 0);
        const mercator = mercatorWorld(p);
        expect(world[0]).toBeCloseTo(equalEarth[0] + t * (mercator[0] - equalEarth[0]), 12);
        expect(world[1]).toBeCloseTo(equalEarth[1] + t * (mercator[1] - equalEarth[1]), 12);
      }
    }
  });

  it('inverts to 1e-9° away from the poles', () => {
    for (const t of [...INTERMEDIATE, 0.999]) {
      for (const p of grid(awayFromPoles)) {
        expect(maxError(mapWorldToGeographic(geographicToMapWorld(p, t), t), p)).toBeLessThan(1e-9);
      }
    }
  });

  it('inverts to 1e-5° (about 1 m) at the poles, where the northing flattens', () => {
    for (const t of INTERMEDIATE) {
      for (const p of grid(nearPoles)) {
        expect(maxError(mapWorldToGeographic(geographicToMapWorld(p, t), t), p)).toBeLessThan(1e-5);
      }
    }
  });

  it('round-trips through map-space lng/lat, which is what the camera sees', () => {
    for (const t of INTERMEDIATE) {
      for (const p of grid(awayFromPoles)) {
        expect(maxError(mapToGeographic(geographicToMap(p, t), t), p)).toBeLessThan(1e-9);
      }
    }
  });

  it('shrinks the empty bands above and below the world as the blend approaches Mercator', () => {
    const ranges = [0, 1 / 3, 2 / 3, 1].map((t) => worldYRange(t));
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]![0]).toBeLessThan(ranges[i - 1]![0]);
      expect(ranges[i]![1]).toBeGreaterThan(ranges[i - 1]![1]);
    }
    expect(ranges[3]![0]).toBeCloseTo(0, 12);
    expect(ranges[3]![1]).toBeCloseTo(1, 12);
  });

  it('returns NaN outside the world band but accepts a point on its edge', () => {
    const t = 1 / 3;
    const [north] = worldYRange(t);
    expect(mapWorldToGeographic([0.5, north - 1e-6], t)[1]).toBeNaN();
    expect(mapWorldToGeographic([0.5, north - 1e-13], t)[1]).toBeCloseTo(90, 5);
    expect(mapWorldToGeographic([0.5, north], t)[1]).toBeCloseTo(90, 5);
  });

  it('raises the map-space world edge towards Mercator as the blend grows', () => {
    const edges = [0, 1 / 3, 2 / 3, 1].map((t) => mapSpaceMaxLatitude(t));
    for (let i = 1; i < edges.length; i++) expect(edges[i]!).toBeGreaterThan(edges[i - 1]!);
    expect(edges[3]).toBe(MERCATOR_MAX_LATITUDE);
  });
});
