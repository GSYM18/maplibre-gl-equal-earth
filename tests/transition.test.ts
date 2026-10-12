import { describe, expect, it } from 'vitest';

import {
  EQUAL_EARTH_BANDS,
  bandIndexForZoom,
  bandIndexWithHysteresis,
  bandSourceId,
  continuousBlend,
  originalLayerId,
  parseRange,
  resolveTransition,
} from '../src/map/bands.js';

describe('resolveTransition', () => {
  it('defaults to six steps over z4–z8 (spec §3)', () => {
    const t = resolveTransition();
    expect(t).toMatchObject({ from: 4, to: 8, steps: 6, spacing: 0.8 });
    expect(t.bands.map((b) => b.minZoom)).toEqual([-Infinity, 4, 4.8, 5.6, 6.4, 7.2, 8]);
    expect(t.bands.map((b) => b.blend)).toEqual([0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1]);
  });

  it("reproduces the spike's three-step layout for { from: 5, to: 7, steps: 3 }", () => {
    const t = resolveTransition({ from: 5, to: 7, steps: 3 });
    expect(t.bands).toEqual([
      { minZoom: -Infinity, blend: 0 },
      { minZoom: 5, blend: 1 / 3 },
      { minZoom: 6, blend: 2 / 3 },
      { minZoom: 7, blend: 1 },
    ]);
  });

  it('rejects fewer than two steps, fractional steps, and a reversed range', () => {
    expect(() => resolveTransition({ steps: 1 })).toThrow(TypeError);
    expect(() => resolveTransition({ steps: 2.5 })).toThrow(TypeError);
    expect(() => resolveTransition({ from: 8, to: 4 })).toThrow(TypeError);
    expect(() => resolveTransition({ from: Number.NaN })).toThrow(TypeError);
  });
});

describe('continuousBlend', () => {
  const t = resolveTransition();

  it("equals each band's blend at the band's midpoint", () => {
    for (let k = 1; k < t.steps; k++) {
      const mid = t.bands[k]!.minZoom + t.spacing / 2;
      expect(continuousBlend(t, mid)).toBeCloseTo(t.bands[k]!.blend, 12);
    }
  });

  it('is 0 up to half a spacing below `from` and 1 from half a spacing above `to`', () => {
    // `4 - 0.4` is not exactly representable, so the boundary value carries ~1e-17 of noise.
    expect(continuousBlend(t, 4 - 0.4)).toBeCloseTo(0, 12);
    expect(continuousBlend(t, 2)).toBe(0);
    expect(continuousBlend(t, 8 + 0.4)).toBe(1);
    expect(continuousBlend(t, 12)).toBe(1);
  });

  it('is continuous and monotonic across every boundary', () => {
    let previous = 0;
    for (let z = 3; z <= 9; z += 0.01) {
      const value = continuousBlend(t, z);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(value - previous).toBeLessThan(0.01 / (t.spacing * t.steps) + 1e-9);
      previous = value;
    }
  });
});

describe('parseRange', () => {
  const t = resolveTransition();

  it('widens each band by one spacing on both sides', () => {
    expect(parseRange(t, 0)).toEqual([-Infinity, 4 + 0.8]);
    expect(parseRange(t, 1)).toEqual([4 - 0.8, 4.8 + 0.8]);
    expect(parseRange(t, 6)).toEqual([8 - 0.8, Infinity]);
  });
});

describe('bandIndexWithHysteresis', () => {
  const { bands } = resolveTransition();

  it('switches up exactly at the boundary', () => {
    expect(bandIndexWithHysteresis(bands, 4.8, 1, 0.1)).toBe(2);
  });

  it('switches down only once the zoom is a full hysteresis below the boundary', () => {
    expect(bandIndexWithHysteresis(bands, 4.75, 2, 0.1)).toBe(2);
    expect(bandIndexWithHysteresis(bands, 4.69, 2, 0.1)).toBe(1);
  });

  it('is plain bandIndexForZoom when the zoom is more than one band away', () => {
    expect(bandIndexWithHysteresis(bands, 2, 4, 0.1)).toBe(bandIndexForZoom(bands, 2));
    expect(bandIndexWithHysteresis(bands, 9, 1, 0.1)).toBe(6);
  });
});

describe('originalLayerId', () => {
  it('names the application layer a band copy draws, and leaves other ids alone', () => {
    expect(originalLayerId('water__b0')).toBe('water');
    expect(originalLayerId('label_city__b12')).toBe('label_city');
    expect(originalLayerId('water')).toBe('water');
    expect(originalLayerId('a__b0__b3')).toBe('a__b0');
    expect(originalLayerId('water__b')).toBe('water__b');
    expect(originalLayerId('water__bx')).toBe('water__bx');
  });
});

describe('bandSourceId', () => {
  const { bands } = resolveTransition();

  it('keeps the original id for the Mercator band and suffixes the others', () => {
    expect(bandSourceId('openmaptiles', bands, 6)).toBe('openmaptiles');
    expect(bandSourceId('openmaptiles', bands, 0)).toBe('openmaptiles__b0');
    expect(bandSourceId('openmaptiles', bands, 3)).toBe('openmaptiles__b3');
  });

  it('EQUAL_EARTH_BANDS is one band at blend 0 from -Infinity', () => {
    expect(EQUAL_EARTH_BANDS).toEqual([{ minZoom: -Infinity, blend: 0 }]);
  });
});
