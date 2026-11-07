/**
 * Native Equal Earth (spec 2026-11-07): on MapLibre 6.16 the plugin registers Equal Earth with
 * `addProjection`, and pure `equal-earth` is drawn by MapLibre's own projection from the warped
 * tiles. Runs only in the `v6-native` project (MapLibre 6.16.0 from unpkg).
 */
import type { Page } from '@playwright/test';

import { expect, idle, openHarness, pixelOf, test } from './helpers.ts';

/** The fixture's places (`fixture-tiles.ts`); the harness's `cities` GeoJSON has them too. */
const PLACES: [number, number][] = [[8.54, 47.37], [139.69, 35.69], [-122.42, 37.77], [-149.9, 61.22], [103.82, 1.35]];

/** Largest distance in CSS pixels between `map.project` and the Equal Earth maths, over `PLACES`. */
async function projectError(page: Page): Promise<number> {
  return page.evaluate((places) => {
    const { map, math } = window.__h;
    const world = ([lng, lat]: [number, number]): [number, number] => {
      const [x, y] = math.toEqualEarth([lng, lat]);
      return [(x + math.X_MAX) / (2 * math.X_MAX), (math.X_MAX - y) / (2 * math.X_MAX)];
    };
    const centre = map.getCenter();
    const size = 512 * 2 ** map.getZoom();
    const canvas = map.getCanvas();
    const [cx, cy] = world([centre.lng, centre.lat]);
    let worst = 0;
    for (const place of places) {
      const [wx, wy] = world(place);
      const expected = [(wx - cx) * size + canvas.clientWidth / 2, (wy - cy) * size + canvas.clientHeight / 2];
      const point = map.project(place);
      worst = Math.max(worst, Math.hypot(point.x - expected[0]!, point.y - expected[1]!));
    }
    return worst;
  }, PLACES);
}

/** The places whose feature of `layer` is rendered where `map.project` puts them. */
async function placesHit(page: Page, layer: string): Promise<number> {
  let hits = 0;
  for (const place of PLACES) {
    const [x, y] = await pixelOf(page, place);
    const found = await page.evaluate(
      ({ x, y, layer }) => window.__h.map.queryRenderedFeatures([[x - 3, y - 3], [x + 3, y + 3]], { layers: [layer] }).length,
      { x, y, layer },
    );
    if (found > 0) hits++;
  }
  return hits;
}

/** Set a projection through the polyfill and wait until it is live. */
async function setProjection(page: Page, type: string): Promise<void> {
  await page.evaluate((type) => window.__h.map.setProjection({ type }), type);
  await page.waitForFunction((type) => {
    const { controller } = window.__h;
    const equal = type === 'equal' || type === 'equal-earth';
    return equal ? controller?.projection === type && controller.pendingProjection === undefined : !controller?.active;
  }, type);
  await idle(page);
}

const styleProjection = (page: Page): Promise<unknown> =>
  page.evaluate(() => (window.__h.map.getStyle().projection as { type?: unknown } | undefined)?.type ?? 'mercator');

test.describe('native Equal Earth (MapLibre 6.16, addProjection)', () => {
  test('draws pure Equal Earth with the registered projection, exactly', async ({ page, mlv }) => {
    await openHarness(page, { mlv, projection: 'equal-earth', geojson: true });
    const state = await page.evaluate(() => ({
      version: window.__h.maplibregl.getVersion(),
      registered: window.__h.install?.nativeProjection,
      native: window.__h.controller?.native,
      polyfilled: window.__h.map.getProjection(),
      errors: window.__h.errors,
    }));
    expect(state.version).toBe('6.16.0');
    expect(state.registered).toBe('equal-earth:native');
    expect(state.native).toBe(true);
    expect(state.polyfilled).toEqual({ type: 'equal-earth' });
    expect(await styleProjection(page)).toBe('equal-earth:native');
    expect(await projectError(page)).toBeLessThan(0.5);
    // The warped tiles and the GeoJSON MapLibre's workers projected sit where `project` says.
    expect(await placesHit(page, 'places')).toBe(PLACES.length);
    expect(await placesHit(page, 'cities')).toBe(PLACES.length);
    expect(state.errors).toEqual([]);
  });

  test('zooms around the pointer', async ({ page, mlv }) => {
    await openHarness(page, { mlv, projection: 'equal-earth' });
    const box = (await page.locator('#map').boundingBox())!;
    // Whole pixels: Chrome delivers mouse events at integer coordinates, so a fractional pointer
    // would zoom around a point up to half a pixel from the one measured.
    const pointer = { x: Math.round(box.x + box.width * 0.75), y: Math.round(box.y + box.height * 0.35) };
    const under = () =>
      page.evaluate(({ x, y }) => window.__h.map.unproject([x, y]).toArray(), { x: pointer.x - box.x, y: pointer.y - box.y });
    const before = await under();
    await page.mouse.move(pointer.x, pointer.y);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -200);
    await idle(page);
    const after = await under();
    expect(await page.evaluate(() => window.__h.map.getZoom())).toBeGreaterThan(1.5);
    expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeLessThan(1e-6);
  });

  test('switches to Mercator and back, placing GeoJSON in each projection', async ({ page, mlv }) => {
    await openHarness(page, { mlv, projection: 'equal-earth', geojson: true });
    await setProjection(page, 'mercator');
    expect(await styleProjection(page)).toBe('mercator');
    expect(await placesHit(page, 'cities')).toBe(PLACES.length);
    expect(await placesHit(page, 'places')).toBe(PLACES.length);
    await setProjection(page, 'equal-earth');
    expect(await styleProjection(page)).toBe('equal-earth:native');
    expect(await placesHit(page, 'cities')).toBe(PLACES.length);
    expect(await projectError(page)).toBeLessThan(0.5);
    expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
  });

  test('re-places GeoJSON the application added under native Equal Earth when it switches away', async ({ page, mlv }) => {
    await openHarness(page, { mlv, projection: 'equal-earth' });
    // Loaded under the registered projection, and kept by the restore's diff unchanged: without
    // re-placement its index would stay in Equal Earth while the map shows Mercator.
    await page.evaluate((places) => {
      const { map } = window.__h;
      map.addSource('added', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: places.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates } })) },
      });
      map.addLayer({ id: 'added', type: 'circle', source: 'added', paint: { 'circle-radius': 6, 'circle-color': '#00aa00' } });
    }, PLACES);
    await idle(page);
    expect(await placesHit(page, 'added')).toBe(PLACES.length);
    await setProjection(page, 'mercator');
    expect(await placesHit(page, 'added')).toBe(PLACES.length);
    expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
  });

  test('goes through globe and the banded equal, and comes back native', async ({ page, mlv }) => {
    await openHarness(page, { mlv, projection: 'equal-earth', geojson: true });
    await setProjection(page, 'globe');
    expect(await page.evaluate(() => window.__h.map.getProjection())).toMatchObject({ type: 'globe' });
    await setProjection(page, 'equal');
    expect(await styleProjection(page)).toBe('mercator');
    expect(await page.evaluate(() => window.__h.controller?.native)).toBe(false);
    expect(await placesHit(page, 'cities')).toBe(PLACES.length);
    await setProjection(page, 'equal-earth');
    expect(await page.evaluate(() => window.__h.controller?.native)).toBe(true);
    expect(await placesHit(page, 'cities')).toBe(PLACES.length);
    expect(await projectError(page)).toBeLessThan(0.5);
    expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
  });

  test('stays banded with nativeProjection: false', async ({ page, mlv }) => {
    await openHarness(page, { mlv, projection: 'equal-earth', geojson: true, native: false });
    expect(await page.evaluate(() => window.__h.install?.nativeProjection)).toBeUndefined();
    expect(await page.evaluate(() => window.__h.controller?.native)).toBe(false);
    expect(await styleProjection(page)).toBe('mercator');
    expect(await placesHit(page, 'cities')).toBe(PLACES.length);
  });
});
