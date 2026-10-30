import { test, expect } from '@playwright/test';

// Each scene renders until the viewer's bench report says it converged, then the canvases are
// compared with baselines/<scene>-<platform>.png. KILN_GPU (a pattern, e.g. "nvidia") fails the
// test on any other WebGPU adapter, so a silent fallback to a software renderer can't pass.
const SYNTH = 'http://127.0.0.1:5199/synth.zarr';
const SYNTH_U16 = 'http://127.0.0.1:5199/synth-u16.zarr';
const SYNTH_F32 = 'http://127.0.0.1:5199/synth-f32.zarr';
// 3 timepoints × 5 channels, 90×120×100 voxels with z spacing 2. More than one source channel
// opens the multichannel viewer.
const SYNTH_TC = 'http://127.0.0.1:5199/synth-tc.zarr';
// Closer than the default camera (0.3, 3.5, 3.0), so the synthetic volumes fill more of the image
const ZOOM = 'cam=0.3,3.5,2.0';
// Zarr v3, sharded, zstd: one level, 128³ uint8
const HYDROGEN = 'http://127.0.0.1:5199/hydrogen_atom.ome.zarr';
// Camera, transfer function and contrast shared by the hydrogen scenes
const HYDROGEN_VIEW = 'wc=0.13&ww=0.26&density=1.00&shade=0.00&boundary=0.00&iso=0.20&tf=plasma'
  + '&tfpts=0.00%2C0.00%2C1.00%2C1.00&up=-y&scale=0.50&cam=0.260%2C2.640%2C2.153%2C-0.036%2C0.099%2C-0.007';

/** The hydrogen view with parameters set or replaced (the viewer reads only the first of repeats) */
function hydrogen(params: Record<string, string>): string {
  const query = new URLSearchParams(HYDROGEN_VIEW);
  for (const [key, value] of Object.entries(params)) query.set(key, value);
  return query.toString();
}

interface Scene {
  name: string;
  dataset: string;
  query: string;
  /** Label bricks arrive after the image has converged */
  settleMs?: number;
}

// Opacity peaks at three intensities: thin shells inside every soft edge, sensitive to precision
const PEAKS = 'tfpts=0,0,0.4,0,0.45,0.9,0.5,0,0.7,0,0.75,0.6,0.8,0,0.95,0,1,1';

const SCENES: Scene[] = [
  { name: 'synth-dvr', dataset: SYNTH, query: `mode=dvr&tf=hot&${PEAKS}&${ZOOM}` },
  { name: 'synth-labels-dvr', dataset: SYNTH, query: `mode=dvr&tf=cool&wc=0.5&ww=0.4&density=2&shade=0.6&labels=shapes&${ZOOM}`, settleMs: 4000 },
  { name: 'synth-labels-slice', dataset: SYNTH, query: `mode=slice&tf=grayscale-inverted&labels=shapes:0.8:surface:both&${ZOOM}`, settleMs: 4000 },
  // Same image as synth-dvr in other data types: the three should look alike
  { name: 'synth-u16-dvr', dataset: SYNTH_U16, query: `mode=dvr&tf=hot&${PEAKS}&${ZOOM}` },
  { name: 'synth-f32-dvr', dataset: SYNTH_F32, query: `mode=dvr&tf=hot&${PEAKS}&${ZOOM}` },
  { name: 'time-2', dataset: SYNTH_TC, query: `sourceChannels=1&timepoint=2&mode=mip&tf=coolwarm&wc=0.6&ww=0.5&${ZOOM}` },
  // channels: r,g,b,weight,visible,min,max per channel
  { name: 'mc-dvr', dataset: SYNTH_TC, query: `sourceChannels=0,1,2,3&timepoint=1&mode=dvr&${ZOOM}`
    + '&channels=255,80,0,1.5,1,0,1;0,200,255,1,1,0.2,0.9;180,0,255,0.7,1,0,1;0,255,120,1,1,0.3,1' },
  { name: 'mc-slice', dataset: SYNTH_TC, query: `sourceChannels=0,1,2,3&timepoint=1&mode=slice&${ZOOM}`
    + '&channels=255,0,255,1,1,0,1;0,255,255,1,1,0,0.7;255,255,0,1,1,0.1,1;255,255,255,0.5,1,0,1' },
  { name: 'mc-hidden', dataset: SYNTH_TC, query: `sourceChannels=0,1,2,3&timepoint=1&mode=mip&${ZOOM}`
    + '&channels=255,0,0,1,1,0,1;0,255,0,1,0,0,1;0,0,255,1,1,0,1;255,255,0,1,1,0,1' },
  { name: 'mc-source', dataset: SYNTH_TC, query: `sourceChannels=4,1&timepoint=2&mode=mip&${ZOOM}`
    + '&channels=255,160,0,1,1,0,1;0,120,255,1,1,0,0.6' },
  { name: 'hydrogen-dvr', dataset: HYDROGEN, query: hydrogen({ mode: 'dvr' }) },
  { name: 'hydrogen-mip', dataset: HYDROGEN, query: hydrogen({ mode: 'mip', tf: 'hot' }) },
  { name: 'hydrogen-iso', dataset: HYDROGEN, query: hydrogen({ mode: 'iso', tf: 'coolwarm' }) },
  { name: 'hydrogen-slice', dataset: HYDROGEN, query: hydrogen({ mode: 'slice', tf: 'seismic' }) },
  { name: 'hydrogen-lod', dataset: HYDROGEN, query: hydrogen({ mode: 'lod' }) },
  // A different range per axis, so a swapped axis shows; a hard opacity step
  { name: 'hydrogen-clip', dataset: HYDROGEN, query: hydrogen({ mode: 'dvr', tf: 'cool', tfpts: '0,0,0.3,0,0.31,1,1,1', clipMin: '0.5,0.25,0', clipMax: '0.75,1,0.7' }) },
  // A tent-shaped opacity curve, with shading
  { name: 'hydrogen-ortho', dataset: HYDROGEN, query: hydrogen({ mode: 'dvr', tf: 'coolwarm', tfpts: '0,0,0.5,1,1,0.2', shade: '0.5', proj: 'ortho', axis: '1' }) },
  { name: 'hydrogen-quad', dataset: HYDROGEN, query: hydrogen({ mode: 'dvr', tf: 'hot', layout: 'quad' }) },
  { name: 'hydrogen-boundary', dataset: HYDROGEN, query: hydrogen({ mode: 'dvr', density: '1.00', shade: '0.00', boundary: '1.00', tf: 'viridis' }) },
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
    // Every scene shows the bounding box
    await page.goto(`?dataset=${encodeURIComponent(scene.dataset)}&${scene.query}&wireframe=1&bench=1&benchTimeout=150000`);
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
