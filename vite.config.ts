import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import MagicString from 'magic-string';
import { defineConfig, type Plugin } from 'vite';

const resolveFromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const { version } = JSON.parse(readFileSync(resolveFromRoot('package.json'), 'utf8')) as { version: string };

/**
 * `src/install.ts` marks its worker URLs `new URL(/* @vite-ignore *\/ './worker.mjs',
 * import.meta.url)`: the worker files do not exist when this library build runs, and without
 * the hint Vite rewrites the second argument to `"" + import.meta.url`, which the
 * application's bundler (webpack, Rollup, Parcel, Vite) no longer recognises as an asset. The
 * hint must not reach the published bundle either, or the application's own Vite build would
 * skip the asset too. So it is removed here, leaving the plain literal pattern;
 * `scripts/check-worker-bundles.mjs` asserts that pattern (Ruling P15).
 */
function stripWorkerUrlHint(): Plugin {
  const pattern = /new URL\(\s*\/\* @vite-ignore \*\/\s*("\.\/worker\.(?:mjs|iife\.js)"),\s*import\.meta\.url\s*\)/g;
  return {
    name: 'equal-earth:strip-worker-url-hint',
    renderChunk(code) {
      const output = new MagicString(code);
      for (const match of code.matchAll(pattern)) {
        output.overwrite(match.index, match.index + match[0].length, `new URL(${match[1]}, import.meta.url)`);
      }
      return output.hasChanged() ? { code: output.toString(), map: output.generateMap({ hires: true }) } : null;
    },
  };
}

export default defineConfig({
  plugins: [stripWorkerUrlHint()],
  // Names the persistent tile cache (src/types/vendor.d.ts); also serves `npm run dev`.
  define: { __EQE_VERSION__: JSON.stringify(version) },
  optimizeDeps: {
    // maplibre-gl v6 locates its worker as a sibling file via `import.meta.url`. Pre-bundling
    // moves the main module into node_modules/.vite/deps/, where that sibling does not exist,
    // so the dev server would leave the worker request pending forever.
    exclude: ['maplibre-gl'],
  },
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
