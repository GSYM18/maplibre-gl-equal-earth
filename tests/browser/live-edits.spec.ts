/**
 * The application's own style edits while Equal Earth is active (Task 9) on real MapLibre, both
 * majors: a layer added under `equal` at z2 is drawn in the band shown, on the fixture's places
 * where they are; a paint change reaches it there; a batch of `addLayer` calls neither moves the
 * view nor raises an `error`; `removeLayer` takes every copy away. None of it fires `style.load`,
 * nor does the plugin's own `setStyle` (R21); edits made while the application's `setStyle(url)`
 * fetches do not cancel it (R20).
 */
import type { Page } from '@playwright/test';

import { centreOn, colourAt, expect, idle, openHarness, test } from './helpers.ts';

const TOKYO: [number, number] = [139.69, 35.69]; // a fixture place

/** The canvas colour at Tokyo is (close to) `[r, g, b]`; the fixture's own dots are #cc3333. */
async function colourIs(page: Page, [r, g, b]: [number, number, number]): Promise<boolean> {
  const [cr, cg, cb] = await colourAt(page, TOKYO);
  return Math.abs(cr - r) < 16 && Math.abs(cg - g) < 16 && Math.abs(cb - b) < 16;
}

test('addLayer, setPaintProperty and removeLayer while active reach the band shown, and a batch keeps the view', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, TOKYO, 2);
  expect(await colourIs(page, [255, 0, 0])).toBe(false);
  // An amend is invisible, as a native addLayer is: no `style.load` reaches the application (R15).
  await page.evaluate(() => {
    const kept = window as unknown as { __loads: number };
    kept.__loads = 0;
    window.__h.map.on('style.load', () => {
      kept.__loads++;
    });
  });

  await page.evaluate(() => {
    window.__h.map.addLayer({
      id: 'marks',
      type: 'circle',
      source: 'fixture',
      'source-layer': 'places',
      paint: { 'circle-color': '#ff0000', 'circle-radius': 8 },
    });
  });
  await idle(page);
  expect(await colourIs(page, [255, 0, 0])).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __loads: number }).__loads)).toBe(0);
  // Drawn by the band shown (pure Equal Earth at z2), not by the Mercator band's layer.
  expect(await page.evaluate(() => window.__h.map.getLayer('marks__b0') !== undefined)).toBe(true);

  await page.evaluate(() => window.__h.map.setPaintProperty('marks', 'circle-color', '#00ff00'));
  await idle(page);
  expect(await colourIs(page, [0, 255, 0])).toBe(true);

  const before = await page.evaluate(() => window.__h.map.getCenter().toArray());
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) {
      window.__h.map.addLayer({
        id: `batch${i}`,
        type: 'line',
        source: 'fixture',
        'source-layer': 'lines',
        paint: { 'line-color': '#000000', 'line-width': 1 },
      });
    }
  });
  await idle(page);
  expect(await page.evaluate(() => window.__h.map.getCenter().toArray())).toEqual(before);
  expect(await page.evaluate(() => window.__h.map.getLayer('batch9__b0') !== undefined)).toBe(true);

  await page.evaluate(() => window.__h.map.removeLayer('marks'));
  await idle(page);
  expect(await colourIs(page, [0, 255, 0])).toBe(false);
  expect(await page.evaluate(() => window.__h.map.getStyle().layers.filter((l) => l.id.startsWith('marks')).length)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __loads: number }).__loads)).toBe(0);
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
});

test('a basemap switch by URL is followed: a guarded style.load listener registered before activation re-adds its layer, banded', async ({ page, mlv }) => {
  await openHarness(page, { mlv });
  await page.evaluate(() => {
    const { map } = window.__h;
    // The common pattern: re-add my layer whenever a style loads, guarded by `getSource`/`getLayer`.
    map.on('style.load', () => {
      if (!map.getSource('mine')) {
        map.addSource('mine', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [139.69, 35.69] } },
        });
      }
      if (!map.getLayer('mine')) {
        map.addLayer({ id: 'mine', type: 'circle', source: 'mine', paint: { 'circle-color': '#ff0000', 'circle-radius': 8 } });
      }
    });
    map.setProjection({ type: 'equal' });
  });
  await page.waitForFunction(() => window.__h.controller?.active === true && window.__h.controller.pendingProjection === undefined);
  await centreOn(page, TOKYO, 2);

  // `setStyle(url)` with MapLibre's default diff: fetched, then diffed in from MapLibre's own code.
  await page.evaluate(() => {
    const style = window.__h.fixtureStyle();
    style.layers = style.layers.filter((layer) => layer.id !== 'places');
    const url = URL.createObjectURL(new Blob([JSON.stringify(style)], { type: 'application/json' }));
    window.__h.map.setStyle(url);
  });
  await page.waitForFunction(() => window.__h.map.getStyle().layers.some((layer) => layer.id === 'mine__b0'));
  await idle(page);
  expect(await page.evaluate(() => window.__h.controller?.active)).toBe(true);
  expect(await page.evaluate(() => window.__h.map.getStyle().layers.some((layer) => layer.id.startsWith('places')))).toBe(false);
  expect(await colourIs(page, [255, 0, 0])).toBe(true);
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
});

test("edits while the application's setStyle(url) fetches do not cancel it; the plugin's own setStyle fires no style.load", async ({ page, mlv }) => {
  await openHarness(page, { mlv });
  await page.evaluate(() => {
    const kept = window as unknown as { __loads: number };
    kept.__loads = 0;
    window.__h.map.on('style.load', () => {
      kept.__loads++;
    });
    window.__h.map.setProjection({ type: 'equal' });
  });
  await page.waitForFunction(() => window.__h.controller?.active === true && window.__h.controller.pendingProjection === undefined);
  await centreOn(page, TOKYO, 2);
  expect(await page.evaluate(() => (window as unknown as { __loads: number }).__loads)).toBe(0); // R21

  // R20: an amend's `setStyle` would abort MapLibre's fetch of the URL (`_diffStyleRequest`).
  await page.evaluate(() => {
    const { map } = window.__h;
    const style = window.__h.fixtureStyle();
    style.layers = style.layers.filter((layer) => layer.id !== 'places');
    map.setStyle(URL.createObjectURL(new Blob([JSON.stringify(style)], { type: 'application/json' })));
    map.setPaintProperty('lines', 'line-color', '#000000');
    map.addLayer({ id: 'extra', type: 'line', source: 'fixture', 'source-layer': 'lines' });
  });
  await page.waitForFunction(() => !window.__h.map.getStyle().layers.some((layer) => layer.id.startsWith('places')));
  await page.waitForFunction(() => window.__h.controller?.active === true && window.__h.map.getLayer('lines__b0') !== undefined);
  await idle(page);
  expect(await page.evaluate(() => (window as unknown as { __loads: number }).__loads)).toBe(1); // the basemap's own
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);

  await page.evaluate(() => window.__h.map.setProjection({ type: 'mercator' }));
  await page.waitForFunction(() => window.__h.controller?.active !== true);
  await idle(page);
  expect(await page.evaluate(() => (window as unknown as { __loads: number }).__loads)).toBe(1);
  expect(await page.evaluate(() => window.__h.map.getStyle().layers.map((layer) => layer.id))).toEqual(['background', 'land', 'lines']);
});
