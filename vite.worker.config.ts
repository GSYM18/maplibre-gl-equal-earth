/**
 * Builds the worker-side protocol registration as two **self-contained** bundles.
 *
 * `importScriptInWorkers` loads a script by URL into MapLibre's worker pool, and the two
 * supported majors load it differently:
 *
 * - v5 calls classic `importScripts(url)`, so any top-level `import`/`export` is a SyntaxError.
 * - v6 `import()`s a `.mjs` URL directly. For any other extension it fetches the source,
 *   sniffs for ESM and imports it through a `blob:` URL — where a relative specifier such
 *   as `./protocol-abc.js` cannot resolve.
 *
 * So neither bundle may import anything, which rules out building the worker as a second
 * entry of the library build. `scripts/check-worker-bundles.mjs` guards both outputs.
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
      formats: ['es', 'iife'],
      // Required by the IIFE format. The entry exports nothing, so the global stays empty.
      name: 'EqualEarthWorker',
      fileName: (format) => (format === 'es' ? 'worker.mjs' : 'worker.iife.js'),
    },
  },
});
