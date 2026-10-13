import { defineConfig } from 'vite';
import { resolve } from 'path';
import { selectionDemo } from './vite.selection-demo';
import { copyFavicons } from './vite.favicons';

export default defineConfig({
  root: 'examples/multichannel-viewer',
  // See vite.config.ts — VITE_BASE is the site-root prefix; this viewer lives
  // under <root>/app/multichannel/.
  base: (process.env.VITE_BASE ?? '/kiln-render/') + 'app/multichannel/',
  publicDir: resolve(__dirname, 'public'),
  plugins: [copyFavicons(), selectionDemo()],
  server: {
    port: 3001,
    open: true,
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    outDir: resolve(__dirname, 'dist/app/multichannel'),
    emptyOutDir: true,
    // public/ holds ~15 GB of dev-only test datasets — don't copy them into
    // the build (see vite.favicons.ts). Dev serving is unaffected.
    copyPublicDir: false,
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
