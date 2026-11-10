/**
 * Builds the worker-side protocol registration as one **self-contained** bundle, `worker.mjs`.
 *
 * `importScriptInWorkers` loads a script by URL into MapLibre's worker pool. MapLibre 6
 * `import()`s a `.mjs` URL directly; for any other extension it fetches the source, sniffs for
 * ESM and imports it through a `blob:` URL, where a relative specifier such as
 * `./protocol-abc.js` cannot resolve.
 *
 * So the bundle may import nothing, which rules out building the worker as a second entry of
 * the library build. `scripts/check-worker-bundles.mjs` guards the output. (The classic-script
 * `worker.iife.js` for MapLibre 5's `importScripts` went with MapLibre 5 support.)
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { eqeVersion } from './scripts/build-id.ts';

const resolveFromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Names the persistent tile cache the worker keeps (src/types/vendor.d.ts, Ruling R25).
  define: { __EQE_VERSION__: JSON.stringify(eqeVersion()) },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Runs after the library build into the same dist/; emptying it would delete index.js.
    emptyOutDir: false,
    lib: {
      entry: resolveFromRoot('src/tiles/worker-entry.ts'),
      formats: ['es'],
      fileName: () => 'worker.mjs',
    },
  },
});
