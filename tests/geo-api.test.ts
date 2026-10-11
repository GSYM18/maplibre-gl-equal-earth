import { describe, expect, it, vi } from 'vitest';

import { bandIndexForZoom, EQUAL_EARTH_BANDS, resolveTransition } from '../src/map/bands.js';
import {
  fitAcrossBands,
  geographicBounds,
  geographicUnder,
  installGeoApi,
  isMarkedMapSpace,
  lngLatTuple,
  mapSpaceOf,
  markMapSpace,
  rawCamera,
  type BandFit,
  type GeoApiState,
  type LngLatTuple,
} from '../src/map/geo-api.js';
import { geographicToMap, mapSpaceMaxLatitude, mapToGeographic } from '../src/math/backproject.js';
import { FakeGeoHost, FakeLngLat, FakeLngLatBounds, FakeV5GeoHost } from './support/fake-geo-host.js';

const G: LngLatTuple = [-103.35, 20.67]; // Guadalajara
const NO_OFFSETS = { deltaZoom: 0, deltaBearing: 0 };
const state = (over: Partial<GeoApiState> = {}): GeoApiState => ({
  active: true, blend: 0, baselineBlend: 0, bands: EQUAL_EARTH_BANDS, baselineOffsets: NO_OFFSETS, offsets: () => NO_OFFSETS, ...over,
});
const factories = { lngLat: (lng: number, lat: number) => new FakeLngLat(lng, lat), lngLatBounds: (sw: LngLatTuple, ne: LngLatTuple) => new FakeLngLatBounds(sw, ne) };

describe('geographic reads', () => {
  it('passes every read straight through while inactive', () => {
    const host = new FakeGeoHost();
    const plain = new FakeGeoHost();
    installGeoApi(host, state({ active: false }), factories);
    expect(host.getCenter()).toEqual(plain.getCenter());
    expect(host.project([10, 20])).toEqual(plain.project([10, 20]));
    expect(host.unproject([100, 50])).toEqual(plain.unproject([100, 50]));
    expect(host.getBounds()).toEqual(plain.getBounds());
  });

  it("passes the caller's own argument objects through while inactive", () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state({ active: false }), factories);
    const lngLat = { lng: 10, lat: 20 };
    const point = [100, 50];
    host.project(lngLat);
    host.unproject(point);
    expect(host.lastCall('project')[0]).toBe(lngLat);
    expect(host.lastCall('unproject')[0]).toBe(point);
  });

  it.each([0, 0.5, 1])('getCenter returns the geographic centre at blend %s', (blend) => {
    const host = new FakeGeoHost();
    host.center = new FakeLngLat(...geographicToMap(G, blend));
    installGeoApi(host, state({ blend }), factories);
    const c = host.getCenter();
    expect(c.lng).toBeCloseTo(G[0], 9);
    expect(c.lat).toBeCloseTo(G[1], 9);
  });

  it('project and unproject are inverse and agree with the map-space originals', () => {
    const host = new FakeGeoHost();
    const raw = new FakeGeoHost();
    host.center = raw.center = new FakeLngLat(...geographicToMap(G, 0));
    installGeoApi(host, state(), factories);
    expect(host.project(G)).toEqual(raw.project(geographicToMap(G, 0)));
    const back = host.unproject(host.project(G));
    expect(back.lng).toBeCloseTo(G[0], 6);
    expect(back.lat).toBeCloseTo(G[1], 6);
  });

  it('accepts every LngLatLike form', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const a = host.project(G);
    expect(host.project({ lng: G[0], lat: G[1] })).toEqual(a);
    expect(host.project({ lon: G[0], lat: G[1] })).toEqual(a);
  });

  it('reads string coordinates as MapLibre does (Number), not as unreadable', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    expect(host.project({ lng: String(G[0]), lat: String(G[1]) })).toEqual(host.project(G));
    expect(host.project([String(G[0]), String(G[1])])).toEqual(host.project(G));
  });

  it('hands a value it cannot read to the original unchanged', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const odd = { lng: 'x', lat: 1 };
    try {
      host.project(odd);
    } catch {
      // the fake's own reading of it is irrelevant
    }
    expect(host.lastCall('project')[0]).toBe(odd);
  });

  it('a longitude beyond ±180° projects onto its place (one world while active, Ruling R8)', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const a = host.project([179, 70]);
    const b = host.project([179 - 360, 70]);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 9);
    // ±180° keep their own edges of the world.
    expect(host.project([180, 40]).x).toBeGreaterThan(host.project([-180, 40]).x);
  });

  it('never returns NaN or |lat| > 90 from unproject, even far outside the world', () => {
    const host = new FakeGeoHost();
    // Ruling R3: at zoom 0 pixel [256, 0] is ≈ 79° map lat, above the pole line (≈ 65.54°).
    host.zoom = 0;
    installGeoApi(host, state(), factories);
    for (const p of [[256, 0], [0, 0], [511, 383], [256, -5000], [-9000, 192]]) {
      const ll = host.unproject(p);
      expect(Number.isFinite(ll.lng) && Number.isFinite(ll.lat)).toBe(true);
      expect(Math.abs(ll.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(ll.lng)).toBeLessThanOrEqual(180);
    }
    expect(host.unproject([256, 0]).lat).toBe(90); // above Equal Earth's pole line
  });

  it('getBounds covers the whole world at z0 and is tight at z4', () => {
    const host = new FakeGeoHost();
    host.zoom = 0;
    installGeoApi(host, state(), factories);
    expect(host.getBounds()).toEqual(new FakeLngLatBounds([-180, -90], [180, 90]));
    host.zoom = 4;
    host.center = new FakeLngLat(...geographicToMap(G, 0));
    const b = host.getBounds();
    const samples = [[0, 0], [256, 0], [511, 0], [511, 192], [511, 383], [256, 383], [0, 383], [0, 192]].map((p) => host.unproject(p));
    for (const s of samples) {
      expect(s.lng).toBeGreaterThanOrEqual(b.sw[0] - 1e-9);
      expect(s.lng).toBeLessThanOrEqual(b.ne[0] + 1e-9);
      expect(s.lat).toBeGreaterThanOrEqual(b.sw[1] - 1e-9);
      expect(s.lat).toBeLessThanOrEqual(b.ne[1] + 1e-9);
    }
    expect(Math.min(...samples.map((s) => s.lng))).toBeCloseTo(b.sw[0], 6); // tight: attained on the perimeter
    expect(Math.max(...samples.map((s) => s.lat))).toBeCloseTo(b.ne[1], 6);
  });

  it('getBounds falls back to the original corners when no transform is reachable', () => {
    const host = new FakeGeoHost();
    host.center = new FakeLngLat(...geographicToMap(G, 0));
    const raw = host.getBounds(); // the map-space box, before wrapping
    Object.defineProperty(host, 'transform', { value: undefined });
    installGeoApi(host, state(), factories);
    const b = host.getBounds();
    const [[w, s], [e, n]] = [raw.sw, raw.ne];
    const corners = ([[w, s], [e, s], [e, n], [w, n]] as LngLatTuple[]).map((c) => geographicUnder(c, 0));
    const lngs = corners.map((c) => c[0]);
    const lats = corners.map((c) => c[1]);
    expect(b).toEqual(new FakeLngLatBounds([Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]));
    expect(b).not.toEqual(raw);
    expect(Math.abs(b.sw[0] - raw.sw[0])).toBeGreaterThan(0.1); // the conversion moved it by far more than noise
  });

  it('uninstall restores the prototype methods', () => {
    const host = new FakeGeoHost();
    const api = installGeoApi(host, state(), factories);
    for (const name of ['jumpTo', 'easeTo', 'flyTo', 'setCenter', 'panTo', 'panBy', 'zoomTo', 'zoomIn', 'zoomOut', 'rotateTo', 'resetNorth', 'resetNorthPitch', 'snapToNorth', 'cameraForBounds', 'fitBounds']) {
      expect(Object.prototype.hasOwnProperty.call(host, name), name).toBe(true);
    }
    api.uninstall();
    for (const name of ['project', 'unproject', 'getCenter', 'getBounds', 'jumpTo', 'easeTo', 'flyTo', 'setCenter', 'panTo', 'panBy', 'zoomTo', 'zoomIn', 'zoomOut', 'rotateTo', 'resetNorth', 'resetNorthPitch', 'snapToNorth', 'cameraForBounds', 'fitBounds']) {
      expect(Object.prototype.hasOwnProperty.call(host, name), name).toBe(false);
    }
  });

  it("uninstall restores a v5 map's _cameraForBoxAndBearing", () => {
    const host = new FakeV5GeoHost();
    const api = installGeoApi(host, state(), factories);
    expect(Object.prototype.hasOwnProperty.call(host, '_cameraForBoxAndBearing')).toBe(true);
    api.uninstall();
    expect(Object.prototype.hasOwnProperty.call(host, '_cameraForBoxAndBearing')).toBe(false);
  });

  it('raw reads stay map space', () => {
    const host = new FakeGeoHost();
    host.center = new FakeLngLat(...geographicToMap(G, 0));
    const unwrapped = rawCamera(host); // captures what is there now, so before wrapping
    const api = installGeoApi(host, state(), factories);
    expect(api.raw.getCenter()).toEqual(host.center);
    expect(unwrapped.getCenter()).toEqual(host.center);
    api.raw.jumpTo({ center: new FakeLngLat(1, 2) });
    expect(host.center).toEqual(new FakeLngLat(1, 2));
  });

  it('reads the state live on every call', () => {
    const host = new FakeGeoHost();
    host.center = new FakeLngLat(...geographicToMap(G, 0));
    const live = { ...state(), active: false };
    installGeoApi(host, live, factories);
    expect(host.getCenter()).toEqual(host.center);
    live.active = true;
    expect(host.getCenter().lng).toBeCloseTo(G[0], 9);
  });
});

describe('geo-api helpers', () => {
  it('lngLatTuple reads arrays, {lng, lat} and {lon, lat}, and nothing else', () => {
    expect(lngLatTuple([1, 2])).toEqual([1, 2]);
    expect(lngLatTuple([1, 2, 300])).toEqual([1, 2]);
    expect(lngLatTuple({ lng: 1, lat: 2 })).toEqual([1, 2]);
    expect(lngLatTuple({ lon: 1, lat: 2 })).toEqual([1, 2]);
    expect(lngLatTuple(new FakeLngLat(1, 2))).toEqual([1, 2]);
    for (const bad of [undefined, null, 3, 'x', [1], [1, 2, 3, 4], [1, Number.NaN], { lng: 1 }, { lng: 'x', lat: 2 }, { x: 1, y: 2 }, [1, Infinity]]) {
      expect(lngLatTuple(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('lngLatTuple coerces with Number() as LngLat.convert does', () => {
    expect(lngLatTuple({ lng: '10', lat: '20' })).toEqual([10, 20]);
    expect(lngLatTuple({ lon: '10', lat: 20 })).toEqual([10, 20]);
    expect(lngLatTuple(['10', ' 20 '])).toEqual([10, 20]);
    expect(lngLatTuple({ lng: null, lat: 2 })).toEqual([0, 2]); // Number(null) = 0, as MapLibre reads it
  });

  it('mapSpaceOf keeps world copies, and leaves ±180° on their own edges', () => {
    const east = geographicToMap([180, 70], 0);
    expect(mapSpaceOf([180, 70], 0)).toEqual(east);
    expect(mapSpaceOf([-180, 70], 0)).toEqual(geographicToMap([-180, 70], 0));
    const copy = mapSpaceOf([170 + 720, 40], 0);
    expect(copy[0]).toBeCloseTo(geographicToMap([170, 40], 0)[0] + 720, 9);
    expect(copy[1]).toBeCloseTo(geographicToMap([170, 40], 0)[1], 12);
  });

  it('geographicUnder clamps into the band world and stays finite', () => {
    expect(geographicUnder([0, 89], 0)[1]).toBe(90);
    expect(geographicUnder([0, -89], 0)[1]).toBe(-90);
    expect(geographicUnder([179, mapSpaceMaxLatitude(0) * 0.95], 0)[0]).toBeCloseTo(180, 9);
    for (const blend of [0, 1 / 6, 0.5, 1]) {
      for (const p of [[0, 89.9], [-400, -89], [400, 0], [0, 0]] as LngLatTuple[]) {
        const [lng, lat] = geographicUnder(p, blend);
        expect(Number.isFinite(lng) && Number.isFinite(lat), `${blend} ${String(p)}`).toBe(true);
        expect(Math.abs(lat)).toBeLessThanOrEqual(90);
        expect(Math.abs(lng)).toBeLessThanOrEqual(180);
      }
    }
  });

  it('geographicBounds bisects the top of the visible ground under pitch', () => {
    const host = new FakeGeoHost();
    host.zoom = 4;
    host.center = new FakeLngLat(...geographicToMap(G, 0));
    const horizon = 100;
    const transform = {
      width: host.width,
      height: host.height,
      screenPointToLocation: (p: { x: number; y: number }) => host.transform.screenPointToLocation(p),
      isPointOnMapSurface: (p: { y: number }) => p.y > horizon,
    };
    const [, ne] = geographicBounds(transform, 0);
    const [, belowHorizon] = geographicBounds({ ...transform, isPointOnMapSurface: () => true }, 0);
    const atHorizon = geographicUnder(((p) => [p.lng, p.lat] as LngLatTuple)(host.unproject([256, horizon])), 0);
    expect(ne[1]).toBeCloseTo(atHorizon[1], 3);
    expect(ne[1]).toBeLessThan(belowHorizon[1]);
  });

  it('markMapSpace marks objects', () => {
    const value = { lng: 1, lat: 2 };
    expect(isMarkedMapSpace(value)).toBe(false);
    expect(markMapSpace(value)).toBe(value);
    expect(isMarkedMapSpace(value)).toBe(true);
    expect(isMarkedMapSpace(null)).toBe(false);
    expect(isMarkedMapSpace(3)).toBe(false);
  });
});

describe('geographic targets', () => {
  it('converts a jumpTo centre with the baseline band, on a copy, marked', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state({ blend: 0.5, baselineBlend: 0 }), factories);
    const options = { center: G, zoom: 5 };
    host.jumpTo(options);
    const passed = host.lastCall('jumpTo')[0] as { center: FakeLngLat; zoom: number };
    expect([passed.center.lng, passed.center.lat]).toEqual(geographicToMap(G, 0));
    expect(passed.zoom).toBe(5);
    expect(isMarkedMapSpace(passed.center)).toBe(true);
    expect(options.center).toBe(G); // caller's object untouched
  });

  it('stops before reading the baseline', () => {
    const host = new FakeGeoHost();
    const s = { ...state(), blend: 0.5, baselineBlend: 0.5 };
    host.onStop = () => { s.baselineBlend = 1; }; // the stop's moveend re-bases the camera
    installGeoApi(host, s, factories);
    host.easeTo({ center: G, duration: 0 });
    expect(host.calls.map((c) => c.name)).toEqual(['stop', 'easeTo']);
    const passed = host.lastCall('easeTo')[0] as { center: FakeLngLat };
    expect([passed.center.lng, passed.center.lat]).toEqual(geographicToMap(G, 1));
  });

  it('does not stop or copy when nothing needs converting, nor with an easeId', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const zoomOnly = { zoom: 4 };
    host.easeTo(zoomOnly);
    expect(host.lastCall('easeTo')[0]).toBe(zoomOnly);
    host.easeTo({ center: G, easeId: 'keyboardHandler' });
    expect(host.calls.filter((c) => c.name === 'stop')).toHaveLength(0);
    const passed = host.lastCall('easeTo')[0] as { center: FakeLngLat };
    expect([passed.center.lng, passed.center.lat]).toEqual(geographicToMap(G, 0)); // converted all the same
  });

  it('passes T.center, R.center and marked values through by identity', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const t = host.transform.center;
    host.easeTo({ center: t });
    expect((host.lastCall('easeTo')[0] as { center: unknown }).center).toBe(t);
    host._requestedCameraState = { center: new FakeLngLat(1, 2) };
    host.easeTo({ center: host._requestedCameraState.center });
    expect((host.lastCall('easeTo')[0] as { center: unknown }).center).toBe(host._requestedCameraState.center);
    const marked = markMapSpace(new FakeLngLat(3, 4));
    host.jumpTo({ center: marked });
    expect((host.lastCall('jumpTo')[0] as { center: unknown }).center).toBe(marked);
    expect(host.calls.filter((c) => c.name === 'stop')).toHaveLength(0);
    // Identity, not numeric equality: an equal copy of T's centre is a geographic value.
    host.easeTo({ center: { lng: host.center.lng, lat: host.center.lat } });
    expect(isMarkedMapSpace((host.lastCall('easeTo')[0] as { center: unknown }).center)).toBe(true);
  });

  it('reads T and R from the Camera on v6 (`_camera.transform`, `_camera._requestedCameraState`)', () => {
    const host = new FakeGeoHost();
    const t = new FakeLngLat(5, 6);
    const r = new FakeLngLat(7, 8);
    Object.defineProperty(host, '_camera', { value: { transform: { center: t }, _requestedCameraState: { center: r } } });
    installGeoApi(host, state(), factories);
    host.easeTo({ center: t, around: r });
    const passed = host.lastCall('easeTo')[0] as { center: unknown; around: unknown };
    expect(passed.center).toBe(t);
    expect(passed.around).toBe(r);
  });

  it('converts a mixed inertia call per value: centre is T, around is geographic', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    host.easeTo({ center: host.transform.center, around: G });
    const passed = host.lastCall('easeTo')[0] as { center: unknown; around: FakeLngLat };
    expect(passed.center).toBe(host.transform.center);
    expect([passed.around.lng, passed.around.lat]).toEqual(geographicToMap(G, 0));
  });

  it('round-trips the inertia `around` MapLibre reads through the wrapped getCenter (audit B3)', () => {
    // The HandlerManager's inertial ease takes `around` from the wrapped `getCenter()` or
    // `unproject()`, so geographic; easeTo must read it back into the map space it came from.
    const host = new FakeGeoHost();
    host.center = new FakeLngLat(...geographicToMap(G, 0));
    installGeoApi(host, state(), factories);
    const around = host.getCenter();
    host.easeTo({ center: host.transform.center, around, bearing: 30, noMoveStart: true });
    const passed = host.lastCall('easeTo')[0] as { center: unknown; around: FakeLngLat };
    expect(passed.center).toBe(host.transform.center);
    expect(passed.around.lng).toBeCloseTo(host.center.lng, 9);
    expect(passed.around.lat).toBeCloseTo(host.center.lat, 9);
    const pointer = host.unproject([400, 100]);
    const expected = host.transform.screenPointToLocation({ x: 400, y: 100 }); // before the fake applies the zoom
    host.easeTo({ center: host.transform.center, around: pointer, zoom: 4 });
    const second = host.lastCall('easeTo')[0] as { around: FakeLngLat };
    expect(second.around.lng).toBeCloseTo(expected.lng, 9);
    expect(second.around.lat).toBeCloseTo(expected.lat, 9);
  });

  it('converts string coordinates in a target as MapLibre reads them', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    host.jumpTo({ center: { lng: String(G[0]), lat: String(G[1]) } });
    const passed = host.lastCall('jumpTo')[0] as { center: FakeLngLat };
    expect([passed.center.lng, passed.center.lat]).toEqual(geographicToMap(G, 0));
  });

  it('converts once through v5-style nested calls', () => {
    const host = new FakeV5GeoHost();
    installGeoApi(host, state(), factories);
    host.setCenter(G);
    const passed = host.lastCall('jumpTo')[0] as { center: FakeLngLat };
    expect([passed.center.lng, passed.center.lat]).toEqual(geographicToMap(G, 0));
    host.panBy([100, 0]);
    expect(host.lastCall('panTo')[0]).toBe(host.transform.center);
    expect(host.calls.filter((c) => c.name === 'stop')).toHaveLength(1); // setCenter's only
  });

  it('panTo converts its position and options.around with one stop', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const options = { around: [10, 20], duration: 0 };
    host.panTo(G, options);
    const [lngLat, passedOptions] = host.lastCall('panTo') as [FakeLngLat, { around: FakeLngLat; duration: number }];
    expect([lngLat.lng, lngLat.lat]).toEqual(geographicToMap(G, 0));
    expect([passedOptions.around.lng, passedOptions.around.lat]).toEqual(geographicToMap([10, 20], 0));
    expect(passedOptions.duration).toBe(0);
    expect(options.around).toEqual([10, 20]);
    expect(host.calls.map((c) => c.name)).toEqual(['stop', 'panTo']);
  });

  it.each(['zoomTo', 'rotateTo'] as const)('%s converts options.around', (name) => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    host[name](5, { around: G });
    const passed = host.lastCall(name)[1] as { around: FakeLngLat };
    expect([passed.around.lng, passed.around.lat]).toEqual(geographicToMap(G, 0));
  });

  it.each(['zoomIn', 'zoomOut', 'resetNorth', 'resetNorthPitch', 'snapToNorth'] as const)('%s converts options.around', (name) => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    host[name]({ around: G });
    const passed = host.lastCall(name)[0] as { around: FakeLngLat };
    expect([passed.around.lng, passed.around.lat]).toEqual(geographicToMap(G, 0));
  });

  it('panBy converts options.around and options.center (v6 reaches Camera.easeTo directly)', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    host.panBy([10, 0], { around: G });
    const passed = host.lastCall('panBy')[1] as { around: FakeLngLat };
    expect([passed.around.lng, passed.around.lat]).toEqual(geographicToMap(G, 0));
  });

  it('marks what the TransformProvider hands the handlers, once per prototype', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const proto = Object.getPrototypeOf(host.keyboard._tr) as object;
    const unproject = Object.getOwnPropertyDescriptor(proto, 'unproject');
    const center = Object.getOwnPropertyDescriptor(proto, 'center');
    installGeoApi(new FakeGeoHost(), state(), factories); // second map, same prototype
    // Not patched again: a second patch would wrap the first (and a third the second, …).
    expect(Object.getOwnPropertyDescriptor(proto, 'unproject')).toEqual(unproject); // functions compare by identity
    expect(Object.getOwnPropertyDescriptor(proto, 'center')).toEqual(center);
    expect(isMarkedMapSpace(host.keyboard._tr.unproject([1, 2]))).toBe(true);
    expect(isMarkedMapSpace(host.keyboard._tr.center)).toBe(true);
    host.easeTo({ around: host.keyboard._tr.unproject([1, 2]) });
    expect(host.calls.filter((c) => c.name === 'stop')).toHaveLength(0);
    // Marked once: the provider still answers in plain map space.
    const p = host.keyboard._tr.unproject([100, 50]);
    const t = host.transform.screenPointToLocation({ x: 100, y: 50 });
    expect([p.lng, p.lat]).toEqual([t.lng, t.lat]);
  });

  it("marks the v5 box zoom's camera centre (_cameraForBoxAndBearing, audit B6)", () => {
    const host = new FakeV5GeoHost();
    const fresh = new FakeLngLat(1, 2);
    Object.defineProperty(host, '_cameraForBoxAndBearing', { value: () => ({ center: fresh, zoom: 4, bearing: 0 }), writable: true, configurable: true });
    installGeoApi(host, state(), factories);
    const result = (host as unknown as { _cameraForBoxAndBearing(): { center: FakeLngLat } })._cameraForBoxAndBearing();
    expect(result.center).toBe(fresh);
    expect(isMarkedMapSpace(fresh)).toBe(true);
  });

  it('passes every target straight through while inactive', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state({ active: false }), factories);
    const options = { center: G };
    host.flyTo(options);
    expect(host.lastCall('flyTo')[0]).toBe(options);
    host.panTo(G);
    expect(host.lastCall('panTo')[0]).toBe(G);
    host.fitBounds([[5, 45], [11, 48]]);
    expect(host.lastCall('fitBounds')[0]).toEqual([[5, 45], [11, 48]]);
    expect(host.calls.filter((c) => c.name === 'stop')).toHaveLength(0);
  });
});

describe('TransformProvider not found', () => {
  it('warns once and passes through easeTo calls a DOM event drove', async () => {
    vi.resetModules();
    const fresh = await import('../src/map/geo-api.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const host = new FakeGeoHost();
      Object.defineProperty(host, 'keyboard', { value: undefined });
      fresh.installGeoApi(host, state(), factories);
      const other = new FakeGeoHost();
      Object.defineProperty(other, 'keyboard', { value: undefined });
      fresh.installGeoApi(other, state(), factories);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('could not find MapLibre');
      const handlerAround = { lng: 1, lat: 2 };
      host.easeTo({ around: handlerAround }, { originalEvent: new Event('dblclick') });
      expect((host.lastCall('easeTo')[0] as { around: unknown }).around).toBe(handlerAround);
      host.easeTo({ around: G });
      const converted = (host.lastCall('easeTo')[0] as { around: FakeLngLat }).around;
      expect([converted.lng, converted.lat]).toEqual(geographicToMap(G, 0));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('fitAcrossBands', () => {
  const SIX = resolveTransition();
  const bands = SIX.bands;

  /** A fit whose zoom grows as the bbox shrinks, plus a per-band bias; band k is the k-th call. */
  const fitWith = (bias: (band: number) => number): BandFit => {
    let call = 0;
    return (sw, ne) => {
      const band = call++;
      return { center: { lng: (sw[0] + ne[0]) / 2, lat: (sw[1] + ne[1]) / 2 }, zoom: Math.log2(360 / (ne[0] - sw[0])) + bias(band), bearing: 0 };
    };
  };
  /** A fit returning a fixed zoom per band. */
  const fixedZoom = (zoomOf: (band: number) => number): BandFit => {
    let call = 0;
    return (sw, ne) => {
      const band = call++;
      return { center: { lng: (sw[0] + ne[0]) / 2, lat: (sw[1] + ne[1]) / 2 }, zoom: zoomOf(band), bearing: 0 };
    };
  };

  it("calls the fit once per band, with the band's map-space bbox", () => {
    const boxes: [LngLatTuple, LngLatTuple][] = [];
    fitAcrossBands([[5, 45], [11, 48]], bands, (sw, ne) => {
      boxes.push([sw, ne]);
      return undefined;
    });
    expect(boxes).toHaveLength(bands.length);
    for (const [k, [sw, ne]] of boxes.entries()) {
      const blend = bands[k]!.blend;
      // The boundary's image: its bbox holds every corner's image, and the corners at 45°/48° attain it.
      for (const corner of [[5, 45], [11, 45], [11, 48], [5, 48]] as LngLatTuple[]) {
        const [x, y] = geographicToMap(corner, blend);
        expect(x).toBeGreaterThanOrEqual(sw[0] - 1e-9);
        expect(x).toBeLessThanOrEqual(ne[0] + 1e-9);
        expect(y).toBeGreaterThanOrEqual(sw[1] - 1e-9);
        expect(y).toBeLessThanOrEqual(ne[1] + 1e-9);
      }
      expect(ne[1]).toBeCloseTo(geographicToMap([5, 48], blend)[1], 9);
      expect(sw[1]).toBeCloseTo(geographicToMap([5, 45], blend)[1], 9);
    }
  });

  it('picks the band its own fit zoom falls in', () => {
    const r = fitAcrossBands([[5, 45], [11, 48]], bands, fitWith(() => 0));
    expect(r).toBeDefined();
    expect(bandIndexForZoom(bands, r!.zoom)).toBe(r!.band);
  });

  it('takes the highest zoom among several fixed points', () => {
    // Band 1 at 4.5 and band 3 at 6.0 are both fixed points; the rest are not.
    const r = fitAcrossBands([[5, 45], [11, 48]], bands, fixedZoom((k) => (k === 1 ? 4.5 : k === 3 ? 6.0 : k < 1 ? 10 : 1)));
    expect(r!.band).toBe(3);
    expect(r!.zoom).toBe(6);
  });

  it('resolves a 2-cycle at a boundary to the lower band just below it', () => {
    // Band 1's zoom is above the 1/2 boundary β and band 2's below it; the others point past both.
    const beta = bands[2]!.minZoom;
    const r = fitAcrossBands([[5, 45], [11, 48]], bands, fixedZoom((k) => (k === 1 ? beta + 0.1 : k === 2 ? beta - 0.1 : k < 1 ? beta + 0.1 : beta - 0.1)));
    expect(r!.band).toBe(1);
    expect(r!.zoom).toBeCloseTo(beta - 1e-6, 9);
    expect(bandIndexForZoom(bands, r!.zoom)).toBe(1);
  });

  it('returns the geographic point under the fitted centre', () => {
    const fits: { lng: number; lat: number }[] = [];
    const inner = fitWith(() => 0);
    const r = fitAcrossBands([[5, 45], [11, 48]], bands, (sw, ne) => {
      const fit = inner(sw, ne);
      fits.push(fit!.center);
      return fit;
    })!;
    const k = r.band;
    const expected = mapToGeographic([fits[k]!.lng, fits[k]!.lat], bands[k]!.blend);
    expect(r.center[0]).toBeCloseTo(expected[0], 9);
    expect(r.center[1]).toBeCloseTo(expected[1], 6);
    expect(r.center[0]).toBeGreaterThan(5);
    expect(r.center[0]).toBeLessThan(11);
  });

  it('splits bounds that cross the antimeridian', () => {
    const r = fitAcrossBands([[170, -20], [-170, 20]], bands, fitWith(() => 0))!;
    expect(r.zoom).toBeLessThan(1); // near full width in a single-copy world
    const plain = fitAcrossBands([[170, -20], [180, 20]], bands, fitWith(() => 0))!;
    expect(plain.zoom).toBeGreaterThan(3);
  });

  it('keeps the Mercator band finite at the poles', () => {
    const boxes: [LngLatTuple, LngLatTuple][] = [];
    fitAcrossBands([[-10, 80], [10, 90]], bands, (sw, ne) => {
      boxes.push([sw, ne]);
      return undefined;
    });
    for (const [k, [sw, ne]] of boxes.entries()) {
      expect(Number.isFinite(sw[1]) && Number.isFinite(ne[1]), String(k)).toBe(true);
      expect(ne[1]).toBeLessThanOrEqual(mapSpaceMaxLatitude(bands[k]!.blend) + 1e-12);
    }
  });

  it('returns undefined when no band can be fitted', () => {
    expect(fitAcrossBands([[5, 45], [11, 48]], bands, () => undefined)).toBeUndefined();
  });
});

describe('fitBounds and cameraForBounds', () => {
  it('fits through the wrapped flyTo with a geographic centre, never the original fitBounds', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    host.fitBounds([[5, 45], [11, 48]], { padding: 20 });
    expect(host.calls.some((c) => c.name === 'fitBounds')).toBe(false);
    const fly = host.lastCall('flyTo')[0] as Record<string, unknown>;
    expect('padding' in fly).toBe(false);
    expect(isMarkedMapSpace(fly['center'])).toBe(true); // converted by the flyTo wrapper
    host.fitBounds([[5, 45], [11, 48]], { linear: true });
    expect(host.calls.at(-1)!.name).toBe('easeTo');
  });

  it('accepts LngLatBounds, [[w, s], [e, n]] and [w, s, e, n]', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const a = host.cameraForBounds([[5, 45], [11, 48]])!;
    const b = host.cameraForBounds([5, 45, 11, 48])!;
    const c = host.cameraForBounds({ getSouthWest: () => ({ lng: 5, lat: 45 }), getNorthEast: () => ({ lng: 11, lat: 48 }) })!;
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('cameraForBounds returns a geographic centre that jumpTo lands on', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const cam = host.cameraForBounds([[5, 45], [11, 48]])!;
    expect(isMarkedMapSpace(cam.center)).toBe(false);
    host.jumpTo(cam);
    const c = host.getCenter();
    expect(c.lng).toBeCloseTo(cam.center.lng, 9);
    expect(c.lat).toBeCloseTo(cam.center.lat, 9);
  });

  it('fitBounds does nothing when the bounds cannot be fitted', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    expect(host.fitBounds([[5, 45], [11, 48]], { padding: 1000 })).toBe(host);
    // As MapLibre's `_fitInternal`: no fit, no stop (a running animation goes on).
    expect(host.calls.filter((c) => ['flyTo', 'easeTo', 'stop'].includes(c.name))).toHaveLength(0);
  });

  it('a cameraForBounds result taken under Mercator is converted once Equal Earth is active (v5)', () => {
    const host = new FakeV5GeoHost();
    const live = { ...state(), active: false };
    installGeoApi(host, live, factories);
    const cam = host.cameraForBounds([[5, 45], [11, 48]])!; // Mercator: MapLibre's own fit, geographic
    expect(host.calls.some((c) => c.name === '_cameraForBoxAndBearing')).toBe(true);
    live.active = true; // setProjection({ type: 'equal' })
    host.flyTo(cam);
    const passed = host.lastCall('flyTo')[0] as { center: FakeLngLat };
    const expected = geographicToMap([cam.center.lng, cam.center.lat], 0);
    expect(passed.center.lng).toBeCloseTo(expected[0], 9);
    expect(passed.center.lat).toBeCloseTo(expected[1], 9);
  });

  it('a target beyond ±180° lands on its place in the one world', () => {
    const host = new FakeGeoHost();
    host.zoom = 6;
    installGeoApi(host, state(), factories);
    host.jumpTo({ center: [190, 10] });
    const c = host.getCenter();
    expect(c.lng).toBeCloseTo(-170, 9);
    expect(c.lat).toBeCloseTo(10, 9);
    host.panTo([-200, 10], { around: [-190, 5] });
    const [lngLat, options] = host.lastCall('panTo') as [FakeLngLat, { around: FakeLngLat }];
    expect([lngLat.lng, lngLat.lat]).toEqual(geographicToMap([160, 10], 0));
    expect([options.around.lng, options.around.lat]).toEqual(geographicToMap([170, 5], 0));
  });
});

describe('compensation-aware fit (Ruling R11)', () => {
  type Offsets = { deltaZoom: number; deltaBearing: number };
  const BOUNDS: [LngLatTuple, LngLatTuple] = [[5, 45], [11, 48]];
  // Fake compensation: offsets that vary with the place, the band and the requested zoom.
  const fakeOffsets = (geographic: LngLatTuple, band: number, requestedZoom: number): Offsets => ({
    deltaZoom: 0.05 + 0.01 * requestedZoom + 0.002 * band,
    deltaBearing: 2 + 0.1 * geographic[1],
  });
  /** What the camera hook renders for a request (camera.ts `handleCameraUpdate`). */
  const render = (request: { zoom: number; bearing: number }, centre: LngLatTuple, band: number, baseline: Offsets, offsets = fakeOffsets) => {
    const requestedZoom = request.zoom - baseline.deltaZoom;
    const o = offsets(centre, band, requestedZoom);
    return { zoom: requestedZoom + o.deltaZoom, bearing: request.bearing - baseline.deltaBearing + o.deltaBearing };
  };

  it('cameraForBounds returns the request the hook renders as exactly the fit', () => {
    const plain = new FakeGeoHost();
    installGeoApi(plain, state(), factories);
    const fit = plain.cameraForBounds(BOUNDS, { bearing: 10 })!; // no compensation: the fit itself
    const baseline = { deltaZoom: 0.03, deltaBearing: 1.5 };
    const host = new FakeGeoHost();
    installGeoApi(host, state({ baselineOffsets: baseline, offsets: fakeOffsets }), factories);
    const cam = host.cameraForBounds(BOUNDS, { bearing: 10 })!;
    expect(cam.center).toEqual(fit.center);
    expect(cam.zoom).not.toBeCloseTo(fit.zoom, 3);
    const rendered = render(cam, [cam.center.lng, cam.center.lat], 0, baseline);
    expect(rendered.zoom).toBeCloseTo(fit.zoom, 7); // the solve stops at a 1e-6 step
    expect(rendered.bearing).toBeCloseTo(10, 9);
  });

  it('fitBounds fits once when its stop changes nothing', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state({ offsets: fakeOffsets }), factories);
    host.fitBounds(BOUNDS, { padding: 20 });
    expect(host.calls.filter((c) => c.name === 'cameraForBounds')).toHaveLength(1);
    expect(host.calls[1]!.name).toBe('stop');
  });

  it('fitBounds fits again when its stop re-based the camera', () => {
    const plain = new FakeGeoHost();
    installGeoApi(plain, state(), factories);
    const fit = plain.cameraForBounds(BOUNDS, { padding: 20 })!;
    const host = new FakeGeoHost();
    const s = { ...state({ offsets: fakeOffsets }), baselineOffsets: { deltaZoom: 0.2, deltaBearing: 5 } };
    host.onStop = () => { s.baselineOffsets = { deltaZoom: 0.04, deltaBearing: -1 }; }; // the stop re-bases
    installGeoApi(host, s, factories);
    host.fitBounds(BOUNDS, { padding: 20 });
    // Fit, stop (which re-bases), fit again against the new baseline, then fly.
    expect(host.calls.slice(0, 3).map((c) => c.name)).toEqual(['cameraForBounds', 'stop', 'cameraForBounds']);
    const fly = host.lastCall('flyTo')[0] as { zoom: number; bearing: number };
    const centre: LngLatTuple = [fit.center.lng, fit.center.lat];
    const rendered = render(fly, centre, 0, s.baselineOffsets);
    expect(rendered.zoom).toBeCloseTo(fit.zoom, 7); // the solve stops at a 1e-6 step
    expect(rendered.bearing).toBeCloseTo(0, 9);
  });

  describe('fitAcrossBands near a band boundary', () => {
    const SIX = resolveTransition();
    const bands = SIX.bands;
    const beta = bands[2]!.minZoom;
    const fixedFits = (zoomOf: (band: number) => number): BandFit => {
      let call = 0;
      return (sw, ne) => {
        const band = call++;
        return { center: { lng: (sw[0] + ne[0]) / 2, lat: (sw[1] + ne[1]) / 2 }, zoom: zoomOf(band), bearing: 0 };
      };
    };
    /** Inside the padding: band k rendered at the returned request is no further in than band k's fit. */
    const check = (zk: (band: number) => number, offsets: (band: number) => number) => {
      const r = fitAcrossBands(BOUNDS, bands, fixedFits(zk), (_g, band) => ({ deltaZoom: offsets(band), deltaBearing: 0 }))!;
      expect(r).toBeDefined();
      expect(Number.isFinite(r.zoom) && Number.isFinite(r.center[0]) && Number.isFinite(r.center[1])).toBe(true);
      expect(bandIndexForZoom(bands, r.zoom)).toBe(r.band); // the band the hook renders the request in
      const rendered = r.zoom + offsets(r.band);
      expect(rendered).toBeLessThanOrEqual(zk(r.band) + 1e-9);
      return { ...r, rendered };
    };

    it('a positive offset moves the request below the boundary: the lower band, rendering the fit', () => {
      const r = check(() => beta + 0.03, () => 0.07);
      expect(r.band).toBe(1);
      expect(r.zoom).toBeCloseTo(beta - 0.04, 9);
      expect(r.rendered).toBeCloseTo(beta + 0.03, 9);
    });

    it('a negative offset keeps it above: the upper band, rendering the fit', () => {
      const r = check(() => beta - 0.03, () => -0.07);
      expect(r.band).toBe(2);
      expect(r.rendered).toBeCloseTo(beta - 0.03, 9);
    });

    it('a correction that crosses the boundary both ways resolves as a 2-cycle, inside the padding', () => {
      // Band 1's request stays above β, band 2's falls below it.
      const r = check(() => beta + 0.03, (band) => (band === 1 ? 0.01 : band === 2 ? 0.05 : 0));
      expect(r.band).toBe(1);
      expect(r.zoom).toBeCloseTo(beta - 1e-6, 9);
    });
  });
});
