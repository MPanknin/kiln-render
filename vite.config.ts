import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE || '/kiln-render/',
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

