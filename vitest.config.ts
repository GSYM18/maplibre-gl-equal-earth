import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Playwright's: `npm run test:browser`.
    exclude: ['tests/browser/**', 'node_modules/**'],
  },
});
