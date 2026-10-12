/**
 * Builds `dist/maplibre-gl-equal-earth.umd.js`: the library for a classic `<script src>` next to
 * MapLibre's own script, exposing the `maplibreglEqualEarth` global. The bundle imports nothing
 * (MapLibre is handed to `installEqualEarth`), so it needs no global for its peer.
 *
 * A build of its own, not a second format of `vite.config.ts`, because the two need different
 * `import.meta.url`s from the same transform. The ESM bundle must keep the literal
 * `new URL('./worker.mjs', import.meta.url)` for the application's bundler (P15). Rolldown,
 * unlike Rollup, does not polyfill `import.meta.url` in UMD output: it becomes `{}.url`, and
 * the default worker URL would not resolve. So here it is defined as the URL of the script
 * that loaded the bundle, captured in the intro while the script runs (`document.currentScript`
 * is null once it has finished), so the worker bundles are found next to the UMD file, on a CDN
 * too. `scripts/check-exports.mjs` checks the global's exports and that worker URL.
 *
 * It is `.js`, not `.umd.cjs`, so CDNs serve it as JavaScript; package.json therefore gives it
 * no `require` condition (under `"type": "module"` Node would read it as ESM).
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { eqeVersion } from './scripts/build-id.ts';

const resolveFromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const FILE_NAME = 'maplibre-gl-equal-earth.umd.js';
const SCRIPT_URL = '__eqeScriptUrl';

/** Mirrors Rollup's own UMD `import.meta.url`: the running script, else the page's base. */
const scriptUrlIntro = `var ${SCRIPT_URL} = typeof document === 'undefined'
  ? (typeof location === 'undefined' ? undefined : location.href)
  : (document.currentScript && document.currentScript.tagName.toUpperCase() === 'SCRIPT' && document.currentScript.src) ||
    new URL(${JSON.stringify(FILE_NAME)}, document.baseURI).href;`;

export default defineConfig({
  define: {
    __EQE_VERSION__: JSON.stringify(eqeVersion()),
    'import.meta.url': SCRIPT_URL,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Runs after the library build into the same dist/; emptying it would delete index.js.
    emptyOutDir: false,
    lib: {
      entry: resolveFromRoot('src/index.ts'),
      name: 'maplibreglEqualEarth',
      formats: ['umd'],
      fileName: () => FILE_NAME,
    },
    rollupOptions: {
      output: { intro: scriptUrlIntro },
    },
  },
});
