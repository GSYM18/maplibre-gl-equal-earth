/**
 * Baseline behaviour on real MapLibre (both majors): the worker path, the plugin's neutrality
 * outside Equal Earth, style round trips, the geographic centre across band crossings, and the
 * wheel's zoom step.
 */
import {
  canvasDataUrl,
  centreOn,
  expect,
  geographicCentreOffsetPx,
  idle,
  openHarness,
  test,
} from './helpers.ts';

test('tiles are warped in the worker, not on the main thread', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  const state = await page.evaluate(() => ({ path: window.__h.install!.workerPath, errors: window.__h.errors }));
  expect(state.path).toBe('worker');
  expect(state.errors).toEqual([]);
});

for (const projection of ['mercator', 'globe'] as const) {
  test(`${projection} renders pixel-identically with and without the plugin`, async ({ page, mlv }) => {
    await openHarness(page, { mlv, plugin: false, projection });
    const without = await canvasDataUrl(page);
    await openHarness(page, { mlv, plugin: true, projection });
    const withPlugin = await canvasDataUrl(page);
    expect(withPlugin).toBe(without);
  });
}

test('mercator → equal → mercator restores the original rendering', async ({ page, mlv }) => {
  await openHarness(page, { mlv });
  const before = await canvasDataUrl(page);
  await page.evaluate(() => window.__h.map.setProjection({ type: 'equal' }));
  await page.waitForFunction(() => window.__h.controller?.active === true);
  await idle(page);
  await page.evaluate(() => window.__h.map.setProjection({ type: 'mercator' }));
  await idle(page);
  expect(await canvasDataUrl(page)).toBe(before);
});

test('a setStyle round trip keeps Equal Earth active', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await page.evaluate(() => {
    const map = window.__h.map;
    const style = window.__h.fixtureStyle();
    style.layers.find((l) => l.id === 'land')!.paint = { 'fill-color': '#4477aa' };
    map.setStyle(style);
  });
  await idle(page);
  const state = await page.evaluate(() => ({
    active: window.__h.controller!.active,
    rewritten: Boolean((window.__h.map.getStyle().metadata as Record<string, unknown>)['equal-earth:rewritten']),
  }));
  expect(state).toEqual({ active: true, rewritten: true });
});

test('the geographic centre stays within 1 px across band crossings (flyTo, wheel)', async ({ page, mlv }) => {
  const zurich: [number, number] = [8.54, 47.37];
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, zurich, 3.5);
  await page.evaluate(() => window.__h.map.flyTo({ zoom: 8.5, duration: 3000 }));
  await idle(page);
  expect(await geographicCentreOffsetPx(page, zurich)).toBeLessThanOrEqual(1);
  const box = (await page.locator('#map canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(150); }
  await idle(page);
  expect(await geographicCentreOffsetPx(page, zurich)).toBeLessThanOrEqual(1);
});

test('one wheel notch zooms as far as it does without the plugin', async ({ page, mlv }) => {
  const notch = async (plugin: boolean): Promise<number> => {
    // No compensation: getZoom() is then the requested zoom, with no band offset in it.
    await openHarness(page, { mlv, plugin, projection: plugin ? 'equal' : 'mercator', compensation: 'none' });
    await page.evaluate(() => window.__h.map.jumpTo({ zoom: 5 }));
    await idle(page);
    const box = (await page.locator('#map canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
    await idle(page);
    return page.evaluate(() => window.__h.map.getZoom());
  };
  const plain = await notch(false);
  const equal = await notch(true);
  expect(Math.abs((equal - 5) / (plain - 5) - 1)).toBeLessThan(0.05);
});
