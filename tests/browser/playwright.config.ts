/**
 * The browser matrix: every spec runs against MapLibre 6 (`v6`) and 5.24 (`v5`) in headless
 * Chromium, rendering through SwiftShader. `npm run build` must have run first: the harness loads
 * the worker bundles from `/dist/`.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

import type { MapLibreMajor } from './helpers.ts';

export default defineConfig<{ mlv: MapLibreMajor }>({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  webServer: {
    command: 'npx vite --config tests/browser/vite.config.ts',
    // The command's paths are relative to the repository root, not to this file.
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://localhost:5179/tests/browser/harness.html',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  use: {
    baseURL: 'http://localhost:5179',
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    { name: 'v6', use: { mlv: 6 } },
    { name: 'v5', use: { mlv: 5 } },
  ],
});
