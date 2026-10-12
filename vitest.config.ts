import { defineConfig } from 'vitest/config';

import { eqeVersion } from './scripts/build-id.ts';

export default defineConfig({
  // As in the builds (src/types/vendor.d.ts).
  define: { __EQE_VERSION__: JSON.stringify(eqeVersion()) },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Playwright's: `npm run test:browser`.
    exclude: ['tests/browser/**', 'node_modules/**'],
  },
});
