import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'examples/multichannel-viewer',
  base: (process.env.VITE_BASE ?? '/kiln-render/') + 'multichannel/',
  publicDir: resolve(__dirname, 'public'),
  server: {
    port: 3001,
    open: true,
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    outDir: resolve(__dirname, 'dist/multichannel'),
    emptyOutDir: true,
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: {
      'kiln-render': resolve(__dirname, 'src/index.ts'),
      '@kiln': resolve(__dirname, 'src'),
    },
  },
});
