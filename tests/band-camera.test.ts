import { describe, expect, it, vi } from 'vitest';

import type { Band } from '../src/map/bands.js';
import {
  BandCamera,
  type CameraUpdate,
  type CameraUpdateFn,
  type CameraUpdateResult,
} from '../src/map/camera.js';
import { geographicToMap, mapSpaceMaxLatitude } from '../src/math/backproject.js';

/** The `equal` projection's bands (spec §3). */
const EQUAL: Band[] = [
  { minZoom: 0, blend: 0 },
  { minZoom: 5, blend: 1 / 3 },
  { minZoom: 6, blend: 2 / 3 },
  { minZoom: 7, blend: 1 },
];
const TOKYO: [number, number] = [139.69, 35.69];

const blendAt = (zoom: number) => (zoom < 5 ? 0 : zoom < 6 ? 1 / 3 : zoom < 7 ? 2 / 3 : 1);

interface Centred {
  center: { lng: number; lat: number };
}

/**
 * v5-shaped host: the hook is a public property. Like MapLibre's handler loop, it feeds the
 * returned centre back in as the next update's baseline.
 */
class FakeV5Map {
  transformCameraUpdate: CameraUpdateFn | null = null;
  center: { lng: number; lat: number };
  zoom: number;

  constructor(center: [number, number], zoom: number) {
    this.center = { lng: center[0], lat: center[1] };
    this.zoom = zoom;
  }

  getZoom(): number {
    return this.zoom;
  }

  step(zoom: number): void {
    this.zoom = zoom;
    const next: CameraUpdate = { center: { ...this.center }, zoom };
    const result: CameraUpdateResult = this.transformCameraUpdate?.(next) ?? {};
    if (result.center) this.center = result.center;
  }
}

/** v6-shaped host: no hook property; a setter writes it to a private `_camera`. */
class FakeV6Map {
  _camera: { transformCameraUpdate: CameraUpdateFn | null } = { transformCameraUpdate: null };
  center: { lng: number; lat: number };
  zoom: number;

  constructor(center: [number, number], zoom: number) {
    this.center = { lng: center[0], lat: center[1] };
    this.zoom = zoom;
  }

  getZoom(): number {
    return this.zoom;
  }

  setTransformCameraUpdate(value: CameraUpdateFn | null): void {
    this._camera.transformCameraUpdate = value;
  }

  step(zoom: number): void {
    this.zoom = zoom;
    const next: CameraUpdate = { center: { ...this.center }, zoom };
    const result: CameraUpdateResult = this._camera.transformCameraUpdate?.(next) ?? {};
    if (result.center) this.center = result.center;
  }
}

/** v6-shaped host whose hook storage cannot be read at all — a future MapLibre, say. */
class OpaqueV6Map {
  #hook: CameraUpdateFn | null = null;
  center = { lng: 0, lat: 0 };
  zoom = 4;

  getZoom(): number {
    return this.zoom;
  }

  setTransformCameraUpdate(value: CameraUpdateFn | null): void {
    this.#hook = value;
  }

  step(zoom: number): void {
    this.zoom = zoom;
    const result: CameraUpdateResult = this.#hook?.({ center: { ...this.center }, zoom }) ?? {};
    if (result.center) this.center = result.center;
  }
}

function expectAt(map: Centred, expected: [number, number], digits = 9): void {
  expect(map.center.lng).toBeCloseTo(expected[0], digits);
  expect(map.center.lat).toBeCloseTo(expected[1], digits);
}

describe('BandCamera', () => {
  it('keeps the centre on the same place through every band of a pinch zoom', () => {
    const map = new FakeV5Map(geographicToMap(TOKYO, 0), 4.2);
    new BandCamera(map, { bands: EQUAL });

    for (const zoom of [4.6, 4.9, 5.1, 5.5, 5.9, 6.2, 6.8, 7.1, 7.9]) {
      map.step(zoom);
      expectAt(map, geographicToMap(TOKYO, blendAt(zoom)));
    }
  });

  it('converts once, directly, when a single update skips several bands', () => {
    const map = new FakeV5Map(geographicToMap(TOKYO, 0), 3);
    new BandCamera(map, { bands: EQUAL });

    map.step(10);

    expectAt(map, TOKYO);
  });

  it('does not drift over many round trips through the bands', () => {
    const map = new FakeV5Map(TOKYO, 9);
    new BandCamera(map, { bands: EQUAL });

    for (let i = 0; i < 20; i++) {
      for (const zoom of [7.5, 6.5, 5.5, 4.5, 5.5, 6.5, 7.5]) map.step(zoom);
    }
    map.step(9);

    expectAt(map, TOKYO);
  });

  it('treats a zoom exactly on a boundary as inside the upper band', () => {
    const map = new FakeV5Map(geographicToMap(TOKYO, 0), 4.5);
    const camera = new BandCamera(map, { bands: EQUAL });

    map.step(5);

    expect(camera.blend).toBe(1 / 3);
    expectAt(map, geographicToMap(TOKYO, 1 / 3));
  });

  it('seeds the current band from the live zoom', () => {
    const map = new FakeV5Map(TOKYO, 6.5);
    expect(new BandCamera(map, { bands: EQUAL }).blend).toBe(2 / 3);
  });

  it('does not convert between adjacent bands that share a blend', () => {
    const map = new FakeV5Map([10, 20], 4);
    new BandCamera(map, {
      bands: [
        { minZoom: 0, blend: 0 },
        { minZoom: 5, blend: 0 },
      ],
    });

    map.step(6);

    expect(map.center).toEqual({ lng: 10, lat: 20 });
  });

  it('clamps a centre beyond the world edge instead of failing', () => {
    // Panned into the empty space above Equal Earth (edge ≈ 65.54° in map space).
    const onConversionFailure = vi.fn();
    const map = new FakeV5Map([0, 80], 4.5);
    new BandCamera(map, { bands: EQUAL, onConversionFailure });

    map.step(5.2);

    expect(onConversionFailure).not.toHaveBeenCalled();
    expect(map.center.lat).toBeCloseTo(mapSpaceMaxLatitude(1 / 3), 6);
  });

  it('wraps a longitude beyond ±180° before converting', () => {
    const map = new FakeV5Map([190, 0], 8);
    new BandCamera(map, { bands: EQUAL });

    map.step(6.5);

    expectAt(map, geographicToMap([-170, 0], 2 / 3));
  });

  it('leaves exactly ±180° alone — on Equal Earth those are opposite map edges', () => {
    const map = new FakeV5Map([180, 0], 8);
    new BandCamera(map, { bands: EQUAL });

    map.step(4);

    expectAt(map, geographicToMap([180, 0], 0));
    expect(map.center.lng).toBeGreaterThan(0);
  });

  it('still reports a genuinely non-finite centre', () => {
    const onConversionFailure = vi.fn();
    const map = new FakeV5Map([Number.NaN, Number.NaN], 4);
    new BandCamera(map, { bands: EQUAL, onConversionFailure });

    map.step(8);

    expect(onConversionFailure).toHaveBeenCalledOnce();
  });

  it('rejects malformed bands', () => {
    const map = new FakeV5Map([0, 0], 0);
    expect(() => new BandCamera(map, { bands: [] })).toThrow(TypeError);
    expect(
      () =>
        new BandCamera(map, {
          bands: [
            { minZoom: 0, blend: 0 },
            { minZoom: 5, blend: 1.5 },
          ],
        }),
    ).toThrow(/blend/);
    expect(
      () =>
        new BandCamera(map, {
          bands: [
            { minZoom: 0, blend: 0 },
            { minZoom: 5, blend: 0.5 },
            { minZoom: 5, blend: 1 },
          ],
        }),
    ).toThrow(/minZoom/);
  });

  describe('on a MapLibre v6-shaped host', () => {
    it('installs through setTransformCameraUpdate and converts', () => {
      const map = new FakeV6Map(geographicToMap(TOKYO, 0), 4.5);
      new BandCamera(map, { bands: EQUAL });

      map.step(8);

      expectAt(map, TOKYO);
    });

    it('chains to a hook the application set before installation', () => {
      const map = new FakeV6Map(geographicToMap(TOKYO, 0), 4.5);
      const upstream = vi.fn((): CameraUpdateResult => ({}));
      map.setTransformCameraUpdate(upstream);
      new BandCamera(map, { bands: EQUAL });

      map.step(4.6);

      expect(upstream).toHaveBeenCalledOnce();
    });

    it('restores that hook on destroy', () => {
      const map = new FakeV6Map(geographicToMap(TOKYO, 0), 4.5);
      const upstream = vi.fn((): CameraUpdateResult => ({}));
      map.setTransformCameraUpdate(upstream);
      const camera = new BandCamera(map, { bands: EQUAL });

      camera.destroy();

      expect(map._camera.transformCameraUpdate).toBe(upstream);
    });

    it('warns, and still installs, when the existing hook cannot be read', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const map = new OpaqueV6Map();
      const start = geographicToMap(TOKYO, 0);
      map.center = { lng: start[0], lat: start[1] };
      new BandCamera(map, { bands: EQUAL });

      map.step(8);

      expect(warn).toHaveBeenCalledOnce();
      // Tokyo, not the map-space start: proves the hook was installed and converted.
      expectAt(map, TOKYO);
      warn.mockRestore();
    });
  });
});
