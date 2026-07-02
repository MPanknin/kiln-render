import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    root: '.',
  },
  resolve: {
    alias: {
      '@kiln': resolve(__dirname, 'src'),
    },
  },
});
