import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFavicons } from './vite.favicons';

export default defineConfig({
  root: 'examples/basic-viewer',
  // VITE_BASE is the site-root prefix (default /kiln-render/); the viewer app
  // always lives under <root>/app/. The site build uses the bare root; CI
  // preview overrides VITE_BASE with a branch-specific prefix.
  base: (process.env.VITE_BASE || '/kiln-render/') + 'app/',
  publicDir: resolve(__dirname, 'public'),
  plugins: [copyFavicons()],
  server: {
    port: 3000,
    open: !process.env.CI,
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    outDir: resolve(__dirname, 'dist/app'),
    emptyOutDir: true,
    // public/ holds ~15 GB of dev-only test datasets — don't copy them into
    // the build (see vite.favicons.ts). Dev serving is unaffected.
    copyPublicDir: false,
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
