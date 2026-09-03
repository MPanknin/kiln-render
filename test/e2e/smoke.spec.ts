import { test, expect, type Page } from '@playwright/test';

/**
 * WebGPU smoke test: load a real remote OME-Zarr in the basic viewer, wait for
 * the base LOD to stream in and render, and assert the canvas is not blank.
 *
 * This is deliberately a "did the whole pipeline produce pixels" check, not a
 * golden-image comparison — SwiftShader output differs slightly from real GPUs
 * and a pixel-exact reference would be brittle. It catches the failure classes
 * unit tests cannot: shader compile errors, pipeline/bind-group mismatches,
 * worker bundling breakage, and streaming never reaching first render.
 */

// Small public dataset (also used in the README). Only the coarsest LOD is
// needed to reach first render, so the download is a few MB.
const DATASET = 'https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr';

// Minimal shape of the viewer we poke at via the window.__kiln test hook.
interface KilnHook {
  streamingManager: {
    getStats(): { timeToFirstRender: number | null; pendingCount: number; loadedCount: number };
  };
}

interface GpuDiag {
  adapter: Record<string, unknown> | null;
  limits: Record<string, number>;
  errors: string[];
  configures: string[];
}

declare global {
  interface Window {
    __kiln?: KilnHook;
    __gpuDiag?: GpuDiag;
  }
}

/**
 * Installed before any page script runs: records adapter info/limits, every
 * canvas configure() call, and every uncaptured GPU error. Kiln itself has no
 * uncapturederror listener, so without this the originating error behind a
 * "[Invalid Texture] is invalid due to a previous error" chain is lost.
 */
async function installGpuDiagnostics(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const diag: GpuDiag = { adapter: null, limits: {}, errors: [], configures: [] };
    window.__gpuDiag = diag;
    const gpu = navigator.gpu;
    if (!gpu) return;

    const origRequestAdapter = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (opts?: GPURequestAdapterOptions) => {
      const adapter = await origRequestAdapter(opts);
      if (adapter) {
        const info = adapter.info as unknown as Record<string, unknown> | undefined;
        diag.adapter = info
          ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }
          : {};
        for (const k of ['maxTextureDimension2D', 'maxTextureDimension3D', 'maxBufferSize', 'maxStorageBufferBindingSize']) {
          diag.limits[k] = (adapter.limits as unknown as Record<string, number>)[k];
        }
        const origRequestDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async (desc?: GPUDeviceDescriptor) => {
          const device = await origRequestDevice(desc);
          device.addEventListener('uncapturederror', (ev: Event) => {
            const e = (ev as GPUUncapturedErrorEvent).error;
            diag.errors.push(`${e.constructor.name}: ${e.message}`);
          });
          device.lost.then(info => diag.errors.push(`device lost (${info.reason}): ${info.message}`));
          return device;
        };
      }
      return adapter;
    };

    const ctxProto = (window as unknown as { GPUCanvasContext?: { prototype: GPUCanvasContext } }).GPUCanvasContext?.prototype;
    if (ctxProto) {
      const origConfigure = ctxProto.configure;
      ctxProto.configure = function (this: GPUCanvasContext, cfg: GPUCanvasConfiguration) {
        const c = this.canvas as HTMLCanvasElement;
        diag.configures.push(`format=${cfg.format} alphaMode=${cfg.alphaMode ?? 'opaque'} canvas=${c.width}x${c.height}`);
        return origConfigure.call(this, cfg);
      };
    }
  });
}

test('renders the base LOD of a remote OME-Zarr under WebGPU', async ({ page }) => {
  const consoleProblems: string[] = [];
  let navigations = 0;
  page.on('pageerror', e => consoleProblems.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    const text = m.text();
    // Chrome reports Dawn validation errors as console *warnings*, so
    // filtering on type === 'error' alone would miss them.
    const isDawn = /\[Invalid|While (calling|validating|encoding)|GPUValidationError|GPUOutOfMemoryError/.test(text);
    if (m.type() === 'error' && !/Failed to load resource/.test(text)) consoleProblems.push(`console.error: ${text}`);
    else if (isDawn) consoleProblems.push(`console.${m.type()}: ${text}`);
  });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) navigations++;
  });

  await installGpuDiagnostics(page);
  await page.goto(`/kiln-render/app/?embed=1&dataset=${encodeURIComponent(DATASET)}`);

  // WebGPU must actually be available in this browser — fail fast and clearly
  // if the launch flags didn't take, instead of timing out later.
  const hasWebGPU = await page.evaluate(async () => {
    if (!navigator.gpu) return false;
    return (await navigator.gpu.requestAdapter()) !== null;
  });
  expect(hasWebGPU, 'navigator.gpu.requestAdapter() returned null — WebGPU not enabled in this Chromium').toBe(true);

  // Viewer constructed (metadata fetched, device created).
  await page.waitForFunction(() => window.__kiln !== undefined, null, { timeout: 90_000 });

  // First render happened and the streaming queue drained.
  await page.waitForFunction(
    () => {
      const s = window.__kiln!.streamingManager.getStats();
      return s.timeToFirstRender !== null && s.pendingCount === 0 && s.loadedCount > 0;
    },
    null,
    { timeout: 120_000 },
  );

  // Let the render loop present the converged frame.
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await page.waitForTimeout(500);

  // Diagnostics first, so a failing assertion below comes with context.
  const diag = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return {
      ...window.__gpuDiag!,
      canvas: c ? { width: c.width, height: c.height, clientWidth: c.clientWidth, clientHeight: c.clientHeight } : null,
      spinnerActive: document.getElementById('spinner')?.classList.contains('active') ?? null,
    };
  });
  const context = JSON.stringify({ navigations, ...diag, consoleProblems }, null, 2);
  test.info().annotations.push({ type: 'gpu-diagnostics', description: context });

  expect(navigations, `page navigated ${navigations} times — a mid-test reload invalidates the run\n${context}`).toBe(1);
  expect(diag.canvas, `no <canvas> in the page\n${context}`).not.toBeNull();
  expect(diag.canvas!.clientWidth, `canvas has no layout size\n${context}`).toBeGreaterThan(0);
  expect(diag.errors, `uncaptured GPU errors\n${context}`).toEqual([]);
  expect(consoleProblems, `page/GPU errors during load\n${context}`).toEqual([]);

  // Pixel check from a compositor screenshot of the canvas element. Reading
  // a WebGPU canvas back through a 2D drawImage races the swap chain (it can
  // be transparent between getCurrentTexture and present), so decode the PNG
  // in-page instead — no extra dependency needed.
  const png = await page.locator('canvas').first().screenshot();
  const pixels = await page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const br = px[0], bg = px[1], bb = px[2];
    let fg = 0;
    for (let i = 0; i < px.length; i += 4) {
      const d = Math.abs(px[i] - br) + Math.abs(px[i + 1] - bg) + Math.abs(px[i + 2] - bb);
      if (d > 24) fg++;
    }
    return { width: c.width, height: c.height, foregroundFraction: fg / (c.width * c.height), background: [br, bg, bb] };
  }, png.toString('base64'));

  test.info().annotations.push({ type: 'canvas-pixels', description: JSON.stringify(pixels) });

  expect(pixels.width).toBeGreaterThan(0);
  expect(
    pixels.foregroundFraction,
    `canvas is a uniform color ${JSON.stringify(pixels.background)} — volume did not render\n${context}`,
  ).toBeGreaterThan(0.01);
});
