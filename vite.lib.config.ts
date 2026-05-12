import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // Don't copy public/ assets into the library output
  publicDir: false,
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'kiln-render.js',
    },
    outDir: 'lib',
    emptyOutDir: true,
    target: 'esnext',
    // Don't minify — consumers' bundlers handle that
    minify: false,
    // No externals: wgpu-matrix, zarrita, fflate are implementation details
    // that consumers should not need to install separately
    rollupOptions: {},
  },
  worker: {
    format: 'es',
  },
  resolve: {
    alias: {
      '@kiln': resolve(__dirname, 'src'),
    },
  },
});
