import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // As in the builds (src/types/vendor.d.ts).
  define: { __EQE_VERSION__: JSON.stringify(version) },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Playwright's: `npm run test:browser`.
    exclude: ['tests/browser/**', 'node_modules/**'],
  },
});
