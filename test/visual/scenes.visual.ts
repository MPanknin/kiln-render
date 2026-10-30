import { test, expect } from '@playwright/test';

// Each scene renders until the viewer's bench report says it converged, then the canvases are
// compared with baselines/<scene>-<platform>.png. KILN_GPU (a pattern, e.g. "nvidia") fails the
// test on any other WebGPU adapter, so a silent fallback to a software renderer can't pass.
const SYNTH = 'http://127.0.0.1:5199/synth.zarr';
// Zarr v3, sharded, zstd: one level, 128³ uint8
const HYDROGEN = 'http://127.0.0.1:5199/hydrogen_atom.ome.zarr';

interface Scene {
  name: string;
  dataset: string;
  query: string;
  /** Label bricks arrive after the image has converged */
  settleMs?: number;
}

const SCENES: Scene[] = [
  { name: 'synth-dvr', dataset: SYNTH, query: 'mode=dvr' },
  { name: 'synth-mip', dataset: SYNTH, query: 'mode=mip' },
  { name: 'synth-iso', dataset: SYNTH, query: 'mode=iso&iso=0.4' },
  { name: 'synth-slice', dataset: SYNTH, query: 'mode=slice' },
  { name: 'synth-labels-dvr', dataset: SYNTH, query: 'mode=dvr&labels=cells', settleMs: 4000 },
  { name: 'synth-labels-slice', dataset: SYNTH, query: 'mode=slice&labels=cells:0.8:surface:both', settleMs: 4000 },
  { name: 'hydrogen-dvr', dataset: HYDROGEN, query: 'mode=dvr&tf=plasma' },
  { name: 'hydrogen-mip', dataset: HYDROGEN, query: 'mode=mip&tf=plasma' },
  { name: 'hydrogen-iso', dataset: HYDROGEN, query: 'mode=iso&iso=0.3' },
];

test.beforeEach(async ({ page }) => {
  // Record the adapter Kiln gets and whether its device is lost
  await page.addInitScript(() => {
    const w = window as any;
    w.__gpu = { adapter: '', lost: '' };
    const requestAdapter = GPU.prototype.requestAdapter;
    GPU.prototype.requestAdapter = async function (...a: any[]) {
      const adapter = await requestAdapter.apply(this, a as any);
      const i = adapter?.info;
      w.__gpu.adapter = i ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') : '';
      return adapter;
    };
    const requestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...a: any[]) {
      const device = await requestDevice.apply(this, a as any);
      device.lost.then(i => { w.__gpu.lost = `${i.reason}: ${i.message}`; });
      return device;
    };
  });
});

for (const scene of SCENES) {
  test(scene.name, async ({ page }) => {
    await page.goto(`?dataset=${encodeURIComponent(scene.dataset)}&${scene.query}&bench=1&benchTimeout=150000`);
    const report = await page
      .waitForFunction(() => (window as any).__KILN_BENCH_RESULT, null, { timeout: 180_000 })
      .then(h => h.jsonValue());
    const gpu = await page.evaluate(() => (window as any).__gpu);
    test.info().annotations.push(
      { type: 'adapter', description: gpu.adapter },
      { type: 'converged', description: `${Math.round(report.convergeMs)} ms` },
    );
    if (process.env.KILN_GPU) expect(gpu.adapter, 'WebGPU adapter').toMatch(new RegExp(process.env.KILN_GPU, 'i'));
    expect(gpu.lost, 'device lost').toBe('');
    expect(report.timedOut, 'converged before the bench timeout').toBe(false);
    if (scene.settleMs) await page.waitForTimeout(scene.settleMs);
    await expect(page).toHaveScreenshot(`${scene.name}.png`);
  });
}
