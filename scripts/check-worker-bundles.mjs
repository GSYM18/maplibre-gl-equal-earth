/**
 * Guard for the worker bundle loaded via `importScriptInWorkers`.
 *
 * MapLibre 6 loads the worker script by URL and cannot follow a relative import out of it (see
 * vite.worker.config.ts). This checks `worker.mjs` statically, then imports it dynamically, as
 * MapLibre does for `.mjs` URLs, and confirms the `eqearth` protocol registers and that native
 * Equal Earth's GeoJSON projection handler (MapLibre 6.15+ `setProjectionHandler`) is set and
 * builds the Equal Earth converter. The classic-script `worker.iife.js` (MapLibre 5's
 * `importScripts`) went with MapLibre 5 support; a leftover one in `dist/` fails the check.
 *
 * Run after `npm run build`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = new URL('../dist/', import.meta.url);
/** A static or dynamic import of a relative specifier. */
const RELATIVE_IMPORT = /(\bfrom|\bimport\s*\(?)\s*['"]\.\.?\//;
const SCHEME = 'eqearth';
/** `EQUAL_EARTH_DEFINITION` in `src/math/crs.ts`. */
const DEFINITION = '+proj=eqearth +R=6371008.7714 +units=m +no_defs';

const failures = [];

/** The last projection handler set builds a converter that round-trips for our definition. */
function checkHandler(name, handlers) {
  const handler = handlers.at(-1);
  if (typeof handler !== 'function') {
    failures.push(`${name}: did not set a projection handler.`);
    return;
  }
  try {
    const converter = handler(DEFINITION);
    const back = converter.inverse(converter.forward([10, 20]));
    if (!(Math.abs(back[0] - 10) < 1e-9 && Math.abs(back[1] - 20) < 1e-9)) {
      failures.push(`${name}: the projection handler's converter does not round-trip.`);
    }
  } catch (error) {
    failures.push(`${name}: the projection handler threw for the Equal Earth definition: ${String(error)}`);
  }
}

function read(name) {
  const url = new URL(name, dist);
  try {
    return readFileSync(url, 'utf8');
  } catch {
    failures.push(`${name}: missing (looked for ${fileURLToPath(url)}). Run \`npm run build\` first.`);
    return null;
  }
}

const registeredScheme = (calls) =>
  calls.some(([scheme, handlerType]) => scheme === SCHEME && handlerType === 'function');

if (existsSync(new URL('worker.iife.js', dist))) {
  failures.push('worker.iife.js: present in dist/, but MapLibre 5 support is gone; rebuild from a clean dist/.');
}

const esm = read('worker.mjs');
if (esm !== null) {
  if (RELATIVE_IMPORT.test(esm)) {
    failures.push('worker.mjs: contains a relative import; it cannot resolve from a blob: URL or a CDN.');
  }

  const calls = [];
  const handlers = [];
  globalThis.addProtocol = (scheme, handler) => calls.push([scheme, typeof handler]);
  globalThis.setProjectionHandler = (handler) => handlers.push(handler);
  try {
    await import(new URL('worker.mjs', dist).href);
  } catch (error) {
    failures.push(`worker.mjs: failed to import: ${String(error)}`);
  } finally {
    delete globalThis.addProtocol;
    delete globalThis.setProjectionHandler;
  }
  if (!registeredScheme(calls)) failures.push(`worker.mjs: did not register ${SCHEME}.`);
  checkHandler('worker.mjs', handlers);
}

// Ruling P15: the main bundle must reference the worker with the literal
// `new URL("./worker.mjs", import.meta.url)`, the only form application bundlers emit as an asset
// (see the strip plugin in vite.config.ts).
const index = read('index.js');
if (index !== null) {
  const literal = `new URL(${JSON.stringify('./worker.mjs')}, import.meta.url)`;
  if (!index.includes(literal)) failures.push(`index.js: missing the literal \`${literal}\`.`);
  if (index.includes('worker.iife.js')) failures.push('index.js: still references worker.iife.js.');
  if (index.includes('@vite-ignore')) failures.push('index.js: a @vite-ignore hint reached the bundle.');
}

if (failures.length > 0) {
  console.error(`check-worker-bundles:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}

console.log(
  'check-worker-bundles: worker.mjs is self-contained, registers eqearth and sets the ' +
    'Equal Earth projection handler; index.js references it with a literal new URL(…, import.meta.url).',
);
