import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const resolveFromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: {
      // ESM only: maplibre-gl v6 dropped CJS, so a UMD/CJS build of a plugin
      // whose peer dependency is ESM-only would have no valid consumer.
      entry: {
        index: resolveFromRoot('src/index.ts'),
        // Built separately because `importScriptInWorkers` loads it by URL into
        // MapLibre's worker pool; no closure can cross that boundary.
        worker: resolveFromRoot('src/tiles/worker-entry.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['maplibre-gl'],
    },
  },
});
