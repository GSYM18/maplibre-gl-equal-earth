/**
 * Shared helpers for the browser specs: the `mlv` project option, the harness page and every
 * conversion between geographic positions and the map.
 *
 * Specs convert geographic positions **only** through {@link pixelOf}, {@link centreOn} and
 * {@link geographicCentreOffsetPx}, never with `controller.toMapSpace` inline: once `project` and
 * `jumpTo` become geographic, only these bodies change.
 */
import { test as base, expect, type Page } from '@playwright/test';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';

import type { CompensationMode, EqualEarthController, EqualEarthInstall } from '../../src/index.ts';

/** The MapLibre major a project runs against. */
export type MapLibreMajor = 5 | 6;

/** The projection the harness sets once the map has loaded. */
export type HarnessProjection = 'mercator' | 'globe' | 'equal' | 'equal-earth';

/** What `tests/browser/harness.ts` puts on `window.__h`. */
export interface Harness {
  /** Resolves once the map has loaded, the projection is set and the map is idle. */
  ready: Promise<void>;
  /** The loaded `maplibre-gl` module (v5 is typed as v6: the specs use the common surface). */
  maplibregl: typeof import('maplibre-gl');
  map: MapLibreMap;
  install?: EqualEarthInstall;
  controller?: EqualEarthController;
  /** Map `error` events and `[equal-earth]` console warnings, in order. */
  errors: string[];
  /** A fresh copy of the fixture style. */
  fixtureStyle(): StyleSpecification;
  /** Resolves once the map is idle and has stayed still for a moment (see {@link idle}). */
  idle(): Promise<void>;
}

declare global {
  interface Window {
    __h: Harness;
  }
}

export interface HarnessOptions {
  mlv: MapLibreMajor;
  /** @defaultValue true */
  plugin?: boolean;
  dpr?: number;
  /** @defaultValue 'mercator' */
  projection?: HarnessProjection;
  compensation?: CompensationMode;
  /** `outsideColor` of `installEqualEarth`. */
  outside?: string;
  /** `outline: true`. */
  outline?: boolean;
  /** `graticule: { step }`, or `true` for the default. */
  graticule?: number | true;
}

/** `test` with the per-project `mlv` option (`playwright.config.ts` sets it). */
export const test = base.extend<{ mlv: MapLibreMajor }>({
  mlv: [6, { option: true }],
});

export { expect };

/** SwiftShader renders the first frames of a page slowly. */
const READY_TIMEOUT_MS = 60_000;

/** Navigate to the harness and wait for `window.__h.ready`. */
export async function openHarness(page: Page, options: HarnessOptions): Promise<void> {
  const params = new URLSearchParams({ mlv: String(options.mlv) });
  if (options.plugin === false) params.set('plugin', '0');
  if (options.dpr !== undefined) params.set('dpr', String(options.dpr));
  if (options.projection && options.projection !== 'mercator') params.set('projection', options.projection);
  if (options.compensation) params.set('compensation', options.compensation);
  if (options.outside) params.set('outside', options.outside);
  if (options.outline) params.set('outline', '1');
  if (options.graticule !== undefined) params.set('graticule', options.graticule === true ? '1' : String(options.graticule));
  await page.goto(`/tests/browser/harness.html?${params.toString()}`);
  await page.waitForFunction(() => window.__h !== undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`harness not ready after ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
  });
  try {
    await Promise.race([page.evaluate(() => window.__h.ready), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Wait for the map's `idle`, after any deferred camera change (a wheel notch) has run. */
export async function idle(page: Page): Promise<void> {
  await page.evaluate(() => window.__h.idle());
}

export async function canvasDataUrl(page: Page): Promise<string> {
  return page.evaluate(() => window.__h.map.getCanvas().toDataURL('image/png'));
}

/** The canvas pixel (CSS pixels, from the top left) of a geographic position. */
export async function pixelOf(page: Page, lngLat: [number, number]): Promise<[number, number]> {
  return page.evaluate((c) => {
    const { map, controller } = window.__h;
    const point = map.project(controller?.active ? controller.toMapSpace(c) : c);
    return [point.x, point.y] as [number, number];
  }, lngLat);
}

/** The canvas colour `[r, g, b, a]` at a geographic position (the drawing buffer is preserved). */
export async function colourAt(page: Page, lngLat: [number, number]): Promise<[number, number, number, number]> {
  const [x, y] = await pixelOf(page, lngLat);
  return page.evaluate(
    ({ x, y }) => {
      const canvas = window.__h.map.getCanvas();
      const scale = canvas.width / canvas.clientWidth;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d')!;
      context.drawImage(canvas, 0, 0);
      const data = context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      return [data[0]!, data[1]!, data[2]!, data[3]!] as [number, number, number, number];
    },
    { x, y },
  );
}

/** Jump to a geographic centre and zoom, and wait for `idle`. */
export async function centreOn(page: Page, lngLat: [number, number], zoom: number): Promise<void> {
  await page.evaluate(
    ({ c, z }) => {
      const { map, controller } = window.__h;
      map.jumpTo({ center: controller?.active ? controller.toMapSpace(c) : c, zoom: z });
    },
    { c: lngLat, z: zoom },
  );
  await idle(page);
}

/** Distance in CSS pixels between the canvas centre and a geographic position. */
export async function geographicCentreOffsetPx(page: Page, target: [number, number]): Promise<number> {
  const [x, y] = await pixelOf(page, target);
  const { width, height } = await page.evaluate(() => {
    const canvas = window.__h.map.getCanvas();
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  });
  return Math.hypot(x - width / 2, y - height / 2);
}
