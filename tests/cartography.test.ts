import { describe, expect, it } from 'vitest';
import { graticule, worldOutline, worldPolygon } from '../src/map/cartography.js';
import { geographicToMap } from '../src/math/backproject.js';

describe('worldPolygon', () => {
  for (const blend of [0, 0.5, 5 / 6]) {
    it(`is a closed ring through the four corners of the world at blend ${blend}`, () => {
      const ring = worldPolygon(blend).geometry.coordinates[0]!;
      expect(ring[0]).toEqual(ring.at(-1));
      for (const corner of [[-180, -90], [-180, 90], [180, 90], [180, -90]] as const) {
        const expected = geographicToMap([corner[0], corner[1]], blend);
        expect(ring.some((p) => Math.abs(p[0]! - expected[0]) < 1e-9 && Math.abs(p[1]! - expected[1]) < 1e-9)).toBe(true);
      }
      // ±180° sampled every 0.5° from pole to pole: 361 positions per side, plus the closing one.
      expect(ring).toHaveLength(2 * 361 + 1);
    });
  }

  it('is counter-clockwise in lng/lat (GeoJSON exterior), so MapLibre fills the inside', () => {
    const ring = worldPolygon(0).geometry.coordinates[0]!;
    let area2 = 0;
    for (let i = 0; i < ring.length - 1; i++) area2 += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
    expect(area2).toBeGreaterThan(0);
  });

  it('bulges: the map-space ±180° meridian is curved, its equator point is the widest', () => {
    const ring = worldPolygon(0).geometry.coordinates[0]!;
    const east = ring.filter((p) => p[0]! > 0);
    const widest = east.reduce((a, b) => (b[0]! > a[0]! ? b : a));
    expect(Math.abs(widest[1]!)).toBeLessThan(1e-9);
    expect(Math.min(...east.map((p) => p[0]!))).toBeLessThan(widest[0]! * 0.7);
  });
});

describe('worldOutline', () => {
  it('traces the same boundary as the polygon', () => {
    expect(worldOutline(0.5).geometry.coordinates).toEqual(worldPolygon(0.5).geometry.coordinates[0]);
  });
});

describe('graticule', () => {
  it('has 11 meridians and 5 parallels at 30°, each sampled every 1°', () => {
    const lines = graticule(0, 30).features;
    const meridians = lines.filter((f) => f.properties!['kind'] === 'meridian');
    const parallels = lines.filter((f) => f.properties!['kind'] === 'parallel');
    expect(meridians).toHaveLength(11); // −150 … 150
    expect(parallels).toHaveLength(5); // −60 … 60
    expect(meridians[0]!.geometry.coordinates).toHaveLength(181);
    expect(parallels[0]!.geometry.coordinates).toHaveLength(361);
  });

  it('is geographic in the Mercator band', () => {
    const meridian = graticule(1, 30).features.find((f) => f.properties!['kind'] === 'meridian')!;
    expect(meridian.geometry.coordinates.every((p) => p[0] === -150)).toBe(true);
  });

  it('rejects a step that does not divide 180', () => {
    expect(() => graticule(0, 7)).toThrow(TypeError);
  });
});
