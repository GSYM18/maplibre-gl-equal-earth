import { describe, expect, it } from 'vitest';

import {
  clipLineToWorld,
  clipPointsToWorld,
  clipPolygonToWorld,
} from '../src/math/antimeridian.js';

type Ring = GeoJSON.Position[];

describe('clipPointsToWorld', () => {
  it('drops positions beyond ±180, keeps exactly ±180 and in-range ones', () => {
    const points = [
      [-2.58, 54.72],
      [357.42, 54.72],
      [-362.58, 54.72],
      [180, 0],
      [-180, 1],
      [-180.0001, 2],
    ];
    expect(clipPointsToWorld(points)).toEqual([
      [-2.58, 54.72],
      [180, 0],
      [-180, 1],
    ]);
  });

  it('returns the same array when everything is in range', () => {
    const points = [
      [0, 0],
      [10, 10],
    ];
    expect(clipPointsToWorld(points)).toBe(points);
  });

  it('returns an empty array when nothing survives', () => {
    expect(
      clipPointsToWorld([
        [200, 0],
        [-300, 0],
      ]),
    ).toEqual([]);
  });
});

describe('clipLineToWorld', () => {
  it('cuts a line crossing +180 with the interpolated latitude', () => {
    const parts = clipLineToWorld([
      [170, 0],
      [190, 20],
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0]![0]).toEqual([170, 0]);
    expect(parts[0]![1]![0]).toBeCloseTo(180, 12);
    expect(parts[0]![1]![1]).toBeCloseTo(10, 12);
  });

  it('cuts a line crossing -180', () => {
    const parts = clipLineToWorld([
      [-190, 0],
      [-170, 20],
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0]![0]![0]).toBeCloseTo(-180, 12);
    expect(parts[0]![0]![1]).toBeCloseTo(10, 12);
    expect(parts[0]![1]).toEqual([-170, 20]);
  });

  it('yields two parts for a line that leaves and re-enters', () => {
    const parts = clipLineToWorld([
      [170, 0],
      [190, 0],
      [190, 10],
      [170, 10],
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.at(-1)![0]).toBeCloseTo(180, 12);
    expect(parts[1]![0]![0]).toBeCloseTo(180, 12);
    expect(parts[1]!.at(-1)).toEqual([170, 10]);
  });

  it('yields nothing for a line wholly outside', () => {
    expect(
      clipLineToWorld([
        [185, 0],
        [200, 5],
      ]),
    ).toEqual([]);
  });

  it('drops parts that degenerate to a single position', () => {
    // Touches the band only at the single point (180, 5).
    expect(
      clipLineToWorld([
        [190, 0],
        [180, 5],
        [190, 10],
      ]),
    ).toEqual([]);
  });

  it('returns a wholly in-range line unchanged', () => {
    const line = [
      [0, 0],
      [10, 10],
    ];
    expect(clipLineToWorld(line)).toEqual([line]);
  });
});

describe('clipPolygonToWorld', () => {
  const shell: Ring = [
    [170, -10],
    [190, -10],
    [190, 10],
    [170, 10],
    [170, -10],
  ];

  it('clips an overhanging polygon at 180 and keeps the ring closed', () => {
    const rings = clipPolygonToWorld([shell])!;
    expect(rings).toHaveLength(1);
    const ring = rings[0]!;
    expect(ring[0]).toEqual(ring.at(-1));
    for (const p of ring) expect(p[0]!).toBeLessThanOrEqual(180);
    const onEdge = ring.filter((p) => p[0] === 180);
    expect(onEdge.map((p) => p[1]).sort((a, b) => a! - b!)).toEqual([-10, 10]);
  });

  it('interpolates latitude at the cut', () => {
    const triangle: Ring = [
      [170, 0],
      [190, 0],
      [190, 20],
      [170, 0],
    ];
    const ring = clipPolygonToWorld([triangle])![0]!;
    const cut = ring.filter((p) => p[0] === 180).map((p) => p[1]!);
    expect(cut.some((lat) => Math.abs(lat - 0) < 1e-9)).toBe(true);
    expect(cut.some((lat) => Math.abs(lat - 10) < 1e-9)).toBe(true);
  });

  it('clips at -180 too', () => {
    const ring = clipPolygonToWorld([
      [
        [-190, -10],
        [-170, -10],
        [-170, 10],
        [-190, 10],
        [-190, -10],
      ],
    ])![0]!;
    for (const p of ring) expect(p[0]!).toBeGreaterThanOrEqual(-180);
    expect(ring[0]).toEqual(ring.at(-1));
  });

  it('returns a wholly inside polygon unchanged', () => {
    const polygon = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0],
      ],
    ];
    expect(clipPolygonToWorld(polygon)).toEqual(polygon);
  });

  it('yields nothing for a polygon wholly outside', () => {
    expect(
      clipPolygonToWorld([
        [
          [200, 0],
          [210, 0],
          [210, 10],
          [200, 0],
        ],
      ]),
    ).toBeNull();
  });

  it('drops a hole wholly outside while the shell remains', () => {
    const hole: Ring = [
      [185, -2],
      [188, -2],
      [188, 2],
      [185, 2],
      [185, -2],
    ];
    const rings = clipPolygonToWorld([shell, hole])!;
    expect(rings).toHaveLength(1);
  });

  it('drops the whole polygon when the shell is dropped', () => {
    const hole: Ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    expect(
      clipPolygonToWorld([
        [
          [200, 0],
          [210, 0],
          [210, 10],
          [200, 0],
        ],
        hole,
      ]),
    ).toBeNull();
  });
});
