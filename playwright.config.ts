import { defineConfig, devices } from '@playwright/test';

/**
 * WebGPU smoke test config. Runs the built basic-viewer app (production
 * bundle served by `vite preview`) under headless Chromium. Unit tests are
 * vitest (`npm run test:run`); this only covers test/e2e.
 *
 * GPU backend:
 *   - Linux (CI runners have no GPU): SwiftShader, a CPU Vulkan implementation.
 *   - macOS / Windows (local runs): the native GPU via Chrome's default backend.
 *     Forcing SwiftShader here breaks canvas presentation, so don't.
 */
const isLinux = process.platform === 'linux';

const chromiumArgs = [
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  ...(isLinux
    ? [
        '--enable-features=Vulkan',
        '--use-angle=vulkan',
        '--use-vulkan=swiftshader',
        '--enable-unsafe-swiftshader',
      ]
    : []),
];

export default defineConfig({
  testDir: './test/e2e',
  timeout: 180_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Production build + static preview, not the dev server: the dev server's
  // dependency optimizer can trigger a full page reload mid-test, and the
  // built bundle is what actually ships.
  webServer: {
    command: 'npx vite build && npx vite preview --port 3000 --strictPort',
    url: 'http://localhost:3000/kiln-render/app/',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        // Full Chromium (new headless), not the headless shell — the shell
        // lacks the GPU process WebGPU needs.
        channel: 'chromium',
        launchOptions: { args: chromiumArgs },
      },
    },
  ],
});
