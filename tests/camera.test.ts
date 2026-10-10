import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThresholdCamera, type CameraUpdateFn } from '../src/map/camera.js';
import { geographicToMap, mapToGeographic } from '../src/math/backproject.js';
import { FakeV5Map, FakeV6Map, type Frame } from './support/fake-maplibre.js';

const SWITCH_ZOOM = 3;

/** One gesture through these absolute zooms (see `support/fake-maplibre.ts` for the model). */
const frames = (...zooms: number[]): Frame[] => zooms.map((zoom) => ({ zoom }));

describe.each([
  { shape: 'v5', create: (center: [number, number], zoom: number) => new FakeV5Map(center, zoom) },
  { shape: 'v6', create: (center: [number, number], zoom: number) => new FakeV6Map(center, zoom) },
])('ThresholdCamera gestures on a MapLibre $shape-shaped host', ({ create }) => {
  const zurich: [number, number] = [8.5, 47.4];

  it('holds the centre on every frame when crossing upward', () => {
    // Regression (original): the predicate compared against a zoom frozen at `movestart`,
    // re-converting an already-converted centre each frame. Regression (0.3 spike): converting
    // only on the crossing frame snapped back on the next, because MapLibre feeds the hook
    // the unconverted requested state every frame.
    const map = create(geographicToMap(zurich), 2);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    for (const frame of frames(2.2, 2.6, 2.9, 3.1, 3.4, 3.8, 4.2, 5.0)) {
      map.applyFrame(frame);
      const blend = map.zoom < SWITCH_ZOOM ? 0 : 1;
      const [lng, lat] = mapToGeographic([map.center.lng, map.center.lat], blend);
      expect(lng).toBeCloseTo(zurich[0], 6);
      expect(lat).toBeCloseTo(zurich[1], 6);
    }
    expect(map.center.lng).toBeCloseTo(zurich[0], 6);
    expect(map.center.lat).toBeCloseTo(zurich[1], 6);
  });

  it('holds the centre when crossing downward', () => {
    const map = create(zurich, 5);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    for (const frame of frames(4.5, 4.0, 3.5, 3.1, 2.9, 2.4, 1.8)) map.applyFrame(frame);

    const expected = geographicToMap(zurich);
    expect(map.center.lng).toBeCloseTo(expected[0], 6);
    expect(map.center.lat).toBeCloseTo(expected[1], 6);
  });

  it('returns to the requested centre across a crossing and back in one gesture', () => {
    const map = create(geographicToMap([-73.98, 40.75]), 2);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    for (const frame of frames(4, 2)) map.applyFrame(frame);

    expect(map.center).toEqual(map.requestedCenter);
  });

  it('converts a second gesture correctly after moveend re-bases the requested state', () => {
    const map = create(geographicToMap(zurich), 2);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    map.jumpTo({ zoom: 4 });
    for (const frame of frames(3.5, 2.5, 2)) map.applyFrame(frame);

    const expected = geographicToMap(zurich);
    expect(map.center.lng).toBeCloseTo(expected[0], 6);
    expect(map.center.lat).toBeCloseTo(expected[1], 6);
  });
});

describe('ThresholdCamera', () => {
  let map: FakeV5Map;

  beforeEach(() => {
    map = new FakeV5Map([0, 0], 2);
  });

  it('converts an initial jump across the threshold before any interaction', () => {
    // Regression: `_zoomstart` was only set in a `movestart` handler, so it was
    // `undefined` on the first update — and `undefined` fails both `<` and `>=`,
    // so this conversion was silently skipped.
    const geographic: [number, number] = [8.5, 47.4];
    map = new FakeV5Map(geographicToMap(geographic), 1);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    map.jumpTo({ zoom: 10 }); // e.g. a deep-link jump on page load

    expect(map.center.lng).toBeCloseTo(geographic[0], 6);
    expect(map.center.lat).toBeCloseTo(geographic[1], 6);
  });

  it('leaves the centre untouched when no crossing occurs', () => {
    map = new FakeV5Map([12.5, 41.9], 5);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    for (const zoom of [5.5, 6, 7, 8]) map.applyFrame({ zoom });

    expect(map.center.lng).toBeCloseTo(12.5, 12);
    expect(map.center.lat).toBeCloseTo(41.9, 12);
  });

  it('treats exactly switchZoom as the Mercator side', () => {
    const geographic: [number, number] = [8.5, 47.4];
    map = new FakeV5Map(geographicToMap(geographic), 2);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });

    map.applyFrame({ zoom: SWITCH_ZOOM });

    expect(map.center.lng).toBeCloseTo(geographic[0], 6);
    expect(map.center.lat).toBeCloseTo(geographic[1], 6);
  });

  describe('lifecycle', () => {
    it('chains to a pre-existing transformCameraUpdate instead of clobbering it', () => {
      const existing = vi.fn<CameraUpdateFn>((next) => ({ zoom: next.zoom }));
      map.transformCameraUpdate = existing;

      new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });
      map.applyFrame({ zoom: 4 });

      expect(existing).toHaveBeenCalled();
    });

    it('honours an upstream hook that rewrites the centre', () => {
      // An upstream bbox constraint clamps the centre; our conversion must operate on
      // the clamped value, not the raw one.
      const clamped = geographicToMap([0, 0]);
      map = new FakeV5Map(geographicToMap([170, 80]), 2);
      map.transformCameraUpdate = () => ({ center: { lng: clamped[0], lat: clamped[1] } });

      new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM });
      map.applyFrame({ zoom: 4 });

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
    map = new FakeV5Map([Number.NaN, Number.NaN], 2);
    new ThresholdCamera(map, { switchZoom: SWITCH_ZOOM, onConversionFailure });

    map.applyFrame({ zoom: 4 });

    expect(onConversionFailure).toHaveBeenCalledOnce();
  });

  it('uses the supplied LngLat factory', () => {
    class LngLat {
      constructor(
        public lng: number,
        public lat: number,
      ) {}
    }
    map = new FakeV5Map(geographicToMap([8.5, 47.4]), 2);
    new ThresholdCamera(map, {
      switchZoom: SWITCH_ZOOM,
      lngLatFactory: (lng, lat) => new LngLat(lng, lat),
    });

    map.applyFrame({ zoom: 4 });

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
