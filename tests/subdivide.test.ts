import { describe, expect, it } from 'vitest';

import {
  densifyAndWarp,
  toleranceForZoom,
  TILE_EXTENT,
  warpOnly,
} from '../src/math/subdivide.js';
import { geographicToMap, geographicToMapWorld } from '../src/math/backproject.js';
import type { LngLatTuple } from '../src/math/equal-earth.js';

describe('geographicToMapWorld', () => {
  it('agrees with geographicToMap composed with the Mercator forward', () => {
    // The two must describe the same point: geographicToMapWorld just skips the
    // round trip through fabricated lng/lat.
    const toWorldViaLngLat = (lngLat: LngLatTuple) => {
      const [lng, lat] = geographicToMap(lngLat);
      const phi = (lat * Math.PI) / 180;
      return [
        (lng + 180) / 360,
        0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI),
      ];
    };

    for (const point of [
      [0, 0],
      [8.5, 47.4],
      [-73.98, 40.75],
      [180, 0],
      [-180, -60],
      [0, 89],
    ] satisfies LngLatTuple[]) {
      const direct = geographicToMapWorld(point);
      const viaLngLat = toWorldViaLngLat(point);
      expect(direct[0]).toBeCloseTo(viaLngLat[0]!, 12);
      expect(direct[1]).toBeCloseTo(viaLngLat[1]!, 12);
    }
  });

  it('puts the origin at the centre of the world', () => {
    const [x, y] = geographicToMapWorld([0, 0]);
    expect(x).toBeCloseTo(0.5, 12);
    expect(y).toBeCloseTo(0.5, 12);
  });

  it('spans the full width at the equator and less at the poles', () => {
    expect(geographicToMapWorld([180, 0])[0]).toBeCloseTo(1, 12);
    expect(geographicToMapWorld([-180, 0])[0]).toBeCloseTo(0, 12);
    // Equal Earth narrows towards the poles.
    expect(geographicToMapWorld([180, 75])[0]).toBeLessThan(1);
    expect(geographicToMapWorld([180, 75])[0]).toBeGreaterThan(0.5);
  });

  it('extrapolates past the antimeridian rather than clamping', () => {
    // Tile buffers legitimately carry geometry past ±180°; clamping would distort it.
    const inside = geographicToMapWorld([170, 0])[0];
    const outside = geographicToMapWorld([190, 0])[0];
    expect(outside).toBeGreaterThan(1);
    expect(outside - 1).toBeCloseTo(1 - inside, 12);
  });
});

describe('toleranceForZoom', () => {
  it('halves with each zoom level', () => {
    expect(toleranceForZoom(1)).toBeCloseTo(toleranceForZoom(0) / 2, 15);
    expect(toleranceForZoom(5)).toBeCloseTo(toleranceForZoom(4) / 2, 15);
  });

  it('expresses one tile unit at zoom 0 as 1/4096 of the world', () => {
    expect(toleranceForZoom(0, 1)).toBeCloseTo(1 / TILE_EXTENT, 15);
  });
});

describe('densifyAndWarp', () => {
  const tolerance = toleranceForZoom(2, 1);

  it('returns an empty array for empty input', () => {
    expect(densifyAndWarp([], { tolerance })).toEqual([]);
  });

  it('preserves the endpoints exactly', () => {
    const line: LngLatTuple[] = [
      [-140, 60],
      [140, 60],
    ];
    const result = densifyAndWarp(line, { tolerance });

    expect(result[0]).toEqual(geographicToMapWorld(line[0]!));
    expect(result[result.length - 1]).toEqual(geographicToMapWorld(line[1]!));
  });

  it('adds vertices along a meridian, which Equal Earth bends', () => {
    const meridian: LngLatTuple[] = [
      [150, -80],
      [150, 80],
    ];
    expect(densifyAndWarp(meridian, { tolerance }).length).toBeGreaterThan(10);
  });

  it('spends no vertices on a parallel, which stays straight', () => {
    // Equal Earth is pseudocylindrical: northing depends on latitude alone and easting is
    // linear in longitude, so any line of constant latitude is already straight.
    for (const lat of [0, 30, 60, 85]) {
      const parallel: LngLatTuple[] = [
        [-180, lat],
        [180, lat],
      ];
      expect(densifyAndWarp(parallel, { tolerance })).toHaveLength(2);
    }
  });

  it('spends no vertices on the prime meridian, where easting is identically zero', () => {
    const primeMeridian: LngLatTuple[] = [
      [0, -85],
      [0, 85],
    ];
    expect(densifyAndWarp(primeMeridian, { tolerance })).toHaveLength(2);
  });

  it('spends more vertices on meridians further from the prime meridian', () => {
    const near = densifyAndWarp(
      [
        [10, -70],
        [10, 70],
      ],
      { tolerance },
    );
    const far = densifyAndWarp(
      [
        [170, -70],
        [170, 70],
      ],
      { tolerance },
    );
    expect(far.length).toBeGreaterThan(near.length);
  });

  it('keeps the approximation within tolerance of the true curve', () => {
    const line: LngLatTuple[] = [
      [160, -75],
      [160, 75],
    ];
    const result = densifyAndWarp(line, { tolerance, maxDepth: 14 });

    // Sample the true curve densely and check each sample is near some output segment.
    let worstDeviation = 0;
    for (let i = 0; i <= 400; i++) {
      const lat = -75 + (150 * i) / 400;
      const truth = geographicToMapWorld([160, lat]);
      let best = Infinity;
      for (let s = 1; s < result.length; s++) {
        best = Math.min(best, distanceToSegment(truth, result[s - 1]!, result[s]!));
      }
      worstDeviation = Math.max(worstDeviation, best);
    }
    expect(worstDeviation).toBeLessThanOrEqual(tolerance);
  });

  it('respects maxDepth', () => {
    const line: LngLatTuple[] = [
      [-180, 85],
      [180, 85],
    ];
    // One input segment, depth 3 ⇒ at most 2^3 output segments ⇒ 9 points.
    const result = densifyAndWarp(line, { tolerance: 1e-12, maxDepth: 3 });
    expect(result.length).toBeLessThanOrEqual(9);
  });

  describe('seam safety', () => {
    it('subdivides a shared edge identically regardless of direction', () => {
      const forward = densifyAndWarp(
        [
          [-30, 55],
          [30, 70],
        ],
        { tolerance },
      );
      const backward = densifyAndWarp(
        [
          [30, 70],
          [-30, 55],
        ],
        { tolerance },
      );

      expect(backward).toHaveLength(forward.length);
      const reversed = [...backward].reverse();
      for (let i = 0; i < forward.length; i++) {
        expect(reversed[i]![0]).toBeCloseTo(forward[i]![0], 15);
        expect(reversed[i]![1]).toBeCloseTo(forward[i]![1], 15);
      }
    });

    it('produces identical output for the same edge in different calls', () => {
      const edge: LngLatTuple[] = [
        [12, 40],
        [18, 62],
      ];
      expect(densifyAndWarp(edge, { tolerance })).toEqual(densifyAndWarp(edge, { tolerance }));
    });

    it('does not depend on surrounding vertices', () => {
      // The same edge embedded in two different polylines must subdivide the same way,
      // or two tiles clipping the same feature differently would disagree on the seam.
      const shared: LngLatTuple[] = [
        [12, 40],
        [18, 62],
      ];
      const alone = densifyAndWarp(shared, { tolerance });
      const embedded = densifyAndWarp([[-40, 10], ...shared, [25, 70]], { tolerance });

      const sharedStart = geographicToMapWorld(shared[0]!);
      const offset = embedded.findIndex(
        (p) => Math.abs(p[0] - sharedStart[0]) < 1e-15 && Math.abs(p[1] - sharedStart[1]) < 1e-15,
      );
      expect(offset).toBeGreaterThanOrEqual(0);

      for (let i = 0; i < alone.length; i++) {
        expect(embedded[offset + i]![0]).toBeCloseTo(alone[i]![0], 15);
        expect(embedded[offset + i]![1]).toBeCloseTo(alone[i]![1], 15);
      }
    });
  });
});

describe('warpOnly', () => {
  it('warps without adding vertices', () => {
    const points: LngLatTuple[] = [
      [0, 0],
      [10, 10],
      [20, 20],
    ];
    expect(warpOnly(points)).toHaveLength(3);
  });
});

function distanceToSegment(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
