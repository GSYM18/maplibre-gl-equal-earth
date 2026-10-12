/**
 * The adaptive `equal` transition on any EPSG:3857 vector style (default OpenFreeMap Liberty),
 * through the public API only: `installEqualEarth` once, then `map.setProjection({ type })`.
 *
 * URL parameters (omitted ones take the library defaults):
 *
 * - `?style=<url>`: the style; its vector sources may be TileJSON (`url`) or `tiles` templates.
 *   A SmartMaps style URL works the same way, its `?key=` included (URL-encode it, or use the
 *   panel's input, which does).
 * - `?projection=equal|equal-earth|mercator`: the initial projection, set right after the map
 *   is created, as an application wanting a fast first paint would.
 * - `?steps=&from=&to=` (the transition), `?compensate=none|zoom|zoom+bearing`, `?workers=N`.
 * - `?control=0` drops the `EqualEarthControl` (on by default).
 * - `?outside=<colour>`, `?outline=1`, `?graticule=<step>|1`: the cartography options.
 * - `?persist=0` (`persistentCache: false`), `?zoomOffset=<n>` (`sourceZoomOffset`).
 *
 * First paint (spec §1 criterion 4): `performance.mark('eqe:start')` at module start,
 * `'eqe:installed'` once `installEqualEarth` resolved, `'eqe:active'` when the polyfill announces
 * the initial Equal Earth projection (`projectiontransition`), `'eqe:first-idle'` at the first
 * `idle` after the initial projection is live; `window.__eqe.firstPaintMs` is the measure from
 * `eqe:start` to `eqe:first-idle`. The view starts on the whole world, fitted to the window.
 *
 * `window.__eqe` is the hook `scripts/probe-transition.mjs` drives the page through.
 */

// Imports are hoisted: this runs once they are loaded, as the first line of this module's code.
performance.mark('eqe:start');

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../style.css';

import {
  EqualEarthControl,
  installEqualEarth,
  resolveTransition,
  worldYRange,
  type CompensationMode,
  type GraticuleOptions,
  type InstallOptions,
  type LngLatTuple,
  type SwitchEvent,
  type Transition,
} from '../src/index.js';

type ProjectionType = 'equal' | 'equal-earth' | 'mercator';

const LIBERTY = 'https://tiles.openfreemap.org/styles/liberty';
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
/**
 * Text as shown on screen or handed to the probe: the values of key-like query parameters in any
 * URL it contains are elided, so a screenshot or a probe log does not leak a style's API key.
 */
const redact = (text: string): string =>
  text.replace(/([?&](?:key|apikey|api_key|access_token|token)=)[^&#\s'"()]*/gi, '$1…');

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
  note(`FAILED to ${what}: ${redact(error instanceof Error ? error.message : String(error))}`);
  throw error;
};

const styleUrl = params.get('style') || LIBERTY;
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
const withControl = params.get('control') !== '0';
const outside = params.get('outside') || undefined;
const outline = params.get('outline') === '1';
const graticuleParam = params.get('graticule');
const graticule: GraticuleOptions | true | undefined =
  graticuleParam === null || graticuleParam === ''
    ? undefined
    : graticuleParam === '1'
      ? true
      : { step: Number(graticuleParam) };
const persist = params.get('persist') !== '0';
const zoomOffset = numberParam('zoomOffset');

const onSwitch = (event: SwitchEvent): void => {
  log(
    `shown b${event.from}→b${event.to} at z${event.requestedZoom.toFixed(2)} ` +
      `(zoom's band b${event.target}; waited ${event.waitedMs.toFixed(0)} ms)` +
      (event.forced ? ' FORCED' : ''),
  );
};

const options: InstallOptions = {
  // Under `vite dev` the library's own `new URL('./worker.mjs', import.meta.url)` points into
  // `/src/`, where no worker exists: load the built one. The query string defeats Vite's
  // transform cache, which would otherwise keep serving the worker from before `npm run build:js`.
  workerUrl: new URL(`/dist/worker.mjs?v=${Date.now()}`, location.href),
  transition,
  onSwitch,
  ...(compensation ? { compensation } : {}),
  ...(workers !== undefined ? { workers } : {}),
  ...(outside ? { outsideColor: outside } : {}),
  ...(outline ? { outline: true } : {}),
  ...(graticule ? { graticule } : {}),
  ...(persist ? {} : { persistentCache: false }),
  ...(zoomOffset !== undefined ? { sourceZoomOffset: zoomOffset } : {}),
};
let install: Awaited<ReturnType<typeof installEqualEarth>>;
try {
  install = await installEqualEarth(maplibregl, options);
} catch (error) {
  install = fatal('install Equal Earth', error);
}
performance.mark('eqe:installed');

note(`style ${redact(styleUrl)}`);
note(
  `maplibre-gl ${install.version}; tiles warped on: ${install.workerPath}; ` +
    `workers: ${maplibregl.getWorkerCount()}`,
);
note(
  `projection ${projection}; steps ${resolved.steps} at z${resolved.bands
    .slice(1)
    .map((band) => band.minZoom.toFixed(2))
    .join(', z')}; compensation ${compensation ?? 'zoom+bearing (default)'}` +
    (zoomOffset !== undefined ? `; sourceZoomOffset ${zoomOffset}` : '') +
    (persist ? '' : '; persistent cache off'),
);

/**
 * The zoom at which the whole Equal Earth world fits the window: it spans the Mercator grid's
 * full width and {@link worldYRange} of its height, with a small margin.
 */
const worldZoom = (): number => {
  const element = document.getElementById('map')!;
  const [north, south] = worldYRange();
  const fit = Math.min(element.clientWidth / 512, element.clientHeight / (512 * (south - north)));
  return Math.max(0, Math.log2(fit * 0.95));
};

const map = new maplibregl.Map({
  container: 'map',
  style: styleUrl,
  center: [0, 0],
  zoom: worldZoom(),
  hash: false,
});
const controller = install.controllerFor(map);
// At once rather than after `load`: `load` waits for the Mercator view's tiles, which an
// application that starts in Equal Earth never needs.
if (projection !== 'mercator') {
  const onActive = (event: { newProjection?: unknown }): void => {
    if (event.newProjection !== projection) return;
    map.off('projectiontransition', onActive);
    performance.mark('eqe:active');
  };
  map.on('projectiontransition', onActive);
  map.setProjection({ type: projection });
}
const equalType = projection === 'mercator' ? 'equal' : projection;
if (withControl) map.addControl(new EqualEarthControl({ on: equalType }), 'top-right');

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
  errors.push(redact(message));
  log(`ERROR ${redact(message)}`);
});

// Exposed at once, so a probe sees errors (an unreachable style, say) before `ready`.
const eqe: {
  map: typeof map;
  controller: typeof controller;
  install: typeof install;
  transition: typeof resolved;
  shownBand: typeof shownBand;
  cities: typeof CITIES;
  errors: string[];
  ready: boolean;
  /** `eqe:start` → `eqe:first-idle`, in ms; set once. */
  firstPaintMs?: number;
} = { map, controller, install, transition: resolved, shownBand, cities: CITIES, errors, ready: false };
Object.assign(window, { __eqe: eqe });

/**
 * The first `idle` with the initial projection live. Not `style.load`: the plugin's own
 * `setStyle` is silent, as a native projection change is.
 */
const onIdle = (): void => {
  const live =
    projection === 'mercator' ||
    (controller.projection === projection && controller.pendingProjection === undefined);
  if (!live) return;
  map.off('idle', onIdle);
  performance.mark('eqe:first-idle');
  eqe.firstPaintMs = performance.measure('eqe:first-paint', 'eqe:start', 'eqe:first-idle').duration;
  note(`${projection}: ${map.getStyle().layers.length} layers`);
  note(`first paint: ${eqe.firstPaintMs.toFixed(0)} ms`);
  updateCentre();
  eqe.ready = true;
};
map.on('idle', onIdle);

const cities = document.getElementById('cities')!;
for (const [name, lngLat] of Object.entries(CITIES)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = name;
  button.addEventListener('click', () => {
    map.jumpTo({ center: lngLat });
  });
  cities.append(button);
}

const controls = document.getElementById('controls')!;
const world = document.createElement('button');
world.type = 'button';
world.textContent = 'world';
world.addEventListener('click', () => {
  map.jumpTo({ center: [0, 0], zoom: worldZoom(), bearing: 0 });
});
const toggle = document.createElement('button');
toggle.type = 'button';
/** The projection the map reports, so the button agrees with the control. */
const current = (): string => {
  try {
    const type = (map.getProjection() as { type?: unknown } | undefined)?.type;
    return typeof type === 'string' ? type : 'mercator';
  } catch {
    return 'mercator';
  }
};
const label = (): void => {
  const now = current();
  toggle.textContent = `projection: ${now} (switch to ${now === 'mercator' ? equalType : 'mercator'})`;
};
toggle.addEventListener('click', () => {
  const next = current() === 'mercator' ? equalType : 'mercator';
  map.setProjection({ type: next });
  log(`setProjection({ type: '${next}' })`);
  label();
});
map.on('projectiontransition', label);
label();
controls.append(world, toggle);

// Presets: each link reloads the page with its own parameters.
const presets = document.getElementById('presets')!;
const preset = (text: string, query: Record<string, string>): void => {
  const link = document.createElement('a');
  link.textContent = text;
  link.href = `${location.pathname}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`;
  presets.append(link);
};
preset('Liberty', {});
preset('Liberty + graticule + outline', { graticule: '30', outline: '1' });
const form = document.createElement('form');
const input = document.createElement('input');
input.type = 'url';
input.placeholder = 'your style URL (with ?key=)';
input.setAttribute('aria-label', 'style URL');
const submit = document.createElement('button');
submit.type = 'submit';
submit.textContent = 'your style';
form.append(input, submit);
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (url) location.search = `?${new URLSearchParams({ style: url })}`;
});
presets.append(form);
