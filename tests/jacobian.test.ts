import { describe, expect, it } from 'vitest';

import { geographicToMapWorld } from '../src/math/backproject.js';
import { relativeJacobian, similarity, similarityOffsets } from '../src/math/jacobian.js';

const ZURICH: [number, number] = [8.54, 47.37];
const SAN_FRANCISCO: [number, number] = [-122.42, 37.77];
const ANCHORAGE: [number, number] = [-149.9, 61.22];

describe('relativeJacobian', () => {
  it('is the identity at blend 1 (Mercator relative to itself)', () => {
    const [a, b, c, d] = relativeJacobian(ZURICH, 1);
    expect(a).toBeCloseTo(1, 9);
    expect(b).toBeCloseTo(0, 9);
    expect(c).toBeCloseTo(0, 9);
    expect(d).toBeCloseTo(1, 9);
  });

  it('is linear in the blend: M_t = (1 − t)·M_0 + t·I', () => {
    const m0 = relativeJacobian(SAN_FRANCISCO, 0);
    const mHalf = relativeJacobian(SAN_FRANCISCO, 0.5);
    const identity = [1, 0, 0, 1];
    for (let i = 0; i < 4; i++) {
      expect(mHalf[i]).toBeCloseTo(0.5 * m0[i]! + 0.5 * identity[i]!, 6);
    }
  });

  it('predicts the warp of a small displacement to first order', () => {
    const [a, b, c, d] = relativeJacobian(ZURICH, 0);
    // Mercator world units per degree at Zürich, for lng and lat.
    const [x0, y0] = geographicToMapWorld(ZURICH, 1);
    const [x1, y1] = geographicToMapWorld([ZURICH[0] + 0.01, ZURICH[1]], 1);
    const [x2, y2] = geographicToMapWorld([ZURICH[0], ZURICH[1] + 0.01], 1);
    const dMerc = [x1 - x0, y1 - y0, x2 - x0, y2 - y0]; // columns of J_1 · 0.01
    // Equal Earth world displacement for the same steps:
    const [ex0, ey0] = geographicToMapWorld(ZURICH, 0);
    const [ex1, ey1] = geographicToMapWorld([ZURICH[0] + 0.01, ZURICH[1]], 0);
    // M · (Mercator displacement) ≈ Equal Earth displacement for the lng step.
    expect(a * dMerc[0]! + b * dMerc[1]!).toBeCloseTo(ex1 - ex0, 7);
    expect(c * dMerc[0]! + d * dMerc[1]!).toBeCloseTo(ey1 - ey0, 7);
    void [ex0, ey0, ey1, x2, y2];
  });
});

describe('similarity', () => {
  it('reads rotation and scale off a pure similarity', () => {
    const s = 1.5, theta = 0.3;
    const m: [number, number, number, number] = [s * Math.cos(theta), -s * Math.sin(theta), s * Math.sin(theta), s * Math.cos(theta)];
    const result = similarity(m);
    expect(result.rotation).toBeCloseTo(theta, 12);
    expect(result.scale).toBeCloseTo(s, 12);
  });

  it("matches the spike's whole-transition figures (spec §4.2 table)", () => {
    const zurich = similarity(relativeJacobian(ZURICH, 0));
    const sf = similarity(relativeJacobian(SAN_FRANCISCO, 0));
    const anchorage = similarity(relativeJacobian(ANCHORAGE, 0));
    // Scale of Equal Earth relative to Mercator at the centre: 1/1.27, 1/1.09, 1/1.82.
    expect(Math.log2(1 / zurich.scale)).toBeCloseTo(0.35, 1);
    expect(Math.log2(1 / sf.scale)).toBeCloseTo(0.12, 1);
    expect(Math.log2(1 / anchorage.scale)).toBeCloseTo(0.86, 1);
    // Rotation ≈ 0 near the central meridian, ~16° at San Francisco, ~30° at Anchorage.
    expect(Math.abs((zurich.rotation * 180) / Math.PI)).toBeLessThan(2);
    expect(Math.abs((sf.rotation * 180) / Math.PI)).toBeGreaterThan(12);
    expect(Math.abs((anchorage.rotation * 180) / Math.PI)).toBeGreaterThan(25);
  });
});

describe('similarityOffsets', () => {
  it('is zero when disabled, when the blends agree, and for a non-finite point', () => {
    expect(similarityOffsets(ZURICH, 0, 0.5, 'none')).toEqual({ deltaZoom: 0, deltaBearing: 0 });
    expect(similarityOffsets(ZURICH, 0.5, 0.5, 'zoom+bearing')).toEqual({ deltaZoom: 0, deltaBearing: 0 });
    expect(similarityOffsets([Number.NaN, 0], 0, 1, 'zoom+bearing')).toEqual({ deltaZoom: 0, deltaBearing: 0 });
  });

  it('absorbs the whole scale change between Equal Earth and Mercator at Zürich', () => {
    const { deltaZoom, deltaBearing } = similarityOffsets(ZURICH, 0, 1, 'zoom+bearing');
    expect(deltaZoom).toBeCloseTo(0.35, 1);
    expect(Math.abs(deltaBearing)).toBeLessThan(2);
  });

  it('leaves the bearing alone in zoom-only mode', () => {
    const { deltaZoom, deltaBearing } = similarityOffsets(SAN_FRANCISCO, 0, 1, 'zoom');
    expect(deltaZoom).not.toBe(0);
    expect(deltaBearing).toBe(0);
  });

  it('is antisymmetric: going back cancels going forward', () => {
    const forward = similarityOffsets(SAN_FRANCISCO, 1 / 6, 3 / 6, 'zoom+bearing');
    const back = similarityOffsets(SAN_FRANCISCO, 3 / 6, 1 / 6, 'zoom+bearing');
    expect(forward.deltaZoom + back.deltaZoom).toBeCloseTo(0, 9);
    expect(forward.deltaBearing + back.deltaBearing).toBeCloseTo(0, 9);
  });
});
