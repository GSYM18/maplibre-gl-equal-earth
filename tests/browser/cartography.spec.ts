/**
 * Cartographic finish on real MapLibre: hairline seams in warped fills (source tiles are clipped
 * upstream, so a polygon spanning several arrives as several pieces).
 */
import type { Page } from '@playwright/test';

import { centreOn, expect, openHarness, pixelOf, test } from './helpers.ts';

const LAND = [0x9f, 0xd3, 0x9f];
const BACKGROUND = [0xf8, 0xf4, 0xf0];
const TOLERANCE = 8;
const GRID = 40;

/** Fixture box 1 spans lng -20..50, lat -35..35 (four z1 source tiles). Points strictly inside it. */
function gridPoints(): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) points.push([-15 + (55 * i) / (GRID - 1), -30 + (60 * j) / (GRID - 1)]);
  }
  return points;
}

/** Sample the canvas at pixels; returns how many sit on the background colour and how many on land. */
async function sample(page: Page, pixels: [number, number][]): Promise<{ sampled: number; seams: number; land: number }> {
  return page.evaluate(
    ({ pixels, land, background, tolerance }) => {
      const canvas = window.__h.map.getCanvas();
      const scale = canvas.width / canvas.clientWidth;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d')!;
      context.drawImage(canvas, 0, 0);
      const close = (d: Uint8ClampedArray, c: number[]) => [0, 1, 2].every((i) => Math.abs(d[i]! - c[i]!) <= tolerance);
      let sampled = 0;
      let seams = 0;
      let landCount = 0;
      for (const [x, y] of pixels) {
        const px = Math.round(x * scale);
        const py = Math.round(y * scale);
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
        sampled++;
        const data = context.getImageData(px, py, 1, 1).data;
        if (close(data, land)) landCount++;
        else if (close(data, background)) seams++;
      }
      return { sampled, seams, land: landCount };
    },
    { pixels, land: LAND, background: BACKGROUND, tolerance: TOLERANCE },
  );
}

for (const dpr of [1, 2]) {
  test(`fill seams: no background pixel inside land box 1 at z2-z4 (dpr ${dpr})`, async ({ page, mlv }) => {
    test.setTimeout(240_000);
    await openHarness(page, { mlv, projection: 'equal', dpr });
    const report: string[] = [];
    for (const zoom of [2, 3, 4]) {
      await centreOn(page, [15, 0], zoom);
      const pixels = await Promise.all(gridPoints().map((p) => pixelOf(page, p)));
      const { sampled, seams, land } = await sample(page, pixels);
      report.push(`mlv ${mlv} dpr ${dpr} z${zoom}: sampled ${sampled}, land ${land}, seam pixels ${seams}`);
      expect(sampled, `z${zoom} sampled`).toBeGreaterThan(100);
      expect(land, `z${zoom} land`).toBeGreaterThan(sampled * 0.9);
      expect(seams, `z${zoom} seam pixels`).toBe(0);
    }
    console.log(report.join('\n'));
  });
}
