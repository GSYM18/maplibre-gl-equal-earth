/**
 * The persistent output-tile cache (spec §6) on real MapLibre, both majors: the warped tiles of
 * the world view at z1 are kept in Cache Storage by the workers, so a reload (new workers, empty
 * in-memory caches) draws them without a single upstream request. The fixture server answers
 * `Cache-Control: no-store` (R1), so the browser's HTTP cache cannot be what serves them; with
 * `persistentCache: false` the reload fetches again.
 *
 * The harness runs with `early`: Equal Earth is set before `load`, so the plain Mercator style
 * never fetches its own tiles, which no persistent cache would (or should) serve.
 */
import type { Page } from '@playwright/test';

import { expect, idle, openHarness, test } from './helpers.ts';

async function tileRequests(page: Page): Promise<number> {
  const response = await page.request.get('/fixture-tiles/__count');
  return ((await response.json()) as { count: number }).count;
}

async function resetTileRequests(page: Page): Promise<void> {
  await page.request.post('/fixture-tiles/__reset');
}

/** Delete every cache of the origin, from a page of it that is not the harness. */
async function clearCacheStorage(page: Page): Promise<void> {
  await page.goto('/fixture-tiles/__count');
  await page.evaluate(async () => {
    for (const name of await caches.keys()) await caches.delete(name);
  });
}

/** Entries in the plugin's caches, read until two reads agree: the stores are fire-and-forget. */
async function settledEntries(page: Page): Promise<number> {
  let last = -1;
  for (;;) {
    const entries = await page.evaluate(async () => {
      let total = 0;
      for (const name of await caches.keys()) {
        if (name.startsWith('equal-earth-')) total += (await (await caches.open(name)).keys()).length;
      }
      return total;
    });
    if (entries === last) return entries;
    last = entries;
    await page.waitForTimeout(300);
  }
}

test('a reload draws the z1 world view from Cache Storage, without one tile request', async ({ page, mlv }) => {
  await clearCacheStorage(page);
  await resetTileRequests(page);
  await openHarness(page, { mlv, projection: 'equal-earth', early: true });
  expect(await page.evaluate(() => window.__h.install?.workerPath)).toBe('worker');
  expect(await page.evaluate(() => window.__h.map.getZoom())).toBe(1);
  expect(await tileRequests(page)).toBeGreaterThan(0);
  expect(await settledEntries(page)).toBeGreaterThan(0);

  await resetTileRequests(page);
  await openHarness(page, { mlv, projection: 'equal-earth', early: true });
  await idle(page);
  expect(await page.evaluate(() => window.__h.controller?.active)).toBe(true);
  expect(await tileRequests(page)).toBe(0);
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
});

test('with persistentCache: false a reload fetches the tiles again', async ({ page, mlv }) => {
  await clearCacheStorage(page);
  await openHarness(page, { mlv, projection: 'equal-earth', early: true, persist: false });
  expect(await settledEntries(page)).toBe(0);

  await resetTileRequests(page);
  await openHarness(page, { mlv, projection: 'equal-earth', early: true, persist: false });
  await idle(page);
  expect(await tileRequests(page)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
});
