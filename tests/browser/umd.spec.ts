/**
 * The UMD bundle on a page without a bundler (`umd.html`): a classic `<script src>` defines the
 * `maplibreglEqualEarth` global, the default worker URL resolves next to that script, and the
 * tiles are warped there. Needs `npm run build` (the bundle and the workers come from `/dist/`).
 */
import { colourAt, expect, test } from './helpers.ts';

interface UmdState {
  ready: Promise<void>;
  errors: string[];
  workerUrls: string[];
  workerPath?: string;
  controller?: { active: boolean };
}

declare global {
  interface Window {
    __umd: UmdState;
  }
}

test('the UMD bundle installs from a script tag and warps in the worker next to it', async ({ page, mlv }) => {
  await page.goto(`/tests/browser/umd.html?mlv=${mlv}`);
  await page.waitForFunction(() => window.__umd !== undefined);
  await page.evaluate(() => window.__umd.ready);

  const state = await page.evaluate(() => ({
    errors: window.__umd.errors,
    workerUrls: window.__umd.workerUrls,
    workerPath: window.__umd.workerPath,
    active: window.__umd.controller?.active,
  }));
  expect(state.errors).toEqual([]);
  const worker = mlv === 6 ? 'worker.mjs' : 'worker.iife.js';
  expect(state.workerUrls).toEqual([`http://localhost:5179/dist/${worker}`]);
  expect(state.workerPath).toBe('worker');
  expect(state.active).toBe(true);
  // Inside fixture land box 1, through the geographic API the global installed.
  expect(await colourAt(page, [15, 15])).toEqual([0x9f, 0xd3, 0x9f, 255]);
});
