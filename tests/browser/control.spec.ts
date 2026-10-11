/**
 * `EqualEarthControl` on real MapLibre (both majors): the button turns Equal Earth on and off
 * through the polyfilled `setProjection`, and follows MapLibre's own `GlobeControl` on the same map.
 */
import { canvasDataUrl, expect, idle, openHarness, test } from './helpers.ts';

const BUTTON = '.maplibregl-ctrl-equal-earth';

test('the button toggles Equal Earth and restores the original rendering', async ({ page, mlv }) => {
  await openHarness(page, { mlv, control: true });
  const button = page.locator(BUTTON);
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).toHaveAttribute('title', 'Equal Earth');
  const before = await canvasDataUrl(page);

  await button.click();
  await page.waitForFunction(() => window.__h.controller?.active === true);
  await idle(page);
  expect(await page.evaluate(() => window.__h.map.getProjection()?.type)).toBe('equal');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAttribute('title', 'Mercator');

  await button.click();
  await page.waitForFunction(() => window.__h.controller?.active === false);
  await idle(page);
  expect(await page.evaluate(() => window.__h.map.getProjection()?.type)).toBe('mercator');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(await canvasDataUrl(page)).toBe(before);
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
});

test("MapLibre's GlobeControl turns Equal Earth off, and the button follows", async ({ page, mlv }) => {
  test.skip(mlv !== 6, 'GlobeControl is exercised on v6');
  await openHarness(page, { mlv, control: true });
  const button = page.locator(BUTTON);
  await button.click();
  await page.waitForFunction(() => window.__h.controller?.active === true);
  await idle(page);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  // GlobeControl reads any projection but 'mercator' as "on" and turns it off.
  await page.locator('.maplibregl-ctrl-globe').click();
  await page.waitForFunction(() => window.__h.controller?.active === false);
  await idle(page);
  expect(await page.evaluate(() => window.__h.map.getProjection()?.type)).toBe('mercator');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
});

for (const target of ['mercator', 'globe'] as const) {
  test(`an application's setProjection(${target}) announces itself and the button follows`, async ({ page, mlv }) => {
    test.skip(target === 'globe' && mlv !== 6, 'globe is exercised on v6');
    await openHarness(page, { mlv, control: true });
    const button = page.locator(BUTTON);
    await button.click();
    await page.waitForFunction(() => window.__h.controller?.active === true);
    await idle(page);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    // Synchronously after the call: no wait for the style restore's `styledata`.
    const result = await page.evaluate((type) => {
      const { map } = window.__h;
      const seen: string[] = [];
      map.on('projectiontransition', (event) => seen.push((event as unknown as { newProjection: string }).newProjection));
      map.setProjection({ type });
      return { seen, pressed: document.querySelector('.maplibregl-ctrl-equal-earth')!.getAttribute('aria-pressed') };
    }, target);
    expect(result).toEqual({ seen: [target], pressed: 'false' });
  });
}
