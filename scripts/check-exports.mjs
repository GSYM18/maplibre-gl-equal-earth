/**
 * Guard against the failure that broke `maplibre-gl-equal-earth@0.2.1`: `lib/` was renamed,
 * `dist/` was never rebuilt, and the published bundle exported a function name that no longer
 * existed while omitting two that did. Nothing detected it for two years.
 *
 * Compares the runtime exports of both built bundles against the value exports declared in
 * `src/index.ts`: the ESM `dist/index.js`, and the UMD `dist/maplibre-gl-equal-earth.umd.js`
 * evaluated as a classic `<script>` would, through the `maplibreglEqualEarth` global it
 * defines. For the UMD it also checks the default worker URL resolves next to the loading
 * script (vite.umd.config.ts). Run after `npm run build`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = new URL('..', import.meta.url);
const entrySource = readFileSync(new URL('src/index.ts', repoRoot), 'utf8');

/** Value (non-type) export names declared by src/index.ts. */
function declaredValueExports(source) {
  // Strip block and line comments so commented-out exports are not counted.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const names = new Set();
  for (const match of code.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const rawSpecifier of match[1].split(',')) {
      const specifier = rawSpecifier.trim();
      if (specifier === '' || specifier.startsWith('type ')) continue;
      // `X as Y` publishes Y.
      const parts = specifier.split(/\s+as\s+/);
      names.add((parts[1] ?? parts[0]).trim());
    }
  }
  return names;
}

const expected = declaredValueExports(entrySource);
if (expected.size === 0) {
  console.error('check-exports: parsed zero exports from src/index.ts — the parser is broken.');
  process.exit(1);
}

const bundleUrl = new URL('dist/index.js', repoRoot);
let bundle;
try {
  // Import by URL href, not by path: on Windows a drive-letter path is rejected by the
  // ESM loader as an unsupported URL scheme ('c:').
  bundle = await import(bundleUrl.href);
} catch (error) {
  console.error(
    `check-exports: could not import ${fileURLToPath(bundleUrl)}. Run \`npm run build\` first.`,
  );
  console.error(error);
  process.exit(1);
}

/** Reports a mismatch between `expected` and `actual` for `label`; true if they match. */
function compare(label, actual) {
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  const extra = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length === 0 && extra.length === 0) return true;

  console.error(`check-exports: ${label} does not match src/index.ts.\n`);
  if (missing.length > 0) {
    console.error(`  declared in src but absent from the bundle: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    console.error(`  present in the bundle but not declared in src: ${extra.join(', ')}`);
  }
  console.error('\nRebuild with `npm run build`.');
  return false;
}

const esmExports = new Set(Object.keys(bundle).filter((key) => key !== 'default'));

/**
 * The UMD bundle's exports, read from the global it defines in a browser-like context with no
 * `module`, `exports` or `define`, as a page's `<script src>` runs it. `document.currentScript`
 * is what the bundle's `import.meta.url` stands in for (the worker URL's base).
 */
async function umdExports() {
  const umdUrl = new URL('dist/maplibre-gl-equal-earth.umd.js', repoRoot);
  let source;
  try {
    source = readFileSync(umdUrl, 'utf8');
  } catch {
    console.error(`check-exports: missing ${fileURLToPath(umdUrl)}. Run \`npm run build\` first.`);
    return null;
  }
  const script = { tagName: 'SCRIPT', src: 'https://cdn.example/eqe/maplibre-gl-equal-earth.umd.js' };
  const context = vm.createContext({
    document: { currentScript: script, baseURI: 'https://app.example/' },
    console,
    URL,
    fetch,
  });
  context.self = context;
  context.window = context;
  try {
    vm.runInContext(source, context, { filename: 'maplibre-gl-equal-earth.umd.js' });
  } catch (error) {
    console.error('check-exports: the UMD bundle threw when evaluated as a classic script.');
    console.error(error);
    return null;
  }
  const global = context.maplibreglEqualEarth;
  if (global === undefined) {
    console.error('check-exports: the UMD bundle did not define the `maplibreglEqualEarth` global.');
    return null;
  }
  if (!(await umdWorkerUrlsResolve(global, new URL('.', script.src).href))) return null;
  return new Set(Object.keys(global).filter((key) => key !== 'default'));
}

/**
 * Rolldown leaves `import.meta.url` as `{}.url` in UMD output, so vite.umd.config.ts supplies
 * the loading script's URL. Checks the default worker URL `installEqualEarth` hands MapLibre
 * sits next to that script for each major. The fake stops the install right after: the worker
 * script "fails", and the main-thread fallback's `addProtocol` throws.
 */
async function umdWorkerUrlsResolve(global, scriptDir) {
  const stop = new Error('check-exports: stop');
  let ok = true;
  for (const [version, file] of [['5.24.0', 'worker.iife.js'], ['6.6.0', 'worker.mjs']]) {
    const requested = [];
    const fake = {
      Map: class {},
      getVersion: () => version,
      getWorkerCount: () => 2,
      importScriptInWorkers: (url) => {
        requested.push(url);
        throw new Error('not loaded');
      },
      addProtocol: () => {
        throw stop;
      },
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      await global.installEqualEarth(fake);
    } catch (error) {
      if (error !== stop) {
        console.error(`check-exports: the UMD install for ${version} failed early.`);
        console.error(error);
        ok = false;
        continue;
      }
    } finally {
      console.warn = warn;
    }
    const expectedUrl = scriptDir + file;
    if (requested[0] !== expectedUrl) {
      console.error(
        `check-exports: the UMD bundle's default worker URL for ${version} is ${String(requested[0])},` +
          ` not ${expectedUrl}.`,
      );
      ok = false;
    }
  }
  return ok;
}

const umd = await umdExports();
const esmOk = compare('dist/index.js', esmExports);
const umdOk = umd !== null && compare('dist/maplibre-gl-equal-earth.umd.js', umd);
if (!esmOk || !umdOk) process.exit(1);

console.log(`check-exports: ${esmExports.size} exports of the ESM and UMD bundles match src/index.ts.`);
