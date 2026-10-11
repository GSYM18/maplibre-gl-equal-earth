/**
 * The browser test harness page: one MapLibre map (v5 or v6) on the in-memory fixture tiles,
 * with or without the plugin, exposed as `window.__h` (typed in `helpers.ts`).
 *
 * URL parameters: `?mlv=5|6` (default 6), `?plugin=0|1` (default 1), `?dpr=` (the map's
 * `pixelRatio`), `?projection=mercator|globe|equal|equal-earth` (default mercator, set after
 * `load`), `?compensation=`, `?outside=` (colour), `?outline=1` and `?graticule=<step>|1` (all
 * passed to `installEqualEarth` when present).
 */
import type { StyleSpecification } from 'maplibre-gl';

import { installEqualEarth, type CompensationMode } from '../../src/index.ts';
import type { Harness, HarnessProjection } from './helpers.ts';

const params = new URLSearchParams(location.search);
const mlv = params.get('mlv') === '5' ? 5 : 6;
const plugin = params.get('plugin') !== '0';
const dprParam = Number(params.get('dpr'));
const dpr = params.get('dpr') !== null && dprParam > 0 ? dprParam : undefined;
const projection = (params.get('projection') ?? 'mercator') as HarnessProjection;
const compensation = (params.get('compensation') ?? undefined) as CompensationMode | undefined;

const outside = params.get('outside') ?? undefined;
const outline = params.get('outline') === '1';
const graticuleParam = params.get('graticule');
const graticule = graticuleParam === null ? undefined : graticuleParam === '1' ? true : { step: Number(graticuleParam) };

const fixtureStyle = (): StyleSpecification => ({
  version: 8,
  sources: {
    fixture: {
      type: 'vector',
      tiles: [`${location.origin}/fixture-tiles/{z}/{x}/{y}.pbf`],
      maxzoom: 14,
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } },
    { id: 'land', type: 'fill', source: 'fixture', 'source-layer': 'land', paint: { 'fill-color': '#9fd39f' } },
    { id: 'lines', type: 'line', source: 'fixture', 'source-layer': 'lines', paint: { 'line-color': '#336699', 'line-width': 1 } },
    { id: 'places', type: 'circle', source: 'fixture', 'source-layer': 'places', paint: { 'circle-color': '#cc3333', 'circle-radius': 4 } },
  ],
});

let resolveReady!: () => void;
let rejectReady!: (error: unknown) => void;
const h = {
  ready: new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  }),
  errors: [] as string[],
  fixtureStyle,
} as Partial<Harness> as Harness;
window.__h = h;

const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[equal-earth]')) h.errors.push(args[0]);
  warn(...args);
};

/** Settling period after `idle`: ScrollZoom waits 40 ms to classify a wheel before it moves. */
const SETTLE_MS = 150;

/**
 * Resolves on an `idle` after which nothing moved for {@link SETTLE_MS}. A plain `once('idle')`
 * can resolve before a deferred camera change (a wheel notch) has started, and `loaded()` is
 * true between the frames of an animation.
 */
h.idle = async () => {
  const map = h.map;
  for (;;) {
    await new Promise<void>((resolve) => {
      map.once('idle', () => resolve());
      map.triggerRepaint();
    });
    let moved = false;
    const onMove = (): void => {
      moved = true;
    };
    map.on('movestart', onMove);
    map.on('move', onMove);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    map.off('movestart', onMove);
    map.off('move', onMove);
    if (!moved && !map.isMoving() && map.loaded()) return;
  }
};

const load = (element: HTMLScriptElement | HTMLLinkElement, url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    element.addEventListener('load', () => resolve());
    element.addEventListener('error', () => reject(new Error(`failed to load ${url}`)));
    document.head.append(element);
  });

const loadCss = (url: string): Promise<void> => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  return load(link, url);
};

async function loadMapLibre(): Promise<typeof import('maplibre-gl')> {
  if (mlv === 6) {
    await loadCss('/node_modules/maplibre-gl/dist/maplibre-gl.css');
    return import('maplibre-gl');
  }
  await loadCss('/node_modules/maplibre-gl-v5/dist/maplibre-gl.css');
  const url = '/node_modules/maplibre-gl-v5/dist/maplibre-gl.js';
  const script = document.createElement('script');
  script.src = url;
  await load(script, url);
  return (window as unknown as { maplibregl: typeof import('maplibre-gl') }).maplibregl;
}

async function start(): Promise<void> {
  const maplibregl = await loadMapLibre();
  h.maplibregl = maplibregl;
  if (plugin) {
    // `?v=`: a reused dev server would otherwise serve its cached transform of an older build.
    const worker = mlv === 6 ? '/dist/worker.mjs' : '/dist/worker.iife.js';
    h.install = await installEqualEarth(maplibregl, {
      workerUrl: new URL(`${worker}?v=${Date.now()}`, location.href),
      workerTimeoutMs: 15000,
      ...(compensation ? { compensation } : {}),
      ...(outside ? { outsideColor: outside } : {}),
      ...(outline ? { outline: true } : {}),
      ...(graticule ? { graticule } : {}),
    });
  }
  const map = new maplibregl.Map({
    container: 'map',
    style: fixtureStyle(),
    center: [0, 20],
    zoom: 1,
    fadeDuration: 0,
    ...(dpr !== undefined ? { pixelRatio: dpr } : {}),
    canvasContextAttributes: { preserveDrawingBuffer: true },
    attributionControl: false,
  });
  h.map = map;
  if (h.install) h.controller = h.install.controllerFor(map);
  map.on('error', (event: { error?: unknown }) => {
    const { error } = event;
    h.errors.push(error instanceof Error ? error.message : String(error));
  });
  await new Promise<void>((resolve) => map.once('load', () => resolve()));
  if (projection !== 'mercator') map.setProjection({ type: projection });
  // The polyfill activates asynchronously: wait until Equal Earth is live before settling.
  const equal = projection === 'equal' || projection === 'equal-earth';
  for (;;) {
    await h.idle();
    if (!(plugin && equal) || (h.controller?.active && h.controller.pendingProjection === undefined)) break;
  }
}

start().then(resolveReady, (error: unknown) => {
  h.errors.push(error instanceof Error ? error.message : String(error));
  rejectReady(error);
});
