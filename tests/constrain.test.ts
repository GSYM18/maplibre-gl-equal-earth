import { describe, expect, it, vi } from 'vitest';

import {
  createEqualEarthConstrain,
  installEqualEarthConstrain,
  type TransformConstrainFn,
} from '../src/map/constrain.js';
import { MAP_SPACE_MAX_LATITUDE, mapSpaceMaxLatitude } from '../src/math/backproject.js';
import type { Band } from '../src/map/bands.js';

const lngLatFactory = (lng: number, lat: number) => ({ lng, lat });

/** The `equal` projection's bands (spec §3). */
const EQUAL: Band[] = [
  { minZoom: 0, blend: 0 },
  { minZoom: 5, blend: 1 / 3 },
  { minZoom: 6, blend: 2 / 3 },
  { minZoom: 7, blend: 1 },
];

describe('createEqualEarthConstrain', () => {
  it('clamps latitude to the Equal Earth world edge', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory });

    expect(constrain({ lng: 10, lat: 80 }, 3).center.lat).toBeCloseTo(MAP_SPACE_MAX_LATITUDE, 9);
    expect(constrain({ lng: 10, lat: -80 }, 3).center.lat).toBeCloseTo(-MAP_SPACE_MAX_LATITUDE, 9);
  });

  it('places the world edge at the map-space image of the pole (~65.54°)', () => {
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

  it("hands Mercator and globe to MapLibre's own constraint while inactive", () => {
    // Our override replaces MapLibre's `defaultConstrain` (v6 9051-9054), so "inactive" must
    // mean "delegate", not "pass through": min/max zoom and `maxBounds` live in the default.
    const clamped = { lng: 0, lat: 80 };
    const fallback = vi.fn(() => ({ center: clamped, zoom: 3 }));
    const constrain = createEqualEarthConstrain({
      lngLatFactory,
      isActive: () => false,
      fallback,
    });
    const input = { lng: 0, lat: 84 };
    const result = constrain(input, 2);

    expect(fallback).toHaveBeenCalledWith(input, 2);
    expect(result).toEqual({ center: clamped, zoom: 3 });
    expect(result.center).toBe(clamped);
  });

  it('passes the camera through while inactive when there is nothing to delegate to', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory, isActive: () => false });
    const input = { lng: 0, lat: 84 };
    expect(constrain(input, 2).center).toBe(input);
  });

  it('composes with the default constraint instead of replacing it (I2)', () => {
    const fallback = vi.fn((ll: { lng: number; lat: number }, zoom: number) => ({
      center: { lng: ll.lng, lat: Math.min(ll.lat, 80) },
      zoom: Math.min(zoom, 7),
    }));
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL, fallback });
    // Mercator band: pure delegation (zoom clamped by the fallback's maxZoom).
    expect(constrain({ lng: 10, lat: 84 }, 9)).toEqual({ center: { lng: 10, lat: 80 }, zoom: 7 });
    // Equal Earth band: fallback first, then our tighter latitude clamp; the fallback's zoom survives.
    const result = constrain({ lng: 10, lat: 84 }, 3);
    expect(result.center.lat).toBeCloseTo(mapSpaceMaxLatitude(0), 9);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('delegates to the fallback while inactive', () => {
    const fallback = vi.fn((ll: { lng: number; lat: number }) => ({ center: ll, zoom: 5 }));
    const constrain = createEqualEarthConstrain({ lngLatFactory, fallback, isActive: () => false });
    expect(constrain({ lng: 0, lat: 89 }, 2)).toEqual({ center: { lng: 0, lat: 89 }, zoom: 5 });
  });

  it("picks the band from the fallback's zoom, which is what will be rendered", () => {
    // maxZoom 6.5 pulls a z9 request back into the ⅔ band, whose edge then applies.
    const fallback = (ll: { lng: number; lat: number }, zoom: number) => ({ center: ll, zoom: Math.min(zoom, 6.5) });
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL, fallback });
    expect(constrain({ lng: 0, lat: 84 }, 9).center.lat).toBeCloseTo(mapSpaceMaxLatitude(2 / 3), 9);
  });

  it("never clamps tighter than the baseline band's edge (I3)", () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL, baselineBand: () => 1 });
    const limit1 = mapSpaceMaxLatitude(1 / 3);
    expect(constrain({ lng: 0, lat: limit1 - 0.01 }, 4.9).center.lat).toBeCloseTo(limit1 - 0.01, 9);
    expect(constrain({ lng: 0, lat: limit1 + 1 }, 4.9).center.lat).toBeCloseTo(limit1, 9);
  });

  it('takes the limit band from currentBand when given, not from the zoom (C1)', () => {
    // z4.9 falls in band 0, but a holding switcher still draws band 1, whose world is wider.
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL, currentBand: () => 1 });
    const limit1 = mapSpaceMaxLatitude(1 / 3);
    expect(limit1).toBeGreaterThan(MAP_SPACE_MAX_LATITUDE);
    expect(constrain({ lng: 0, lat: limit1 - 0.01 }, 4.9).center.lat).toBeCloseTo(limit1 - 0.01, 9);
    expect(constrain({ lng: 0, lat: 89 }, 4.9).center.lat).toBeCloseTo(limit1, 9);
  });

  it('does not clamp at all while the baseline band is Mercator', () => {
    // The requested state is then in geographic space: any Equal Earth edge would distort it.
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL, baselineBand: () => 3 });
    const input = { lng: 0, lat: 84 };
    expect(constrain(input, 6.5).center).toBe(input);
  });

  it('adds the margin per band, and clamps at negative zoom and a non-zero first-band minZoom (row 16)', () => {
    const bands = [
      { minZoom: 2, blend: 0 },
      { minZoom: 5, blend: 1 },
    ];
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands, latitudeMargin: 1 });
    expect(constrain({ lng: 0, lat: 89 }, -1).center.lat).toBeCloseTo(mapSpaceMaxLatitude(0) + 1, 9);
    expect(constrain({ lng: 0, lat: 89 }, 1).center.lat).toBeCloseTo(mapSpaceMaxLatitude(0) + 1, 9);
    expect(constrain({ lng: 0, lat: 89 }, 5).center.lat).toBe(89);
    const margined = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL, latitudeMargin: 1 });
    expect(margined({ lng: 0, lat: 89 }, 5.5).center.lat).toBeCloseTo(mapSpaceMaxLatitude(1 / 3) + 1, 9);
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

  it('installs a fallback that reads host.transform lazily', () => {
    let calls = 0;
    const host = {
      transform: {
        defaultConstrain: (ll: { lng: number; lat: number }, zoom: number) => {
          calls++;
          return { center: ll, zoom };
        },
      },
      constrain: null as TransformConstrainFn | null,
      setTransformConstrain(fn: TransformConstrainFn | null) {
        this.constrain = fn;
      },
    };
    installEqualEarthConstrain(host, { lngLatFactory });
    host.constrain!({ lng: 0, lat: 0 }, 3);
    // `migrateProjection` swaps the transform wholesale.
    host.transform = {
      defaultConstrain: (ll, zoom) => {
        calls += 10;
        return { center: ll, zoom };
      },
    };
    host.constrain!({ lng: 0, lat: 0 }, 3);
    expect(calls).toBe(11);
  });

  it("reads a v6 map's default constraint off its camera, lazily", () => {
    // A v6 `Map` has no `transform`; `setTransformConstrain` writes to `_camera.transform`
    // (v6 24448), and `migrateProjection` replaces that object (v6 22077-22079).
    const seen: string[] = [];
    const transform = (name: string) => ({
      defaultConstrain: (ll: { lng: number; lat: number }, zoom: number) => {
        seen.push(name);
        return { center: ll, zoom: Math.min(zoom, 2) };
      },
    });
    const host = {
      _camera: { transform: transform('mercator') },
      constrain: null as TransformConstrainFn | null,
      setTransformConstrain(fn: TransformConstrainFn | null) {
        this.constrain = fn;
      },
    };
    installEqualEarthConstrain(host, { lngLatFactory });
    expect(host.constrain!({ lng: 0, lat: 0 }, 9).zoom).toBe(2);
    host._camera.transform = transform('globe');
    host.constrain!({ lng: 0, lat: 0 }, 9);
    expect(seen).toEqual(['mercator', 'globe']);
  });

  it('prefers an explicit fallback over the map default', () => {
    const map = new FakeMap();
    const fallback = vi.fn((ll: { lng: number; lat: number }, zoom: number) => ({ center: ll, zoom }));
    installEqualEarthConstrain(map, { lngLatFactory, fallback });
    map.constrain!({ lng: 0, lat: 0 }, 3);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("warns once per install when no default constraint is reachable (C2)", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = new FakeMap(); // neither `transform` nor `_camera`
    installEqualEarthConstrain(map, { lngLatFactory });
    map.constrain!({ lng: 0, lat: 0 }, 3);
    map.constrain!({ lng: 0, lat: 0 }, 4);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(/defaultConstrain/);
    // A second map is judged on its own.
    const other = new FakeMap();
    installEqualEarthConstrain(other, { lngLatFactory });
    other.constrain!({ lng: 0, lat: 0 }, 3);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('rejects a map without setTransformConstrain (maplibre-gl < 5.24)', () => {
    expect(() => installEqualEarthConstrain({} as never, { lngLatFactory })).toThrow(TypeError);
  });
});

describe('createEqualEarthConstrain with bands', () => {
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
