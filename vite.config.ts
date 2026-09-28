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
      //
      // The worker bundles are *not* a second entry here: a multi-entry build hoists
      // shared code into chunks, and a worker script cannot import a chunk. They have
      // their own build, vite.worker.config.ts.
      entry: { index: resolveFromRoot('src/index.ts') },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['maplibre-gl'],
    },
  },
});
