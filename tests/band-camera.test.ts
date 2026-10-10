import { describe, expect, it, vi } from 'vitest';

import type { Band } from '../src/map/bands.js';
import { BandCamera, type CameraUpdateResult } from '../src/map/camera.js';
import { geographicToMap, mapSpaceMaxLatitude, mapToGeographic } from '../src/math/backproject.js';
import {
  FakeV5Map,
  FakeV6Map,
  OpaqueV6Map,
  type FakeMapBase,
  type Frame,
} from './support/fake-maplibre.js';

/** The `equal` projection's bands (spec §3). */
const EQUAL: Band[] = [
  { minZoom: 0, blend: 0 },
  { minZoom: 5, blend: 1 / 3 },
  { minZoom: 6, blend: 2 / 3 },
  { minZoom: 7, blend: 1 },
];
const GUADALAJARA: [number, number] = [-103.35, 20.67];
const TOKYO: [number, number] = [139.69, 35.69];
const ANCHORAGE: [number, number] = [-149.9, 61.22];

const blendAt = (zoom: number) => (zoom < 5 ? 0 : zoom < 6 ? 1 / 3 : zoom < 7 ? 2 / 3 : 1);

type AnyMap = FakeV5Map | FakeV6Map;

const SHAPES = [
  { shape: 'v5', create: (center: [number, number], zoom: number): AnyMap => new FakeV5Map(center, zoom) },
  { shape: 'v6', create: (center: [number, number], zoom: number): AnyMap => new FakeV6Map(center, zoom) },
] as const;

/** A map at `zoom`, centred on a geographic point expressed in that zoom's map space. */
function mapAt(create: (typeof SHAPES)[number]['create'], geographic: [number, number], zoom: number) {
  return create(geographicToMap(geographic, blendAt(zoom)), zoom);
}

/** Frames that zoom by `step` from `from` until reaching `to`. */
function zoomFrames(from: number, to: number, step: number): Frame[] {
  const count = Math.round(Math.abs(to - from) / step);
  return Array.from({ length: count }, () => ({ zoomDelta: Math.sign(to - from) * step }));
}

/** The geographic point under the rendered centre. */
function renderedGeographic(map: FakeMapBase): [number, number] {
  return mapToGeographic([map.center.lng, map.center.lat], blendAt(map.zoom));
}

function expectGeographic(map: FakeMapBase, expected: [number, number], tolerance = 1e-9): void {
  const [lng, lat] = renderedGeographic(map);
  const context = `at rendered zoom ${map.zoom}`;
  expect(Math.abs(lng - expected[0]), context).toBeLessThan(tolerance);
  expect(Math.abs(lat - expected[1]), context).toBeLessThan(tolerance);
}

/** Apply every frame, checking after each one that the centre stays on `geographic`. */
function expectHeldThrough(map: FakeMapBase, frames: Frame[], geographic: [number, number]): void {
  for (const frame of frames) {
    map.applyFrame(frame);
    expectGeographic(map, geographic);
  }
}

function expectAt(map: FakeMapBase, expected: [number, number], digits = 9): void {
  expect(map.center.lng).toBeCloseTo(expected[0], digits);
  expect(map.center.lat).toBeCloseTo(expected[1], digits);
}

describe.each(SHAPES)('BandCamera on a MapLibre $shape-shaped host', ({ shape, create }) => {
  it('holds the centre on every frame after the crossing, not just the crossing frame', () => {
    // The Guadalajara report: MapLibre feeds the hook the unconverted requested state on
    // every frame, so a hook that only converts on the crossing frame snaps back on the next.
    const map = mapAt(create, GUADALAJARA, 4.8);
    new BandCamera(map, { bands: EQUAL });

    expectHeldThrough(map, zoomFrames(4.8, 5.6, 0.1), GUADALAJARA);
  });

  it.each([
    ['Guadalajara', GUADALAJARA],
    ['Tokyo', TOKYO],
    ['Anchorage', ANCHORAGE],
  ] as const)('holds %s through z5, z6 and z7 in one gesture, both ways', (_, place) => {
    const map = mapAt(create, place, 4.5);
    new BandCamera(map, { bands: EQUAL });

    expectHeldThrough(map, zoomFrames(4.5, 7.5, 0.25), place);
    expectHeldThrough(map, zoomFrames(7.5, 4.5, 0.25), place);
  });

  it('returns exactly to the requested centre when a gesture crosses up and back down', () => {
    const map = mapAt(create, GUADALAJARA, 4.8);
    new BandCamera(map, { bands: EQUAL });

    for (const frame of [...zoomFrames(4.8, 5.4, 0.2), ...zoomFrames(5.4, 4.8, 0.2)]) {
      map.applyFrame(frame);
    }

    expect(map.zoom).toBeLessThan(5);
    expect(map.center).toEqual(map.requestedCenter);
  });

  it.each([
    ['with inertia (the Camera fires moveend)', true],
    ['without inertia (the Map fires moveend)', false],
  ])('holds the centre through a second gesture after one ending %s', (_, inertia) => {
    const map = mapAt(create, GUADALAJARA, 4.6);
    new BandCamera(map, { bands: EQUAL });

    expectHeldThrough(map, zoomFrames(4.6, 5.4, 0.2), GUADALAJARA);
    map.endGesture({ inertia });
    expectHeldThrough(map, zoomFrames(5.4, 6.4, 0.2), GUADALAJARA);
    map.endGesture({ inertia });
    expectHeldThrough(map, zoomFrames(6.4, 7.4, 0.2), GUADALAJARA);
  });

  it('does not drift over many jumpTo round trips through the bands', () => {
    const map = mapAt(create, TOKYO, 9);
    new BandCamera(map, { bands: EQUAL });

    for (let i = 0; i < 20; i++) {
      for (const zoom of [7.5, 6.5, 5.5, 4.5, 5.5, 6.5, 7.5]) {
        map.jumpTo({ zoom });
        expectGeographic(map, TOKYO, 1e-8);
      }
    }
    map.jumpTo({ zoom: 9 });

    expectAt(map, TOKYO, 8);
  });

  it('converts an initial jump across several bands, once and directly', () => {
    const map = mapAt(create, TOKYO, 3);
    new BandCamera(map, { bands: EQUAL });

    map.jumpTo({ zoom: 10 });

    expectAt(map, TOKYO);
  });

  it('renders a pan made after the crossing as the converted requested centre', () => {
    const map = mapAt(create, GUADALAJARA, 4.8);
    new BandCamera(map, { bands: EQUAL });
    expectHeldThrough(map, zoomFrames(4.8, 5.2, 0.2), GUADALAJARA);

    let previous = renderedGeographic(map);
    for (let i = 0; i < 5; i++) {
      map.applyFrame({ panDelta: [0.4, -0.3] });

      // `R` is still in band 0's map space; what is rendered is its band-⅓ equivalent.
      const requested = map.requestedCenter!;
      const geographic = mapToGeographic([requested.lng, requested.lat], 0);
      expectAt(map, geographicToMap(geographic, 1 / 3));
      expectGeographic(map, geographic);

      // And it moves smoothly: each frame shifts the view by the pan, not by a snap.
      const current = renderedGeographic(map);
      expect(Math.hypot(current[0] - previous[0], current[1] - previous[1])).toBeLessThan(1);
      previous = current;
    }
  });

  it('stops listening for moveend on destroy, and destroys idempotently', () => {
    const map = mapAt(create, GUADALAJARA, 4.8);
    const emitter = map instanceof FakeV6Map ? map._camera : map;
    const before = emitter.listenerCount('moveend');
    const camera = new BandCamera(map, { bands: EQUAL });
    expect(emitter.listenerCount('moveend')).toBe(before + 1);

    camera.destroy();
    camera.destroy();

    expect(emitter.listenerCount('moveend')).toBe(before);
    const getZoom = vi.spyOn(map, 'getZoom');
    map.endGesture({ inertia: true });
    map.endGesture({ inertia: false });
    expect(getZoom).not.toHaveBeenCalled();
  });

  it('treats a zoom exactly on a boundary as inside the upper band', () => {
    const map = mapAt(create, TOKYO, 4.5);
    const camera = new BandCamera(map, { bands: EQUAL });

    map.applyFrame({ zoom: 5 });

    expect(camera.blend).toBe(1 / 3);
    expectAt(map, geographicToMap(TOKYO, 1 / 3));
  });

  it('clamps a centre beyond the world edge, then converts', () => {
    // Panned into the empty space above Equal Earth (edge ≈ 65.54° in map space).
    const onConversionFailure = vi.fn();
    const map = create([0, 80], 4.5);
    new BandCamera(map, { bands: EQUAL, onConversionFailure });

    map.applyFrame({ zoom: 5.2 });

    expect(onConversionFailure).not.toHaveBeenCalled();
    expect(map.center.lat).toBeCloseTo(mapSpaceMaxLatitude(1 / 3), 6);
  });

  it('wraps a longitude beyond ±180° before converting', () => {
    const map = create([190, 0], 8);
    new BandCamera(map, { bands: EQUAL });

    map.applyFrame({ zoom: 6.5 });

    expectAt(map, geographicToMap([-170, 0], 2 / 3));
  });

  it('leaves exactly ±180° alone — on Equal Earth those are opposite map edges', () => {
    const map = create([180, 0], 8);
    new BandCamera(map, { bands: EQUAL });

    map.applyFrame({ zoom: 4 });

    expectAt(map, geographicToMap([180, 0], 0));
    expect(map.center.lng).toBeGreaterThan(0);
  });

  it('reports a genuinely non-finite centre', () => {
    const onConversionFailure = vi.fn();
    const map = create([Number.NaN, Number.NaN], 4);
    new BandCamera(map, { bands: EQUAL, onConversionFailure });

    map.applyFrame({ zoom: 8 });

    expect(onConversionFailure).toHaveBeenCalledOnce();
  });

  it(`keeps ${shape === 'v6' ? 'the requested state' : 'nothing'} across a Map-fired moveend`, () => {
    // Pins the fake to the real model: only the Camera's own moveend deletes `R`.
    const map = mapAt(create, GUADALAJARA, 4.8);
    new BandCamera(map, { bands: EQUAL });
    map.applyFrame({ zoomDelta: 0.4 });

    map.endGesture({ inertia: false });

    expect(map.requestedCenter === undefined).toBe(shape === 'v5');
  });
});

describe('BandCamera', () => {
  it('scrolls across z5, stops without inertia, then scrolls across z6 (v6 keeps R)', () => {
    // Scroll zoom is `noInertia`, so its moveend is fired on the Map and never deletes the
    // requested state. The second scroll continues from that stale, band-0 `R`.
    const map = mapAt(SHAPES[1].create, GUADALAJARA, 4.6);
    new BandCamera(map, { bands: EQUAL });

    expectHeldThrough(map, zoomFrames(4.6, 5.4, 0.2), GUADALAJARA);
    map.endGesture({ inertia: false });
    expect(map.requestedCenter).toBeDefined();
    expectHeldThrough(map, zoomFrames(5.4, 6.4, 0.2), GUADALAJARA);
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

    map.applyFrame({ zoom: 6 });

    expect(map.center).toEqual({ lng: 10, lat: 20 });
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
    it('chains to a hook the application set before installation', () => {
      const map = new FakeV6Map(geographicToMap(TOKYO, 0), 4.5);
      const upstream = vi.fn((): CameraUpdateResult => ({}));
      map.setTransformCameraUpdate(upstream);
      new BandCamera(map, { bands: EQUAL });

      map.applyFrame({ zoom: 4.6 });

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

    it('warns once, and still installs, when the camera internals cannot be read', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const map = new OpaqueV6Map(geographicToMap(TOKYO, 0), 4);
      const camera = new BandCamera(map, { bands: EQUAL });

      map.applyFrame({ zoom: 8 });

      expect(warn).toHaveBeenCalledOnce();
      // Tokyo, not the map-space start: proves the hook was installed and converted.
      expectAt(map, TOKYO);
      camera.destroy();
      warn.mockRestore();
    });
  });
});
