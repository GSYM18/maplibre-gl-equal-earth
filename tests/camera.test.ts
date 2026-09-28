import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ThresholdCamera,
  type CameraUpdate,
  type CameraUpdateFn,
  type CameraUpdateResult,
} from '../src/map/camera.js';
import { geographicToMap, mapToGeographic } from '../src/math/backproject.js';

const SWITCH_ZOOM = 3;

/**
 * Stand-in for `maplibregl.Map`, modelling the one behaviour that made the original bug
 * so damaging: MapLibre's handler loop feeds the centre returned by `transformCameraUpdate`
 * back in as the baseline for the next frame.
 */
class FakeMap {
  transformCameraUpdate: CameraUpdateFn | null | undefined = null;
  center: { lng: number; lat: number };
  zoom: number;

  constructor(center: [number, number], zoom: number) {
    this.center = { lng: center[0], lat: center[1] };
    this.zoom = zoom;
  }

  getZoom(): number {
    return this.zoom;
  }

  /** Drive one camera update, applying the result the way MapLibre's handler loop does. */
  step(zoom: number): void {
    this.zoom = zoom;
    const next: CameraUpdate = { center: { ...this.center }, zoom };
    const result: CameraUpdateResult = this.transformCameraUpdate?.(next) ?? {};
    // Store the returned object by reference, as MapLibre's `setCenter(center)` does.
    if (result.center) this.center = result.center;
  }
}

describe('ThresholdCamera', () => {
  let map: FakeMap;

  beforeEach(() => {
    map = new FakeMap([0, 0], 2);
  });

  it('converts exactly once when crossing upward, even over many frames', () => {
    // Regression: the original compared against a zoom frozen at `movestart`, so this
    // predicate stayed true after the crossing and re-converted every frame, compounding.
    const geographic: [number, number] = [8.5, 47.4];
    const startCenter = geographicToMap(geographic);
    map = new FakeMap(startCenter, 2);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    // A continuous pinch zoom through the threshold.
    for (const zoom of [2.2, 2.6, 2.9, 3.1, 3.4, 3.8, 4.2, 5.0]) {
      map.step(zoom);
    }

    expect(map.center.lng).toBeCloseTo(geographic[0], 6);
    expect(map.center.lat).toBeCloseTo(geographic[1], 6);
  });

  it('converts exactly once when crossing downward', () => {
    const geographic: [number, number] = [8.5, 47.4];
    map = new FakeMap(geographic, 5);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    for (const zoom of [4.5, 4.0, 3.5, 3.1, 2.9, 2.4, 1.8]) {
      map.step(zoom);
    }

    const expected = geographicToMap(geographic);
    expect(map.center.lng).toBeCloseTo(expected[0], 6);
    expect(map.center.lat).toBeCloseTo(expected[1], 6);
  });

  it('round-trips to the original centre across a crossing and back', () => {
    const geographic: [number, number] = [-73.98, 40.75];
    map = new FakeMap(geographicToMap(geographic), 2);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    map.step(4); // up across the threshold
    map.step(2); // and back down

    const expected = geographicToMap(geographic);
    expect(map.center.lng).toBeCloseTo(expected[0], 6);
    expect(map.center.lat).toBeCloseTo(expected[1], 6);
  });

  it('converts an initial jump across the threshold before any interaction', () => {
    // Regression: `_zoomstart` was only set in a `movestart` handler, so it was
    // `undefined` on the first update — and `undefined` fails both `<` and `>=`,
    // so this conversion was silently skipped.
    const geographic: [number, number] = [8.5, 47.4];
    map = new FakeMap(geographicToMap(geographic), 1);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    map.step(10); // e.g. a deep-link flyTo on page load

    expect(map.center.lng).toBeCloseTo(geographic[0], 6);
    expect(map.center.lat).toBeCloseTo(geographic[1], 6);
  });

  it('leaves the centre untouched when no crossing occurs', () => {
    map = new FakeMap([12.5, 41.9], 5);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    for (const zoom of [5.5, 6, 7, 8]) map.step(zoom);

    expect(map.center.lng).toBeCloseTo(12.5, 12);
    expect(map.center.lat).toBeCloseTo(41.9, 12);
  });

  it('treats exactly switchZoom as the Mercator side', () => {
    const geographic: [number, number] = [8.5, 47.4];
    map = new FakeMap(geographicToMap(geographic), 2);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    map.step(SWITCH_ZOOM);

    expect(map.center.lng).toBeCloseTo(geographic[0], 6);
    expect(map.center.lat).toBeCloseTo(geographic[1], 6);
  });

  describe('lifecycle', () => {
    it('chains to a pre-existing transformCameraUpdate instead of clobbering it', () => {
      const existing = vi.fn<CameraUpdateFn>((next) => ({ zoom: next.zoom }));
      map.transformCameraUpdate = existing;

      new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });
      map.step(4);

      expect(existing).toHaveBeenCalled();
    });

    it('honours an upstream hook that rewrites the centre', () => {
      // An upstream bbox constraint clamps the centre; our conversion must operate on
      // the clamped value, not the raw one.
      const clamped = geographicToMap([0, 0]);
      map = new FakeMap(geographicToMap([170, 80]), 2);
      map.transformCameraUpdate = () => ({ center: { lng: clamped[0], lat: clamped[1] } });

      new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });
      map.step(4);

      expect(map.center.lng).toBeCloseTo(0, 6);
      expect(map.center.lat).toBeCloseTo(0, 6);
    });

    it('restores the previous hook on destroy', () => {
      const existing: CameraUpdateFn = () => ({});
      map.transformCameraUpdate = existing;

      const camera = new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });
      expect(map.transformCameraUpdate).not.toBe(existing);

      camera.destroy();
      expect(map.transformCameraUpdate).toBe(existing);
    });

    it('resets to null when there was no previous hook', () => {
      const camera = new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });
      camera.destroy();
      expect(map.transformCameraUpdate).toBeNull();
    });

    it('is idempotent and does not steal a hook installed after it', () => {
      const camera = new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });
      const replacement: CameraUpdateFn = () => ({});
      map.transformCameraUpdate = replacement;

      camera.destroy();
      camera.destroy();

      expect(map.transformCameraUpdate).toBe(replacement);
    });

    it('rejects a non-finite switchZoom rather than silently doing nothing', () => {
      // The original accepted `undefined`, which made every comparison false and left
      // the plugin installed but inert, forever, with no diagnostic.
      expect(() => new ThresholdCamera(map, { switchZoom: Number.NaN })).toThrow(TypeError);
      expect(
        () => new ThresholdCamera(map, { switchZoom: undefined as unknown as number }),
      ).toThrow(TypeError);
    });

    it('rejects a host that is not map-like', () => {
      expect(
        () => new ThresholdCamera({} as never, { switchZoom: SWITCH_ZOOM }),
      ).toThrow(TypeError);
    });
  });

  it('reports a conversion failure rather than swallowing it', () => {
    const onConversionFailure = vi.fn();
    map = new FakeMap([Number.NaN, Number.NaN], 2);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM, onConversionFailure });

    map.step(4);

    expect(onConversionFailure).toHaveBeenCalledOnce();
  });

  it('uses the supplied LngLat factory', () => {
    class LngLat {
      constructor(
        public lng: number,
        public lat: number,
      ) {}
    }
    map = new FakeMap(geographicToMap([8.5, 47.4]), 2);
    new ThresholdCamera(map, {
      switchZoom: SWITCH_ZOOM,
      lngLatFactory: (lng, lat) => new LngLat(lng, lat),
    });

    map.step(4);

    expect(map.center).toBeInstanceOf(LngLat);
  });
});

describe('backprojection round trip', () => {
  it('round-trips geographic → map → geographic', () => {
    for (let lng = -180; lng <= 180; lng += 30) {
      for (let lat = -85; lat <= 85; lat += 17) {
        const [rlng, rlat] = mapToGeographic(geographicToMap([lng, lat]));
        expect(rlng).toBeCloseTo(lng, 6);
        expect(rlat).toBeCloseTo(lat, 6);
      }
    }
  });
});
