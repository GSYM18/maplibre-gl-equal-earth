/**
 * Guard for the worker bundles loaded via `importScriptInWorkers`.
 *
 * Both supported MapLibre majors load the worker script by URL, and neither can follow a
 * relative import out of it (see vite.worker.config.ts). This checks the built files
 * statically, then loads each one the way its MapLibre major would and confirms the
 * `eqearth` protocol registers:
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

const failures = [];

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
  const context = vm.createContext({
    addProtocol: (scheme, handler) => calls.push([scheme, typeof handler]),
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
}

const esm = read('worker.mjs');
if (esm !== null) {
  if (RELATIVE_IMPORT.test(esm)) {
    failures.push('worker.mjs: contains a relative import; it cannot resolve from a blob: URL or a CDN.');
  }

  const calls = [];
  globalThis.addProtocol = (scheme, handler) => calls.push([scheme, typeof handler]);
  try {
    await import(new URL('worker.mjs', dist).href);
  } catch (error) {
    failures.push(`worker.mjs: failed to import: ${String(error)}`);
  } finally {
    delete globalThis.addProtocol;
  }
  if (!registeredScheme(calls)) failures.push(`worker.mjs: did not register ${SCHEME}.`);
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
  'check-worker-bundles: worker.mjs and worker.iife.js are self-contained and register eqearth; ' +
    'index.js references both with literal new URL(…, import.meta.url).',
);
