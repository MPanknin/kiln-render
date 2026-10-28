import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Visual snapshot tests (test/visual): the basic viewer renders scenes on a real GPU and each image
// is compared with its baseline. Chromium runs headed: headless Chromium can't present WebGPU
// canvases on Linux (CI runs it under Xvfb). KILN_CHROME_ARGS replaces the browser flags.
const linux = process.platform === 'linux';
const args = process.env.KILN_CHROME_ARGS?.split(' ')
  ?? ['--enable-unsafe-webgpu', ...(linux ? ['--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-angle=vulkan'] : [])];

export default defineConfig({
  testDir: 'test/visual',
  testMatch: '*.visual.ts',
  snapshotPathTemplate: '{testDir}/baselines/{arg}-{platform}{ext}',
  timeout: 240_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  expect: {
    timeout: 30_000,
    // Renders on one machine are near bit-identical: a pixel may differ by a few levels
    // (threshold), and at most 0.1% of pixels by more
    toHaveScreenshot: {
      threshold: 0.02,
      maxDiffPixelRatio: 0.001,
      stylePath: fileURLToPath(new URL('test/visual/hide-ui.css', import.meta.url)),
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:5173/kiln-render/app/',
    viewport: { width: 1280, height: 800 },
    headless: false,
    launchOptions: { args },
  },
  webServer: [
    {
      command: 'bun run build && bunx vite preview --port 5173 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:5173/kiln-render/app/',
      env: { BROWSER: 'none' },
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node test/visual/serve-data.mjs',
      url: 'http://127.0.0.1:5199/synth.zarr/.zattrs',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
