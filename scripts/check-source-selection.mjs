/** Optional browser check: real HTTP worker decoding + selection controls, no GPU needed.
 * Install Playwright separately. PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE may select existing installs.
 * Run: node scripts/check-source-selection.mjs
 */
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const vite = await createServer({ configFile: false, root, base: '/', logLevel: 'error',
  plugins: [{ name: 'selection-check-page', configureServer(server) {
    server.middlewares.use('/selection-check', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Selection check</title><button id="load-dataset-btn">Load</button>');
    });
  } }],
  optimizeDeps: { entries: [], include: ['zarrita', 'numcodecs/blosc', 'numcodecs/lz4', 'numcodecs/zstd'] },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }, worker: { format: 'es' } });
const { selectionDemoFiles } = await vite.ssrLoadModule('/vite.selection-demo.ts');
const files = selectionDemoFiles();
const fixture = httpServer((req, res) => {
  const data = files.get(req.url.replace('/fixture.zarr/', ''));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.statusCode = data ? 200 : 404; res.end(data);
});
let browser;
try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const source = `http://127.0.0.1:${fixture.address().port}/fixture.zarr`;
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  page.on('pageerror', error => console.error(error));
  const timeout = setTimeout(() => { console.error('Browser check timed out'); void browser.close(); }, 60000);
  timeout.unref();
  await page.goto(`${origin}/selection-check`);
  const results = await page.evaluate(async ({ origin, source }) => {
    const { ZarrDataProvider } = await import('/src/data/zarr-provider.ts');
    const results = [];
    // One provider: cross chunk boundaries in T and C by switching the live selection, then return.
    const provider = new ZarrDataProvider(source);
    try {
    for (const timepoint of [0, 1, 3, 0]) {
      provider.setSourceSelection({ sourceChannels: [5, 1], timepoint });
      {
        const metadata = await provider.initialize();
        for (const slot of [0, 1]) {
          const brick = await provider.loadBrick(0, 0, 0, 0, slot);
          if (!brick) throw new Error('Missing brick');
          const c = [5, 1][slot], angle = c * Math.PI / 3;
          const center = [16 + 9 * Math.cos(angle), 16 + 9 * Math.sin(angle), 7 + timepoint * 6];
          for (let z = 0; z < 66; z++) for (let y = 0; y < 66; y++) for (let x = 0; x < 66; x++) {
            const distance = Math.hypot(Math.max(0, Math.min(31, x - 1)) - center[0],
              Math.max(0, Math.min(31, y - 1)) - center[1], Math.max(0, Math.min(31, z - 1)) - center[2]);
            const expected = Math.round(255 * Math.max(0, Math.min(1, 4.5 - distance)));
            if (brick.data[(z * 66 + y) * 66 + x] !== expected) throw new Error(`Mismatch t${timepoint} c${c} xyz${x},${y},${z}`);
          }
        }
        results.push({ timepoint, sourceChannels: metadata.sourceChannels, voxelsChecked: 2 * 66 ** 3 });
        if (results.length === 4) {
          // Stand-in viewer: records in-place switches and mirrors them into the metadata, like the engine does.
          const { applySourceSelection, writeSourceSelection } = await import('/examples/shared/source-selection.ts');
          const { createTimeSlider, createChannelPicker, withSlotSource, timeShortcuts } = await import('/examples/shared/source-controls.ts');
          const { mountShortcuts } = await import('/examples/shared/shortcuts.ts');
          const viewer = { metadata, setSourceSelection(selection) { window.__applied = selection; Object.assign(metadata, selection); } };
          history.replaceState(null, '', '/app/multichannel/');
          const buildShareUrl = () => {
            const p = new URLSearchParams('cam=1,2,3&channels=old');
            writeSourceSelection(p, metadata);
            return `${origin}/app/multichannel/?${p}`;
          };
          const apply = selection => applySourceSelection(viewer, selection, source, false, buildShareUrl);
          const slider = createTimeSlider(metadata, timepoint => apply({ sourceChannels: metadata.sourceChannels, timepoint }));
          document.body.append(slider.el, createChannelPicker(metadata, 1, s => apply({ sourceChannels: withSlotSource(metadata.sourceChannels, 1, s), timepoint: metadata.timepoint })));
          mountShortcuts(timeShortcuts(d => slider.step(d)));
        }
      }
    }
    } finally { provider.dispose(); }
    return results;
  }, { origin, source });
  // Time slider: release applies the exact value in place and updates the address bar.
  await page.locator('.ctl-time-row input').fill('4');
  await page.locator('.ctl-time-row input').dispatchEvent('change');
  assert.deepEqual(await page.evaluate(() => window.__applied), { sourceChannels: [5, 1], timepoint: 3 });
  assert.equal(await page.locator('.ctl-time-row .ctl-slider-value').innerText(), '4 / 4');
  let url = new URL(page.url());
  assert.equal(url.pathname, '/app/multichannel/');
  assert.equal(url.searchParams.get('timepoint'), '3');
  assert.equal(url.searchParams.get('cam'), '1,2,3');
  // Keyboard: `,` steps back one timepoint, even with the slider focused.
  await page.keyboard.press(',');
  assert.deepEqual(await page.evaluate(() => window.__applied), { sourceChannels: [5, 1], timepoint: 2 });
  assert.equal(await page.locator('.ctl-time-row .ctl-slider-value').innerText(), '3 / 4');
  // Step buttons: one click, one timepoint; the first button is disabled at the start.
  await page.locator('.ctl-time-step:not(.prev)').click();
  assert.deepEqual(await page.evaluate(() => window.__applied), { sourceChannels: [5, 1], timepoint: 3 });
  assert.equal(await page.locator('.ctl-time-step:not(.prev)').isDisabled(), true); // at the last timepoint
  await page.locator('.ctl-time-step.prev').click();
  assert.deepEqual(await page.evaluate(() => window.__applied), { sourceChannels: [5, 1], timepoint: 2 });
  // Channel picker: a source already on display swaps slots instead of duplicating.
  await page.locator('.ctl-channel-select').selectOption('5');
  assert.deepEqual(await page.evaluate(() => window.__applied), { sourceChannels: [1, 5], timepoint: 2 });
  url = new URL(page.url());
  assert.equal(url.searchParams.get('sourceChannels'), '1,5');
  // Down to one channel: the single-channel viewer has the matching controls, so navigate there.
  await page.route('**/app/?**', route => route.fulfill({ contentType: 'text/html', body: '<title>Single</title>' }));
  await Promise.all([page.waitForURL('**/app/?**'), page.locator('.ctl-channel-select').selectOption('')]);
  url = new URL(page.url());
  assert.equal(url.searchParams.get('sourceChannels'), '1');
  assert.equal(url.searchParams.get('timepoint'), '2');
  assert.equal(url.searchParams.get('dataset'), source);
  assert.equal(url.searchParams.has('channels'), false); // slot display settings don't follow a remap
  console.log(JSON.stringify({ workerChecks: results, ui: 'time slider + shortcut + channel picker + viewer switch passed' }, null, 2));
} finally {
  await browser?.close(); await vite.close(); fixture.closeAllConnections(); fixture.close();
}
