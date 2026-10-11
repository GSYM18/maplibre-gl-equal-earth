/**
 * GeoJSON sources in every band (spec §7) on real MapLibre, both majors: the harness's inline
 * `cities` source (`?geojson=1`, blue circles over the fixture's red places) is drawn where the
 * places are under `equal`, in the pure Equal Earth band (z2) and mid-transition (z6), and
 * follows the application's `setData`, while `getData()` keeps returning geographic data.
 */
import type { Page } from '@playwright/test';

import { centreOn, colourAt, expect, idle, openHarness, test } from './helpers.ts';

const ZURICH: [number, number] = [8.54, 47.37];
const TOKYO: [number, number] = [139.69, 35.69];

const ONLY_TOKYO: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', id: 201, properties: {}, geometry: { type: 'Point', coordinates: TOKYO } }],
};

/** Whether the canvas is the cities layer's blue at a geographic position. */
async function blueAt(page: Page, lngLat: [number, number]): Promise<boolean> {
  const [r, g, b] = await colourAt(page, lngLat);
  return b > 200 && r < 60 && g < 60;
}

for (const zoom of [2, 6]) {
  test(`a GeoJSON source is drawn in band space and follows setData at z${zoom}`, async ({ page, mlv }) => {
    await openHarness(page, { mlv, projection: 'equal', geojson: true });
    await centreOn(page, ZURICH, zoom);
    expect(await blueAt(page, ZURICH)).toBe(true);

    await page.evaluate((data) => {
      const source = window.__h.map.getSource('cities') as import('maplibre-gl').GeoJSONSource;
      void source.setData(data);
    }, ONLY_TOKYO);
    await idle(page);
    expect(await blueAt(page, ZURICH)).toBe(false);
    await centreOn(page, TOKYO, zoom);
    expect(await blueAt(page, TOKYO)).toBe(true);

    // The application's source keeps geographic data.
    const data = await page.evaluate(() => (window.__h.map.getSource('cities') as import('maplibre-gl').GeoJSONSource).getData());
    expect(data).toEqual(ONLY_TOKYO);
    expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
  });
}

test('an updateData reaches the band copies once MapLibre has applied it', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal', geojson: true });
  await centreOn(page, ZURICH, 2);
  expect(await blueAt(page, ZURICH)).toBe(true);
  await page.evaluate(() => {
    const source = window.__h.map.getSource('cities') as import('maplibre-gl').GeoJSONSource;
    void source.updateData({ remove: [200] }); // the fixture's Zürich
  });
  await expect.poll(() => blueAt(page, ZURICH), { timeout: 15_000 }).toBe(false);
  await centreOn(page, TOKYO, 2); // the rest stays
  expect(await blueAt(page, TOKYO)).toBe(true);
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
});

test('a setData in the same tick as setProjection reaches every band', async ({ page, mlv }) => {
  await openHarness(page, { mlv, geojson: true });
  await page.evaluate((data) => {
    const { map } = window.__h;
    map.setProjection({ type: 'equal' });
    void (map.getSource('cities') as import('maplibre-gl').GeoJSONSource).setData(data);
  }, ONLY_TOKYO);
  await page.waitForFunction(() => window.__h.controller?.active === true && window.__h.controller.pendingProjection === undefined);
  await centreOn(page, ZURICH, 2);
  expect(await blueAt(page, ZURICH)).toBe(false);
  await centreOn(page, TOKYO, 2);
  expect(await blueAt(page, TOKYO)).toBe(true);
  expect(await page.evaluate(() => (window.__h.map.getSource('cities') as import('maplibre-gl').GeoJSONSource).getData())).toEqual(ONLY_TOKYO);
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
});
