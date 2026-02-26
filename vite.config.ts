import { defineConfig } from 'vite';

export default defineConfig({
  base: '/kiln-render/',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
  },
  worker: {
    format: 'es',
  },
});

