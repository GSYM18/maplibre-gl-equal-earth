/**
 * The controller's native Equal Earth (spec 2026-11-07 §5): pure `equal-earth` drawn by
 * MapLibre's registered projection, on the fake host that models the style diff.
 */
import { describe, expect, it, vi } from 'vitest';

import { EqualEarthController } from '../src/map/controller.js';
import { REWRITTEN_METADATA_KEY, type StyleLike } from '../src/map/style-rewrite.js';
import { geographicToMap } from '../src/math/backproject.js';
import { EQUAL_EARTH_CRS_NAME } from '../src/math/crs.js';
import { FakeControllerHost, FakeImageSource } from './support/fake-maplibre.js';

const TILEJSON = { tiles: ['https://tiles.example/planet/{z}/{x}/{y}.pbf'], maxzoom: 14 };
const lngLatFactory = (lng: number, lat: number) => ({ lng, lat });
const lngLatBoundsFactory = (sw: [number, number], ne: [number, number]) => ({ sw, ne });
const TOKYO: [number, number] = [139.69, 35.69];
const ROUTE: GeoJSON.Feature = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [[100, -80], [100, 80]] },
};
const CORNERS = [[-10, 50], [10, 50], [10, 40], [-10, 40]];

function style(): StyleLike {
  return {
    version: 8,
    sources: {
      openmaptiles: { type: 'vector', url: 'https://tiles.example/planet' },
      route: { type: 'geojson', data: ROUTE },
      overlay: { type: 'image', url: 'https://example.com/overlay.png', coordinates: CORNERS },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#eee' } },
      { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
      { id: 'route', type: 'line', source: 'route' },
      { id: 'overlay', type: 'raster', source: 'overlay' },
    ],
  };
}

function setup(nativeProjection: string | null = EQUAL_EARTH_CRS_NAME, zoom = 2) {
  const host = new FakeControllerHost(TOKYO, zoom);
  host.style = style();
  const controller = new EqualEarthController(host, {
    lngLatFactory,
    lngLatBoundsFactory,
    fetchJson: vi.fn(async () => TILEJSON),
    ...(nativeProjection === null ? {} : { nativeProjection }),
  });
  return { host, controller };
}

describe('EqualEarthController, native Equal Earth', () => {
  it('names the registered projection and keeps the centre geographic', async () => {
    const { host, controller } = setup();
    await controller.activate('equal-earth');
    expect(controller.native).toBe(true);
    expect(host.style!['projection']).toEqual({ type: EQUAL_EARTH_CRS_NAME });
    expect(host.style!.metadata![REWRITTEN_METADATA_KEY]).toBeDefined();
    expect(host.center.lng).toBeCloseTo(TOKYO[0], 12);
    expect(host.center.lat).toBeCloseTo(TOKYO[1], 12);
    // The same tiles as banded pure Equal Earth: the registered grid is the blend-0 map space.
    expect(host.style!.sources['openmaptiles__b0']).toMatchObject({ type: 'vector' });
  });

  it('keeps GeoJSON copies and cartography geographic (MapLibre projects them)', async () => {
    const { host, controller } = setup();
    await controller.activate('equal-earth');
    const copy = host.style!.sources['route__b0']!['data'] as GeoJSON.FeatureCollection<GeoJSON.LineString>;
    expect(copy.features[0]!.geometry.coordinates.every(([lng]) => lng === 100)).toBe(true);
    const world = host.style!.sources['equal-earth:world__b0']!['data'] as GeoJSON.Feature<GeoJSON.Polygon>;
    expect(world.geometry.coordinates[0]).toContainEqual([180, 0]);
  });

  it('installs no world clamp, and its conversions are the identity', async () => {
    const { host, controller } = setup();
    await controller.activate('equal-earth');
    expect(host.constrain).toBeNull();
    expect(controller.toMapSpace([8.54, 47.37])).toEqual([8.54, 47.37]);
    expect(controller.toGeographic([8.54, 47.37])).toEqual([8.54, 47.37]);
  });

  it('follows setData into the copy geographically', async () => {
    const { host, controller } = setup();
    await controller.activate('equal-earth');
    const next: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [8.54, 47.37] } };
    (host.getSource('route') as { setData(data: unknown): void }).setData(next);
    const copy = host.geojsonSource('route__b0').argsOf('setData').at(-1) as GeoJSON.FeatureCollection<GeoJSON.Point>;
    expect(copy.features[0]!.geometry.coordinates).toEqual([8.54, 47.37]);
  });

  it('re-places the sources a diff across the projection keeps unchanged, on activation and restore', async () => {
    const { host, controller } = setup();
    const route = host.geojsonSource('route');
    const overlay = host.getSource('overlay') as FakeImageSource;
    await controller.activate('equal-earth');
    // Kept by the diff (the rewrite keeps the original sources): placed again under the CRS.
    expect(route.argsOf('setData')).toEqual([ROUTE]);
    expect(overlay.coordinateCalls).toEqual([CORNERS]);
    await controller.deactivate();
    expect(host.style!['projection']).toBeUndefined();
    expect(route.argsOf('setData')).toEqual([ROUTE, ROUTE]);
    expect(overlay.coordinateCalls).toEqual([CORNERS, CORNERS]);
    expect(host.center.lng).toBeCloseTo(TOKYO[0], 12);
    expect(controller.native).toBe(false);
  });

  it('does not re-place anything for an amend, which stays native', async () => {
    const { host, controller } = setup();
    await controller.activate('equal-earth');
    const route = host.geojsonSource('route');
    const calls = route.argsOf('setData').length;
    host.addLayer({ id: 'route-2', type: 'line', source: 'route' });
    await vi.waitFor(() => expect(host.style!.layers.some((l) => l.id === 'route-2__b0')).toBe(true));
    expect(route.argsOf('setData')).toHaveLength(calls);
  });

  it("swallows the projectiontransition MapLibre fires inside the plugin's own setStyle", async () => {
    const { host, controller } = setup();
    const heard = vi.fn();
    host.on('projectiontransition', heard);
    await controller.activate('equal-earth');
    await controller.deactivate();
    expect(heard).not.toHaveBeenCalled();
  });

  it('switches to the banded equal and back', async () => {
    const { host, controller } = setup(EQUAL_EARTH_CRS_NAME, 4.6);
    await controller.activate('equal-earth');
    await controller.activate('equal');
    expect(controller.native).toBe(false);
    expect(host.style!['projection']).toEqual({ type: 'mercator' });
    // z4.6 is band 1 of the default transition: the centre is in that band's map space.
    const expected = geographicToMap(TOKYO, 1 / 6);
    expect(host.center.lng).toBeCloseTo(expected[0], 9);
    expect(host.constrain).not.toBeNull();
    await controller.activate('equal-earth');
    expect(controller.native).toBe(true);
    expect(host.center.lng).toBeCloseTo(TOKYO[0], 9);
    expect(host.center.lat).toBeCloseTo(TOKYO[1], 9);
    expect(host.constrain).toBeNull();
  });

  it('re-applies natively after the application sets a style of its own', async () => {
    const { host, controller } = setup();
    await controller.activate('equal-earth');
    const replacement = style();
    replacement.layers = replacement.layers.filter((l) => l.id !== 'overlay');
    host.setStyle(replacement, {});
    await vi.waitFor(() => expect(host.style!['projection']).toEqual({ type: EQUAL_EARTH_CRS_NAME }));
    expect(host.style!.layers.some((l) => l.id === 'overlay')).toBe(false);
    expect(controller.native).toBe(true);
  });

  it('stays banded without a registered projection', async () => {
    const { host, controller } = setup(null);
    await controller.activate('equal-earth');
    expect(controller.native).toBe(false);
    expect(host.style!['projection']).toEqual({ type: 'mercator' });
    expect(host.constrain).not.toBeNull();
  });

  it('reports blend 1 while native, so geographicUnder(·, blend) leaves positions alone', async () => {
    const { controller } = setup();
    await controller.activate('equal-earth');
    expect(controller.blend).toBe(1);
    expect(controller.baselineBlend).toBe(1);
  });

  it('converts with the banded view until the native style is live (a wait for the application’s style URL)', async () => {
    const { host, controller } = setup(EQUAL_EARTH_CRS_NAME, 4.6);
    await controller.activate('equal');
    // The application's style URL is still fetching: the switch commits, then waits for it (R20).
    host.setStyle('https://example.com/style.json');
    const pending = controller.activate('equal-earth');
    await vi.waitFor(() => expect(controller.projection).toBe('equal-earth'));
    expect(host.style!['projection']).toEqual({ type: 'mercator' }); // still the banded rewrite
    expect(controller.blend).toBeCloseTo(1 / 6, 12);
    const geographic = controller.toGeographic([host.center.lng, host.center.lat]);
    expect(geographic[0]).toBeCloseTo(TOKYO[0], 9);
    expect(geographic[1]).toBeCloseTo(TOKYO[1], 9);
    host.failStyleRequest();
    await pending;
    expect(controller.blend).toBe(1);
    expect(host.center.lng).toBeCloseTo(TOKYO[0], 9);
  });

  it('delivers the projectiontransition of a banded re-apply, which crosses nothing native', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const heard = vi.fn();
    host.on('projectiontransition', heard);
    const globe = style();
    globe['projection'] = { type: 'globe' };
    host.setStyle(globe, {}); // the application's own: its diff fires one, then our re-apply another
    await vi.waitFor(() => expect(host.style!['projection']).toEqual({ type: 'mercator' }));
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
