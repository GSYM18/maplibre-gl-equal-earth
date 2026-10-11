/**
 * Cartographic finish on real MapLibre: hairline seams in warped fills (source tiles are clipped
 * upstream, so a polygon spanning several arrives as several pieces).
 *
 * The scan reads EVERY device pixel of a rectangle inside the warped outline of fixture land box
 * 1 (lng -20..50, lat -35..35, four z1 source tiles, so it crosses the tile boundaries at lng 0
 * and lat 0) and counts each pixel that is not the land colour, so an antialiased half-blended
 * seam counts too. A self-test paints a 1 px background line into the scanned copy and requires
 * the scan to see it.
 */
import type { Page } from '@playwright/test';

import { centreOn, expect, idle, openHarness, pixelOf, test } from './helpers.ts';

const LAND = [0x9f, 0xd3, 0x9f];
const TOLERANCE = 8;
/** CSS pixels kept clear of the warped outline (the box's own antialiased border). */
const MARGIN = 6;

interface Rect { x0: number; y0: number; x1: number; y1: number }

/** A CSS-pixel rectangle strictly inside the warped box 1 and the canvas. */
async function interior(page: Page): Promise<Rect> {
  const size = await page.evaluate(() => {
    const c = window.__h.map.getCanvas();
    return { w: c.clientWidth, h: c.clientHeight };
  });
  // Parallels are horizontal; meridians curve inwards towards the poles, so the left bound is the
  // rightmost of the left meridian over the sampled latitudes, and the right bound the leftmost.
  const lats = [-30, -20, -10, 0, 10, 20, 30];
  const lefts = await Promise.all(lats.map((lat) => pixelOf(page, [-17, lat])));
  const rights = await Promise.all(lats.map((lat) => pixelOf(page, [47, lat])));
  const top = await pixelOf(page, [15, 32]);
  const bottom = await pixelOf(page, [15, -32]);
  return {
    x0: Math.max(MARGIN, ...lefts.map((p) => p[0])),
    x1: Math.min(size.w - MARGIN, ...rights.map((p) => p[0])),
    y0: Math.max(MARGIN, Math.min(top[1], bottom[1])),
    y1: Math.min(size.h - MARGIN, Math.max(top[1], bottom[1])),
  };
}

/** Scan every device pixel in `rect`; `inject` paints a 1 px background row across it first. */
async function scan(page: Page, rect: Rect, inject = false): Promise<{ scanned: number; bad: number }> {
  return page.evaluate(
    ({ rect, land, tolerance, inject }) => {
      const canvas = window.__h.map.getCanvas();
      const scale = canvas.width / canvas.clientWidth;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d')!;
      context.drawImage(canvas, 0, 0);
      const x0 = Math.ceil(rect.x0 * scale);
      const y0 = Math.ceil(rect.y0 * scale);
      const w = Math.floor(rect.x1 * scale) - x0;
      const h = Math.floor(rect.y1 * scale) - y0;
      if (inject) {
        context.fillStyle = '#f8f4f0';
        context.fillRect(x0, y0 + Math.floor(h / 2), w, 1);
      }
      const data = context.getImageData(x0, y0, w, h).data;
      let bad = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i]! - land[0]!) > tolerance || Math.abs(data[i + 1]! - land[1]!) > tolerance || Math.abs(data[i + 2]! - land[2]!) > tolerance) bad++;
      }
      return { scanned: w * h, bad };
    },
    { rect, land: LAND, tolerance: TOLERANCE, inject },
  );
}

for (const dpr of [1, 2]) {
  test(`fill seams: every pixel inside land box 1 is land at z2-z4 (dpr ${dpr})`, async ({ page, mlv }) => {
    test.setTimeout(240_000);
    await openHarness(page, { mlv, projection: 'equal', dpr });
    // Only the land fill: the fixture's parallels and places are drawn over it by design.
    await page.evaluate(() => {
      const style = window.__h.fixtureStyle();
      style.layers = style.layers.filter((l) => l.id === 'background' || l.id === 'land');
      window.__h.map.setStyle(style);
    });
    await page.waitForFunction(() => window.__h.controller?.active === true);
    await idle(page);
    const report: string[] = [];
    for (const zoom of [2, 3, 4]) {
      await centreOn(page, [5, 0], zoom);
      const rect = await interior(page);
      // The scan must cross the source-tile boundaries at lng 0 and lat 0.
      const [x, y] = await pixelOf(page, [0, 0]);
      expect(x, `z${zoom} lng 0 inside scan`).toBeGreaterThan(rect.x0 + 10);
      expect(x, `z${zoom} lng 0 inside scan`).toBeLessThan(rect.x1 - 10);
      expect(y, `z${zoom} lat 0 inside scan`).toBeGreaterThan(rect.y0 + 10);
      expect(y, `z${zoom} lat 0 inside scan`).toBeLessThan(rect.y1 - 10);
      const { scanned, bad } = await scan(page, rect);
      report.push(`mlv ${mlv} dpr ${dpr} z${zoom}: scanned ${scanned} px, non-land ${bad}`);
      expect(scanned, `z${zoom} scanned`).toBeGreaterThan(5000);
      expect(bad, `z${zoom} non-land pixels`).toBe(0);
      // The scan can see a 1 px seam.
      expect((await scan(page, rect, true)).bad, `z${zoom} detector self-test`).toBeGreaterThan(0);
    }
    console.log(report.join('\n'));
  });
}

/** The canvas colour at a CSS pixel, as `[r, g, b, a]`. */
async function colourAtPixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = window.__h.map.getCanvas();
      const scale = canvas.width / canvas.clientWidth;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d')!;
      context.drawImage(canvas, 0, 0);
      return [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data];
    },
    { x, y },
  );
}

const near = (actual: number[], expected: number[], tolerance = TOLERANCE): boolean =>
  expected.every((value, i) => Math.abs(actual[i]! - value) <= tolerance);

const BACKGROUND = [0xf8, 0xf4, 0xf0];

test('outside colour fills the corners of the canvas; the world and the Arctic gap keep the background', async ({ page, mlv }) => {
  test.setTimeout(240_000);
  await openHarness(page, { mlv, projection: 'equal-earth', outside: '#ff00ff' });
  await centreOn(page, [0, 0], 0);
  expect(near(await colourAtPixel(page, 2, 2), [0xff, 0x00, 0xff]), 'top-left corner').toBe(true);
  const ocean = await pixelOf(page, [0, -45]);
  expect(near(await colourAtPixel(page, ocean[0], ocean[1]), BACKGROUND), 'open ocean').toBe(true);
  // Polar sea above land box 4, below the pole: only the pole snapping and the world polygon close it.
  const arctic = await pixelOf(page, [-175, 82]);
  expect(near(await colourAtPixel(page, arctic[0], arctic[1]), BACKGROUND), 'Arctic gap').toBe(true);
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
});

test('without an outside colour the corners show the page behind the canvas', async ({ page, mlv }) => {
  test.setTimeout(240_000);
  await openHarness(page, { mlv, projection: 'equal-earth' });
  await centreOn(page, [0, 0], 0);
  expect((await colourAtPixel(page, 2, 2))[3], 'corner is transparent').toBeLessThan(TOLERANCE);
  const ocean = await pixelOf(page, [0, -45]);
  expect(near(await colourAtPixel(page, ocean[0], ocean[1]), BACKGROUND), 'open ocean').toBe(true);
});

test('the outline and the graticule are drawn on the world', async ({ page, mlv }) => {
  test.setTimeout(240_000);
  await openHarness(page, { mlv, projection: 'equal-earth', outline: true, graticule: 30 });
  await centreOn(page, [0, 0], 0);
  const layers = await page.evaluate(() => window.__h.map.getStyle().layers.map((l) => l.id));
  expect(layers).toContain('equal-earth:outline__b0');
  expect(layers).toContain('equal-earth:graticule__b0');
  // Open ocean on the -150° meridian: only the graticule darkens it.
  const [x, y] = await pixelOf(page, [-150, -45]);
  expect(near(await colourAtPixel(page, x, y), BACKGROUND, 2), 'graticule meridian darkens the ocean').toBe(false);
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
});
