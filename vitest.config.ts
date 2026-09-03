import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    root: '.',
    // Playwright specs live in test/e2e and are run by `npm run test:e2e`.
    exclude: ['**/node_modules/**', 'test/e2e/**'],
  },
  resolve: {
    alias: {
      '@kiln': resolve(__dirname, 'src'),
    },
  },
});
