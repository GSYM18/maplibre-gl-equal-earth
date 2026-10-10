import { describe, expect, it, vi } from 'vitest';

import {
  createEqualEarthConstrain,
  installEqualEarthConstrain,
  type TransformConstrainFn,
} from '../src/map/constrain.js';
import { MAP_SPACE_MAX_LATITUDE, mapSpaceMaxLatitude } from '../src/math/backproject.js';
import type { Band } from '../src/map/bands.js';

const lngLatFactory = (lng: number, lat: number) => ({ lng, lat });

describe('createEqualEarthConstrain', () => {
  it('clamps latitude to the Equal Earth world edge', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory });

    expect(constrain({ lng: 10, lat: 80 }, 3).center.lat).toBeCloseTo(MAP_SPACE_MAX_LATITUDE, 9);
    expect(constrain({ lng: 10, lat: -80 }, 3).center.lat).toBeCloseTo(-MAP_SPACE_MAX_LATITUDE, 9);
  });

  it('places the world edge at the map-space image of the pole (~65.46°)', () => {
    // Sanity-check the constant itself: the geographic pole must land well inside
    // Mercator's own ±85.05° limit, or the warp would be clipped.
    expect(MAP_SPACE_MAX_LATITUDE).toBeGreaterThan(65);
    expect(MAP_SPACE_MAX_LATITUDE).toBeLessThan(66);
  });

  it('passes through a centre already inside the world', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory });
    const input = { lng: 8.5, lat: 47.4 };
    const result = constrain(input, 4);

    // Returned by reference when untouched — no allocation, and no risk of dropping
    // a real LngLat's prototype.
    expect(result.center).toBe(input);
    expect(result.zoom).toBe(4);
  });

  it('never clamps longitude', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory });
    for (const lng of [-180, -90, 0, 90, 180]) {
      expect(constrain({ lng, lat: 80 }, 2).center.lng).toBe(lng);
    }
  });

  it('honours a latitude margin', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory, latitudeMargin: 5 });
    expect(constrain({ lng: 0, lat: 80 }, 2).center.lat).toBeCloseTo(
      MAP_SPACE_MAX_LATITUDE + 5,
      9,
    );
  });

  it('is inert while inactive, so Mercator and globe are untouched', () => {
    const constrain = createEqualEarthConstrain({
      lngLatFactory,
      isActive: () => false,
    });
    const input = { lng: 0, lat: 84 };
    const result = constrain(input, 2);

    expect(result.center).toBe(input);
    expect(result.center.lat).toBe(84);
  });

  it('re-evaluates isActive on every call rather than latching', () => {
    let active = false;
    const constrain = createEqualEarthConstrain({ lngLatFactory, isActive: () => active });

    expect(constrain({ lng: 0, lat: 80 }, 2).center.lat).toBe(80);
    active = true;
    expect(constrain({ lng: 0, lat: 80 }, 2).center.lat).toBeCloseTo(MAP_SPACE_MAX_LATITUDE, 9);
  });

  it('passes zoom through unchanged', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory });
    for (const zoom of [0, 1.5, 6, 22]) {
      expect(constrain({ lng: 0, lat: 80 }, zoom).zoom).toBe(zoom);
    }
  });

  it('uses the supplied factory when it does clamp', () => {
    class LngLat {
      constructor(
        public lng: number,
        public lat: number,
      ) {}
    }
    const constrain = createEqualEarthConstrain({
      lngLatFactory: (lng, lat) => new LngLat(lng, lat),
    });
    expect(constrain({ lng: 0, lat: 80 }, 2).center).toBeInstanceOf(LngLat);
  });
});

describe('installEqualEarthConstrain', () => {
  class FakeMap {
    constrain: TransformConstrainFn | null | undefined = undefined;
    setTransformConstrain(fn?: TransformConstrainFn | null) {
      this.constrain = fn ?? null;
      return this;
    }
  }

  it('installs and tears down', () => {
    const map = new FakeMap();
    const spy = vi.spyOn(map, 'setTransformConstrain');

    const uninstall = installEqualEarthConstrain(map, { lngLatFactory });
    expect(typeof map.constrain).toBe('function');

    uninstall();
    // null reverts to the transform's default constrain, not "no constrain".
    expect(spy).toHaveBeenLastCalledWith(null);
    expect(map.constrain).toBeNull();
  });

  it('is idempotent', () => {
    const map = new FakeMap();
    const uninstall = installEqualEarthConstrain(map, { lngLatFactory });
    const spy = vi.spyOn(map, 'setTransformConstrain');

    uninstall();
    uninstall();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects a map without setTransformConstrain (maplibre-gl < 6)', () => {
    expect(() => installEqualEarthConstrain({} as never, { lngLatFactory })).toThrow(TypeError);
  });
});

describe('createEqualEarthConstrain with bands', () => {
  const EQUAL: Band[] = [
    { minZoom: 0, blend: 0 },
    { minZoom: 5, blend: 1 / 3 },
    { minZoom: 6, blend: 2 / 3 },
    { minZoom: 7, blend: 1 },
  ];

  it('uses the world edge of the band the requested zoom falls in', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL });

    expect(constrain({ lng: 0, lat: 80 }, 4).center.lat).toBeCloseTo(MAP_SPACE_MAX_LATITUDE, 9);
    expect(constrain({ lng: 0, lat: 80 }, 5.5).center.lat).toBeCloseTo(mapSpaceMaxLatitude(1 / 3), 9);
    // 80° is inside the ⅔ band's edge (≈81.5°), so it passes through untouched.
    const inside = { lng: 0, lat: 80 };
    expect(constrain(inside, 6.5).center).toBe(inside);
  });

  it('leaves the Mercator band unconstrained, starting exactly at its minZoom', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL });
    const input = { lng: 0, lat: 84 };

    expect(constrain(input, 7).center).toBe(input);
    expect(constrain(input, 12).center).toBe(input);
  });

  it('treats a zoom exactly on a boundary as the upper band, like BandCamera', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL });
    expect(constrain({ lng: 0, lat: 80 }, 5).center.lat).toBeCloseTo(mapSpaceMaxLatitude(1 / 3), 9);
  });

  it('rejects malformed bands when the constraint is built', () => {
    expect(() => createEqualEarthConstrain({ lngLatFactory, bands: [] })).toThrow(TypeError);
  });
});
