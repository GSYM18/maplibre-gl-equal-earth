import { describe, expect, it, vi } from 'vitest';

import type { Band } from '../src/map/bands.js';
import { BandCamera, type CameraUpdateResult } from '../src/map/camera.js';
import { createEqualEarthConstrain } from '../src/map/constrain.js';
import { geographicToMap, mapSpaceMaxLatitude, mapToGeographic } from '../src/math/backproject.js';
import {
  FakeV5Map,
  FakeV6Map,
  OpaqueV6Map,
  type FakeCamera,
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
const SAN_FRANCISCO: [number, number] = [-122.42, 37.77];

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
    map.endGesture({ inertia })?.finish();
    expectHeldThrough(map, zoomFrames(5.4, 6.4, 0.2), GUADALAJARA);
    map.endGesture({ inertia })?.finish();
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

  it.each([
    // [name, ease zooms, interrupting scroll delta]: the second crosses z6 on that very frame.
    ['a double-click zoom', [4.8, 5.1, 5.3], 0.1],
    ['a flyTo', [4.0, 4.6, 5.2, 5.6, 5.9], 0.2],
  ] as const)(
    'holds the centre when a scroll then a drag interrupt %s that has crossed z5',
    (_, easeZooms, scrollDelta) => {
      const map = mapAt(create, GUADALAJARA, 4.6);
      new BandCamera(map, { bands: EQUAL });

      const ease = map.easeTo();
      for (const zoom of easeZooms) {
        ease.frame({ zoom });
        expectGeographic(map, GUADALAJARA);
      }

      // The interrupting frame renders the `R` its own `stop()` just deleted.
      expectHeldThrough(map, [{ zoomDelta: scrollDelta }], GUADALAJARA);
      expect(map.requestedCenter).toBeUndefined();
      expectHeldThrough(map, zoomFrames(0, 0.4, 0.1), GUADALAJARA);

      // The drag: `R` was cloned from what the interrupting frame rendered, so it is in that
      // frame's band. A drag there and back must land on Guadalajara again.
      const draggedFrom = blendAt(map.zoom);
      for (const panDelta of [[0.3, 0.2], [0.3, 0.2], [-0.3, -0.2], [-0.3, -0.2]] as const) {
        map.applyFrame({ panDelta });
        const requested = map.requestedCenter!;
        const geographic = mapToGeographic([requested.lng, requested.lat], draggedFrom);
        expectGeographic(map, geographic);
      }
      expectGeographic(map, GUADALAJARA);
    },
  );

  it('holds the centre through a gesture after an ease that crossed z5 has finished', () => {
    const map = mapAt(create, GUADALAJARA, 4.6);
    new BandCamera(map, { bands: EQUAL });

    const ease = map.easeTo();
    for (const zoom of [4.8, 5.1, 5.3]) ease.frame({ zoom });
    ease.finish();

    expectHeldThrough(map, zoomFrames(5.3, 6.3, 0.2), GUADALAJARA);
  });

  it('reads an app-supplied centre in the rendered band after a scroll ends without inertia', () => {
    // The reviewer's case. On v6 the scroll's Map-fired moveend never reached the Camera, so
    // `R` survived with a band-0 baseline while the app's `jumpTo` centre was in band ⅓.
    const map = mapAt(create, TOKYO, 4.8);
    const camera = new BandCamera(map, { bands: EQUAL });
    expectHeldThrough(map, zoomFrames(4.8, 5.6, 0.2), TOKYO);
    map.endGesture({ inertia: false });

    map.jumpTo({ center: geographicToMap(GUADALAJARA, camera.blend), zoom: map.getZoom() });
    expectGeographic(map, GUADALAJARA);

    expectHeldThrough(map, zoomFrames(map.zoom, 6.4, 0.2), GUADALAJARA);
  });

  it('keeps San Francisco through the spike: scroll, stop, city button, then the z7 cross', () => {
    // The human's browser case, replaying demo/spike/bands.ts: the city button jumps to
    // `geographicToMap(city, blendNow())` at the current zoom; `crossing(7)` jumps to 7 -/+ 1e-4.
    const map = mapAt(create, TOKYO, 4.6);
    const camera = new BandCamera(map, { bands: EQUAL });
    expectHeldThrough(map, zoomFrames(4.6, 5.4, 0.2), TOKYO);
    map.endGesture({ inertia: false });

    map.jumpTo({ center: geographicToMap(SAN_FRANCISCO, camera.blend), zoom: map.getZoom() });
    expectGeographic(map, SAN_FRANCISCO);
    map.jumpTo({ zoom: 7 - 1e-4 });
    expectGeographic(map, SAN_FRANCISCO);
    map.jumpTo({ zoom: 7 + 1e-4 });
    expectGeographic(map, SAN_FRANCISCO);
  });

  it('reads an eased-to centre in the rendered band after a scroll ends without inertia', () => {
    const map = mapAt(create, TOKYO, 4.8);
    const camera = new BandCamera(map, { bands: EQUAL });
    expectHeldThrough(map, zoomFrames(4.8, 5.6, 0.2), TOKYO);
    map.endGesture({ inertia: false });

    const ease = map.easeTo();
    ease.frame({ center: geographicToMap(GUADALAJARA, camera.blend), zoom: map.getZoom() });
    expectGeographic(map, GUADALAJARA);
    ease.finish();
  });

  it('holds the centre, and keeps an ease running, through a Map-level moveend mid-ease', () => {
    // A resize (v6 24099) during a flyTo. On v6 the ease's `R` must survive it.
    const map = mapAt(create, GUADALAJARA, 4.6);
    new BandCamera(map, { bands: EQUAL });
    const ease = map.easeTo();
    for (const zoom of [4.8, 5.1]) {
      ease.frame({ zoom });
      expectGeographic(map, GUADALAJARA);
    }

    map.fireMapMoveEnd();

    // On v5 every moveend deletes `R` (and the ease renders it detached); never on v6 mid-ease.
    expect(map.requestedCenter === undefined).toBe(shape === 'v5');
    for (const zoom of [5.4, 5.8, 6.2, 6.6, 7.2]) {
      ease.frame({ zoom });
      expectGeographic(map, GUADALAJARA);
    }
    ease.finish();
    expectHeldThrough(map, zoomFrames(map.zoom, 6.2, 0.2), GUADALAJARA);
  });

  it('stops listening for moveend on destroy, and destroys idempotently', () => {
    const map = mapAt(create, GUADALAJARA, 4.8);
    // v5: one emitter. v6: the Camera's (deletes `R`) and the Map's (closes the v6 gap).
    const total = () =>
      map.listenerCount('moveend') +
      (map instanceof FakeV6Map ? map._camera.listenerCount('moveend') : 0);
    const before = total();
    const camera = new BandCamera(map, { bands: EQUAL });
    expect(total()).toBe(before + (shape === 'v6' ? 2 : 1));

    camera.destroy();
    camera.destroy();

    expect(total()).toBe(before);
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

  it('returns promptly for an absurdly large longitude instead of looping', { timeout: 1000 }, () => {
    const onConversionFailure = vi.fn();
    const map = create([1e300, 0], 8);
    new BandCamera(map, { bands: EQUAL, onConversionFailure });

    expect(() => map.applyFrame({ zoom: 6.5 })).not.toThrow();
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

  it(`fake: ${shape === 'v6' ? 'keeps' : 'deletes'} R across a Map-fired moveend, unaided`, () => {
    // Pins the fake to the real model: only the Camera's own moveend deletes `R`.
    const map = mapAt(create, GUADALAJARA, 4.8);
    map.applyFrame({ zoomDelta: 0.4 });

    map.endGesture({ inertia: false });

    expect(map.requestedCenter === undefined).toBe(shape === 'v5');
  });

  it('deletes R on a Map-fired moveend outside an ease, as v5 itself does', () => {
    const map = mapAt(create, GUADALAJARA, 4.8);
    new BandCamera(map, { bands: EQUAL });
    map.applyFrame({ zoomDelta: 0.4 });

    map.endGesture({ inertia: false });

    expect(map.requestedCenter).toBeUndefined();
  });

  it('holds the centre through a pinch that crosses z5 and is released with inertia (I1)', () => {
    const map = mapAt(create, GUADALAJARA, 4.8);
    new BandCamera(map, { bands: EQUAL });
    for (const frame of zoomFrames(4.8, 5.2, 0.1)) map.applyFrame(frame);
    const ease = map.endGesture({ inertia: true })!;
    // The HandlerManager builds the inertial ease from the rendered transform.
    ease.frame({ center: [map.center.lng, map.center.lat], zoomDelta: 0.05 });
    expectGeographic(map, GUADALAJARA, 1e-9);
    ease.frame({ zoomDelta: 0.05 });
    ease.finish();
    expectGeographic(map, GUADALAJARA, 1e-9);
  });

  it.each([
    ['zooming', true],
    ['pan-only', false],
  ] as const)(
    'holds the centre when a gesture interrupts a %s inertial ease before its first frame',
    (_, inertialZoom) => {
      // The inertial ease's `R` was cloned from the rendered transform, in the new band. A touch
      // that stops it before any frame renders that `R` detached; it must not be read in the
      // band of the `R` the gesture end discarded.
      const map = mapAt(create, GUADALAJARA, 4.8);
      new BandCamera(map, { bands: EQUAL });
      expectHeldThrough(map, zoomFrames(4.8, 5.2, 0.1), GUADALAJARA);
      map.endGesture({ inertia: true, inertialZoom });

      expectHeldThrough(map, zoomFrames(5.2, 5.4, 0.1), GUADALAJARA);
      // And the state the next frames accumulate into is in the rendered band: a drag there
      // and back lands on Guadalajara again.
      map.applyFrame({ panDelta: [0.2, 0.1] });
      map.applyFrame({ panDelta: [-0.2, -0.1] });
      expectGeographic(map, GUADALAJARA);
    },
  );

  it("does not let the constraint clamp the requested state against a lower band's edge (I3)", () => {
    const SVALBARD: [number, number] = [15.6, 78.2];
    const map = mapAt(create, SVALBARD, 5.3);
    const camera = new BandCamera(map, { bands: EQUAL });
    map.setTransformConstrain(
      createEqualEarthConstrain({
        lngLatFactory: (lng, lat) => ({ lng, lat }),
        bands: EQUAL,
        baselineBand: () => camera.baselineBand,
      }),
    );
    expectHeldThrough(map, zoomFrames(5.3, 4.7, 0.1), SVALBARD);
  });

  it('brings a centre in the empty corner back onto the outline before converting (row 9)', () => {
    const map = create([179, 60], 4.9);
    new BandCamera(map, { bands: EQUAL });
    map.applyFrame({ zoomDelta: 0.2 });
    const [lng, lat] = renderedGeographic(map);
    // On the outline, not 246° beyond it. The slack is this check's own round trip: even an
    // exact ±180° comes back from blend ⅓ map space as 180 ± 4e-12.
    expect(Math.abs(lng)).toBeLessThanOrEqual(180 + 1e-9);
    expect(Math.abs(lat)).toBeLessThanOrEqual(90);
  });

  it('holds the centre through two Map-level moveends during one band-crossing ease (m13)', () => {
    // v5: each one deletes the ease's `R`, which the ease keeps rendering detached. The second
    // must not forget the band that detached `R` is in. (v6 keeps `R` mid-ease throughout.)
    const map = mapAt(create, GUADALAJARA, 4.6);
    new BandCamera(map, { bands: EQUAL });
    const ease = map.easeTo();
    for (const zoom of [4.8, 5.1]) ease.frame({ zoom });

    map.fireMapMoveEnd();
    ease.frame({ zoom: 5.4 });
    expectGeographic(map, GUADALAJARA);
    map.fireMapMoveEnd();
    for (const zoom of [5.8, 6.2, 6.6, 7.2]) {
      ease.frame({ zoom });
      expectGeographic(map, GUADALAJARA);
    }
    ease.finish();
    expectHeldThrough(map, zoomFrames(map.zoom, 6.2, 0.2), GUADALAJARA);
  });

  it("keeps the baseline when a stale frame's conversion fails (m14)", () => {
    const onConversionFailure = vi.fn();
    const map = create([Number.NaN, Number.NaN], 4.6);
    const camera = new BandCamera(map, { bands: EQUAL, onConversionFailure });
    const ease = map.easeTo();
    ease.frame({ zoom: 4.8 });

    // A scroll interrupts the ease and crosses z5 on its first, detached, frame.
    map.applyFrame({ zoomDelta: 0.4 });

    expect(onConversionFailure).toHaveBeenCalledOnce();
    // Rendered unconverted, so still in band 0's space, and the baseline says so.
    expect(camera.baselineBand).toBe(0);
  });

  it('listens for every gesture end, and stops on destroy', () => {
    const map = mapAt(create, GUADALAJARA, 4.8);
    const types = ['dragend', 'zoomend', 'rotateend', 'pitchend', 'rollend'];
    const counts = () => types.map((type) => map.listenerCount(type));
    const before = counts();
    const camera = new BandCamera(map, { bands: EQUAL });
    expect(counts()).toEqual(before.map((count) => count + 1));

    camera.destroy();

    expect(counts()).toEqual(before);
  });
});

describe('BandCamera', () => {
  it('scrolls across z5, stops without inertia, then scrolls across z6 (v6)', () => {
    // Scroll zoom is `noInertia`, so its moveend is fired on the Map, which on its own would
    // leave a band-0 `R` behind. The camera deletes it there, as v5 does.
    const map = mapAt(SHAPES[1].create, GUADALAJARA, 4.6);
    new BandCamera(map, { bands: EQUAL });

    expectHeldThrough(map, zoomFrames(4.6, 5.4, 0.2), GUADALAJARA);
    map.endGesture({ inertia: false });
    expect(map.requestedCenter).toBeUndefined();
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

    it('leaves an app-replaced hook alone on destroy (row 10)', () => {
      const map = new FakeV6Map([0, 0], 3);
      const camera = new BandCamera(map, { bands: EQUAL });
      const replacement = () => ({});
      map.setTransformCameraUpdate(replacement);
      camera.destroy();
      expect(map._camera.transformCameraUpdate).toBe(replacement);
    });

    it('still holds ordinary gestures when the requested state cannot be read', () => {
      // As if MapLibre had renamed the field: it reads as absent on every frame, and the
      // Map's moveend cannot delete it. Ordinary gestures must still hold.
      class RenamedV6Map extends FakeV6Map {
        override get _camera(): FakeCamera {
          return new Proxy(super._camera, {
            get: (target, key) => {
              if (key === '_requestedCameraState') return undefined;
              const value: unknown = Reflect.get(target, key);
              return typeof value === 'function' ? (value.bind(target) as unknown) : value;
            },
          });
        }
      }
      const map = new RenamedV6Map(geographicToMap(GUADALAJARA, 0), 4.6);
      new BandCamera(map, { bands: EQUAL });

      expectHeldThrough(map, zoomFrames(4.6, 5.4, 0.2), GUADALAJARA);
      // The inertial ease runs to its end, whose Camera `moveend` re-bases.
      map.endGesture({ inertia: true })!.finish();
      expectHeldThrough(map, zoomFrames(5.4, 6.4, 0.2), GUADALAJARA);
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

    it('falls back to the Map moveend when the camera internals cannot be read', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const map = new OpaqueV6Map(geographicToMap(TOKYO, 0), 4);
      const before = map.listenerCount('moveend');
      const camera = new BandCamera(map, { bands: EQUAL });
      expect(map.listenerCount('moveend')).toBe(before + 1);

      // A jump re-bases through that listener: the second converts from band 2/3, not band 0.
      map.jumpTo({ zoom: 6.5 });
      map.jumpTo({ zoom: 8 });
      expectAt(map, TOKYO);

      camera.destroy();
      camera.destroy();
      expect(map.listenerCount('moveend')).toBe(before);
      warn.mockRestore();
    });
  });
});
