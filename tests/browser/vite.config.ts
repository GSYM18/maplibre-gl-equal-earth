/**
 * The dev server the browser tests run against (`tests/browser/playwright.config.ts` starts it).
 * Unlike the root config it has no library `build.lib` section: it only serves the harness page,
 * `src/` through Vite's transform, the built worker bundles from `/dist/`, both MapLibre majors
 * from `/node_modules/`, and the in-memory fixture tiles.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { fixtureTilesPlugin } from './fixture-tiles.ts';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // The harness compiles src/ through Vite, the main-thread protocol fallback included
  // (src/types/vendor.d.ts).
  define: { __EQE_VERSION__: JSON.stringify(version) },
  // The repository root, wherever the command runs from: the harness loads `/src/`, `/dist/` and
  // `/node_modules/` by absolute path.
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [fixtureTilesPlugin()],
  optimizeDeps: {
    // As in the root config: pre-bundling would separate maplibre-gl v6 from its worker file.
    exclude: ['maplibre-gl'],
  },
  server: { port: 5179, strictPort: true },
});
