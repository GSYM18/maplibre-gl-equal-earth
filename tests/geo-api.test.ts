import { describe, expect, it } from 'vitest';

import { EQUAL_EARTH_BANDS } from '../src/map/bands.js';
import {
  geographicBounds,
  geographicUnder,
  installGeoApi,
  isMarkedMapSpace,
  lngLatTuple,
  mapSpaceOf,
  markMapSpace,
  rawCamera,
  type GeoApiState,
  type LngLatTuple,
} from '../src/map/geo-api.js';
import { geographicToMap, mapSpaceMaxLatitude } from '../src/math/backproject.js';
import { FakeGeoHost, FakeLngLat, FakeLngLatBounds } from './support/fake-geo-host.js';

const G: LngLatTuple = [-103.35, 20.67]; // Guadalajara
const state = (over: Partial<GeoApiState> = {}): GeoApiState => ({ active: true, blend: 0, baselineBlend: 0, bands: EQUAL_EARTH_BANDS, ...over });
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
    Object.defineProperty(host, 'transform', { value: undefined });
    installGeoApi(host, state(), factories);
    const b = host.getBounds();
    expect(b.sw[0]).toBeLessThan(G[0]);
    expect(b.ne[0]).toBeGreaterThan(G[0]);
    expect(b.sw[1]).toBeLessThan(G[1]);
    expect(b.ne[1]).toBeGreaterThan(G[1]);
  });

  it('uninstall restores the prototype methods', () => {
    const host = new FakeGeoHost();
    const api = installGeoApi(host, state(), factories);
    api.uninstall();
    for (const name of ['project', 'unproject', 'getCenter', 'getBounds']) {
      expect(Object.prototype.hasOwnProperty.call(host, name), name).toBe(false);
    }
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
    expect(lngLatTuple({ lng: 1, lat: 2 })).toEqual([1, 2]);
    expect(lngLatTuple({ lon: 1, lat: 2 })).toEqual([1, 2]);
    expect(lngLatTuple(new FakeLngLat(1, 2))).toEqual([1, 2]);
    for (const bad of [undefined, null, 3, 'x', [1], [1, Number.NaN], { lng: 1 }, { lng: '1', lat: 2 }, { x: 1, y: 2 }]) {
      expect(lngLatTuple(bad), JSON.stringify(bad)).toBeUndefined();
    }
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
