/**
 * The adaptive `equal` transition on OpenFreeMap Liberty, through the public API only:
 * `installEqualEarth` once, then `map.setProjection({ type })`.
 *
 * URL parameters: `?steps=&from=&to=` (the transition), `?compensate=none|zoom|zoom+bearing`,
 * `?projection=equal|equal-earth|mercator` (initial projection), `?workers=N`. Omitted ones
 * take the library defaults.
 *
 * `window.__eqe` is the hook `scripts/probe-transition.mjs` drives the page through.
 */

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../style.css';

import {
  installEqualEarth,
  resolveTransition,
  type CompensationMode,
  type LngLatTuple,
  type SwitchEvent,
  type Transition,
} from '../src/index.js';

type ProjectionType = 'equal' | 'equal-earth' | 'mercator';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const CITIES: Record<string, LngLatTuple> = {
  Zürich: [8.54, 47.37],
  Tokyo: [139.69, 35.69],
  'San Francisco': [-122.42, 37.77],
  Anchorage: [-149.9, 61.22],
  Singapore: [103.82, 1.35],
};

const params = new URLSearchParams(location.search);
const numberParam = (name: string): number | undefined => {
  const raw = params.get(name);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};
const oneOf = <T extends string>(name: string, values: readonly T[]): T | undefined => {
  const raw = params.get(name);
  return values.find((value) => value === raw);
};

const readout = document.getElementById('readout')!;
const header: string[] = [];
const events: string[] = [];
let centreLine = '';
const render = (): void => {
  readout.textContent = [...header, centreLine, ...events].filter(Boolean).join('\n');
};
const note = (line: string): void => {
  console.log(`[transition] ${line}`);
  header.push(line);
  render();
};
const log = (line: string): void => {
  console.log(`[transition] ${line}`);
  events.unshift(line);
  events.length = Math.min(events.length, 200);
  render();
};

/** Show a fatal setup error where the user looks, then stop. */
const fatal = (what: string, error: unknown): never => {
  console.error(error);
  note(`FAILED to ${what}: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
};

const transition: Transition = {};
const steps = numberParam('steps');
const from = numberParam('from');
const to = numberParam('to');
if (steps !== undefined) transition.steps = steps;
if (from !== undefined) transition.from = from;
if (to !== undefined) transition.to = to;
// Validates here, so a bad URL fails loudly before any map exists.
let resolved: ReturnType<typeof resolveTransition>;
try {
  resolved = resolveTransition(transition);
} catch (error) {
  resolved = fatal('read ?steps/from/to', error);
}
const compensation = oneOf<CompensationMode>('compensate', ['none', 'zoom', 'zoom+bearing']);
const projection =
  oneOf<ProjectionType>('projection', ['equal', 'equal-earth', 'mercator']) ?? 'equal';
const workers = numberParam('workers');

const onSwitch = (event: SwitchEvent): void => {
  log(
    `shown b${event.from}→b${event.to} at z${event.requestedZoom.toFixed(2)} ` +
      `(zoom's band b${event.target}; waited ${event.waitedMs.toFixed(0)} ms)` +
      (event.forced ? ' FORCED' : ''),
  );
};

const started = performance.now();
// Under `vite dev` the library's own `new URL('./worker.mjs', import.meta.url)` points into
// `/src/`, where no worker exists: load the built one. The query string defeats Vite's
// transform cache, which would otherwise keep serving the worker from before `npm run build:js`.
let install: Awaited<ReturnType<typeof installEqualEarth>>;
try {
  install = await installEqualEarth(maplibregl, {
    workerUrl: new URL(`/dist/worker.mjs?v=${Date.now()}`, location.href),
    transition,
    onSwitch,
    ...(compensation ? { compensation } : {}),
    ...(workers !== undefined ? { workers } : {}),
  });
} catch (error) {
  install = fatal('install Equal Earth', error);
}

note(
  `maplibre-gl ${install.version}; tiles warped on: ${install.workerPath}; ` +
    `workers: ${maplibregl.getWorkerCount()}`,
);
note(
  `projection ${projection}; steps ${resolved.steps} at z${resolved.bands
    .slice(1)
    .map((band) => band.minZoom.toFixed(2))
    .join(', z')}; compensation ${compensation ?? 'zoom+bearing (default)'}`,
);

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE_URL,
  center: [139.69, 35.69],
  zoom: 4.6,
  hash: false,
});
const controller = install.controllerFor(map);

/** The band drawn now: 0 under pure Equal Earth, `steps` (Mercator) when inactive. */
const shownBand = (): number => {
  if (!controller.active) return resolved.steps;
  return controller.projection === 'equal' ? Math.round(controller.blend * resolved.steps) : 0;
};

const updateCentre = (): void => {
  const { lng, lat } = map.getCenter();
  centreLine =
    `centre ${lng.toFixed(4)}, ${lat.toFixed(4)} at z${map.getZoom().toFixed(2)}; ` +
    `band b${shownBand()} (blend ${controller.blend.toFixed(3)})`;
  render();
};
map.on('moveend', updateCentre);
/** Every map `error` since the page loaded, for the probe. */
const errors: string[] = [];
map.on('error', (event: { error?: unknown }) => {
  console.error(event.error);
  const error = event.error;
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message);
  log(`ERROR ${message}`);
});

// Exposed at once, so a probe sees errors (an unreachable style, say) before `ready`.
const eqe = {
  map, controller, install, transition: resolved, shownBand, cities: CITIES, errors, ready: false,
};
Object.assign(window, { __eqe: eqe });
const exposeReady = (): void => {
  note(`first idle after ${(performance.now() - started).toFixed(0)} ms`);
  updateCentre();
  eqe.ready = true;
};

map.once('load', () => {
  note(`style loaded: ${map.getStyle().layers.length} layers`);
  if (projection === 'mercator') {
    map.once('idle', exposeReady);
    return;
  }
  // The rewritten style's `style.load` fires once the activation has committed.
  map.once('style.load', () => {
    note(`${projection}: ${map.getStyle().layers.length} layers after the rewrite`);
    map.once('idle', exposeReady);
  });
  map.setProjection({ type: projection });
});

const cities = document.getElementById('cities')!;
for (const [name, lngLat] of Object.entries(CITIES)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = name;
  button.addEventListener('click', () => {
    map.jumpTo({ center: controller.toMapSpace(lngLat) });
  });
  cities.append(button);
}

const controls = document.getElementById('controls')!;
const world = document.createElement('button');
world.type = 'button';
world.textContent = 'world z2';
world.addEventListener('click', () => {
  map.jumpTo({ center: controller.toMapSpace([0, 0]), zoom: 2 });
});
const toggle = document.createElement('button');
toggle.type = 'button';
const equalType: ProjectionType = projection === 'mercator' ? 'equal' : projection;
let current: ProjectionType = projection;
const label = (): void => {
  const next = current === 'mercator' ? equalType : 'mercator';
  toggle.textContent = `projection: ${current} (switch to ${next})`;
};
toggle.addEventListener('click', () => {
  current = current === 'mercator' ? equalType : 'mercator';
  map.setProjection({ type: current });
  log(`setProjection({ type: '${current}' })`);
  label();
});
label();
controls.append(world, toggle);
