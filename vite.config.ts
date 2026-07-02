import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'examples/basic-viewer',
  base: process.env.VITE_BASE || '/kiln-render/',
  publicDir: resolve(__dirname, 'public'),
  server: {
    port: 3000,
    open: true,
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        // Inline all dynamic imports (zarrita codec chunks) into the worker
        // bundle so it is self-contained when run from a blob: URL
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: {
      // Allows example code to import from 'kiln-render' without publishing
      'kiln-render': resolve(__dirname, 'src/index.ts'),
      // Allows example code to reach internal library modules cleanly
      '@kiln': resolve(__dirname, 'src'),
    },
  },
});
