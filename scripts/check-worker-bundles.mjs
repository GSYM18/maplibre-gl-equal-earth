/**
 * Guard for the worker bundles loaded via `importScriptInWorkers`.
 *
 * Both supported MapLibre majors load the worker script by URL, and neither can follow a
 * relative import out of it (see vite.worker.config.ts). This checks the built files
 * statically, then loads each one the way its MapLibre major would and confirms the
 * `eqearth` protocol registers and that native Equal Earth's GeoJSON projection handler
 * (MapLibre 6.15+ `setProjectionHandler`) is set and builds the Equal Earth converter:
 *
 * - `worker.iife.js` is evaluated as a classic script in a fresh VM context, as v5's
 *   `importScripts` does. It must not match MapLibre v6's ESM sniff either.
 * - `worker.mjs` is dynamically imported, as v6 does for `.mjs` URLs.
 *
 * Run after `npm run build`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const dist = new URL('../dist/', import.meta.url);
/** The exact test MapLibre v6's worker `loadScript` uses to decide a script is ESM. */
const ESM_SNIFF = /^[ \t]*(import|export)\s/m;
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

const iife = read('worker.iife.js');
if (iife !== null) {
  if (ESM_SNIFF.test(iife)) {
    failures.push('worker.iife.js: contains top-level import/export; v5 importScripts would throw.');
  }
  if (RELATIVE_IMPORT.test(iife)) failures.push('worker.iife.js: contains a relative import.');

  const calls = [];
  const handlers = [];
  const context = vm.createContext({
    addProtocol: (scheme, handler) => calls.push([scheme, typeof handler]),
    setProjectionHandler: (handler) => handlers.push(handler),
    console,
    fetch,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  try {
    vm.runInContext(iife, context, { filename: 'worker.iife.js' });
  } catch (error) {
    failures.push(`worker.iife.js: threw when evaluated as a classic script: ${String(error)}`);
  }
  if (!registeredScheme(calls)) failures.push(`worker.iife.js: did not register ${SCHEME}.`);
  checkHandler('worker.iife.js', handlers);
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

// Ruling P15: the main bundle must reference each worker with the literal
// `new URL("./worker…", import.meta.url)`, the only form application bundlers emit as an asset
// (see the strip plugin in vite.config.ts).
const index = read('index.js');
if (index !== null) {
  for (const file of ['./worker.mjs', './worker.iife.js']) {
    const literal = `new URL(${JSON.stringify(file)}, import.meta.url)`;
    if (!index.includes(literal)) failures.push(`index.js: missing the literal \`${literal}\`.`);
  }
  if (index.includes('@vite-ignore')) failures.push('index.js: a @vite-ignore hint reached the bundle.');
}

if (failures.length > 0) {
  console.error(`check-worker-bundles:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}

console.log(
  'check-worker-bundles: worker.mjs and worker.iife.js are self-contained, register eqearth and set the ' +
    'Equal Earth projection handler; ' +
    'index.js references both with literal new URL(…, import.meta.url).',
);
