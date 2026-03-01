/**
 * Kiln - Brick-based WebGPU Volume Renderer
 */

declare global {
  interface Window {
    goatcounter?: { count: (opts: { path: string; title: string; event: boolean }) => void };
  }
}

import { Renderer, VolumeRenderMode } from './core/renderer.js';
import { Camera, UpAxis } from './core/camera.js';
import { setDatasetSize } from './core/config.js';
import { ShardedDataProvider } from './data/sharded-provider.js';
import { ZarrDataProvider } from './data/zarr-provider.js';
import type { DataProvider } from './data/data-provider.js';
import { TransferFunction, TFPreset } from './core/transfer-function.js';
import { VolumeUI } from './ui/volume-ui.js';
import { StreamingManager } from './streaming/streaming-manager.js';

// Default volume source (can be overridden via ?dataset= URL parameter)
// const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/chameleon-16bit';
const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/beechnut.ome.zarr';

/** Parse URL parameters for per-dataset configuration */
function parseURLParams(): {
  dataset: string;
  mode?: VolumeRenderMode;
  wc?: number;
  ww?: number;
  iso?: number;
  tf?: string;
  up?: string;
  sse?: number;
  scale?: number;
  cam?: [number, number, number] | [number, number, number, number, number, number];
} {
  const params = new URLSearchParams(window.location.search);
  let cam: [number, number, number] | [number, number, number, number, number, number] | undefined;
  const camStr = params.get('cam');
  if (camStr) {
    const parts = camStr.split(',').map(Number);
    if ((parts.length === 3 || parts.length === 6) && parts.every(n => !isNaN(n))) {
      cam = parts as typeof cam;
    }
  }
  return {
    dataset: params.get('dataset') ?? DEFAULT_VOLUME_SOURCE,
    mode: (params.get('mode') as VolumeRenderMode) ?? undefined,
    wc: params.has('wc') ? Number(params.get('wc')) : undefined,
    ww: params.has('ww') ? Number(params.get('ww')) : undefined,
    iso: params.has('iso') ? Number(params.get('iso')) : undefined,
    tf: params.get('tf') ?? undefined,
    up: params.get('up') ?? undefined,
    sse: params.has('sse') ? Number(params.get('sse')) : undefined,
    scale: params.has('scale') ? Number(params.get('scale')) : undefined,
    cam,
  };
}

// Capture page load start time for time-to-first-render metric
const PAGE_LOAD_START = performance.now();

async function main() {
  const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('Canvas not found');

  // Initialize WebGPU
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    showError('WebGPU not supported');
    window.goatcounter?.count({ path: '/event/webgpu-failed', title: 'WebGPU not supported', event: true });
    return;
  }

  // Request higher limits for large atlas textures and features for 16-bit textures
  const adapterLimits = adapter.limits;
  const requiredFeatures: GPUFeatureName[] = [];

  if (adapter.features.has('texture-formats-tier1' as GPUFeatureName)) {
    requiredFeatures.push('texture-formats-tier1' as GPUFeatureName);
  }

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapterLimits.maxBufferSize,
      maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
      maxTextureDimension3D: adapterLimits.maxTextureDimension3D,
    },
    requiredFeatures,
  });
  if (!device) {
    showError('WebGPU device creation failed');
    window.goatcounter?.count({ path: '/event/webgpu-failed', title: 'WebGPU device creation failed', event: true });
    return;
  }
  window.goatcounter?.count({ path: '/event/webgpu-ok', title: 'WebGPU initialized', event: true });

  const context = canvas.getContext('webgpu')!
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  // Parse URL parameters
  const urlParams = parseURLParams();
  const volumeSource = urlParams.dataset;

  // Load volume metadata via DataProvider (auto-detect format)
  const isZarr = volumeSource.includes('.zarr');
  const dataProvider: DataProvider = isZarr
    ? new ZarrDataProvider(volumeSource)
    : new ShardedDataProvider(volumeSource);
  const metadata = await dataProvider.initialize();

  // Configure dataset size from metadata
  const spacing = metadata.voxelSpacing;
  setDatasetSize(metadata.dimensions, spacing);

  // Create renderer with appropriate bit depth from metadata
  const bitDepth = dataProvider.getBitDepth();
  const renderer = new Renderer(device, format, bitDepth);

  // Create transfer function and connect to renderer
  const transferFunction = new TransferFunction(device);
  renderer.setTransferFunction(transferFunction);

  // Create camera
  const camera = new Camera(canvas);

  // Create streaming manager
  const streamingManager = new StreamingManager(renderer, dataProvider, metadata, device, PAGE_LOAD_START);

  let streamingEnabled = true;

  // Handle resize
  const resize = () => {
    const width = Math.max(1, Math.min(canvas.clientWidth, device.limits.maxTextureDimension2D));
    const height = Math.max(1, Math.min(canvas.clientHeight, device.limits.maxTextureDimension2D));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      renderer.resize(width, height);
    }
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // Create UI
  const ui = new VolumeUI(renderer, camera, transferFunction);
  ui.setStreamingManager(streamingManager, metadata);

  // Apply URL parameters (after UI so we can sync both)
  if (urlParams.mode) {
    renderer.volumeRenderMode = urlParams.mode;
    renderer.resetAccumulation();
  }
  if (urlParams.wc !== undefined) {
    renderer.windowCenter = urlParams.wc;
    renderer.resetAccumulation();
  }
  if (urlParams.ww !== undefined) {
    renderer.windowWidth = urlParams.ww;
    renderer.resetAccumulation();
  }
  if (urlParams.iso !== undefined) {
    renderer.isoValue = urlParams.iso;
    renderer.resetAccumulation();
  }
  if (urlParams.tf) {
    transferFunction.setPreset(urlParams.tf as TFPreset);
    renderer.resetAccumulation();
  }
  if (urlParams.up) {
    camera.setUpAxis(urlParams.up as UpAxis);
  }
  if (urlParams.cam) {
    camera.setOrbitState(urlParams.cam);
  }
  if (urlParams.sse !== undefined) {
    streamingManager.maxPixelError = urlParams.sse;
  }
  if (urlParams.scale !== undefined) {
    renderer.renderScale = urlParams.scale;
    renderer.resizeComputeTexture();
  }
  ui.syncFromState();

  // Share button: build URL from current state and copy to clipboard
  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      const p = new URLSearchParams();
      if (volumeSource !== DEFAULT_VOLUME_SOURCE) p.set('dataset', volumeSource);
      p.set('mode', renderer.volumeRenderMode);
      p.set('wc', renderer.windowCenter.toFixed(2));
      p.set('ww', renderer.windowWidth.toFixed(2));
      p.set('iso', renderer.isoValue.toFixed(2));
      p.set('tf', transferFunction.preset);
      p.set('up', camera.getUpAxis());
      p.set('scale', renderer.renderScale.toFixed(2));
      const [rx, ry, dist, tx, ty, tz] = camera.getOrbitState();
      p.set('cam', `${rx.toFixed(3)},${ry.toFixed(3)},${dist.toFixed(3)},${tx.toFixed(3)},${ty.toFixed(3)},${tz.toFixed(3)}`);
      const url = `${window.location.origin}${window.location.pathname}?${p.toString()}`;
      navigator.clipboard.writeText(url).then(() => {
        shareBtn.classList.add('copied');
        setTimeout(() => shareBtn.classList.remove('copied'), 1500);
        const toast = document.getElementById('toast');
        if (toast) {
          toast.classList.add('visible');
          setTimeout(() => toast.classList.remove('visible'), 1500);
        }
      });
    });
  }

  // Render loop
  function frame() {
    ui.recordFrame();

    if (streamingEnabled) {
      streamingManager.update(camera, canvas!);
    }

    const view = context.getCurrentTexture().createView();
    renderer.render(view, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function showError(message: string) {
  const el = document.getElementById('error');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
  console.error(message);
}

main().catch((e) => showError(e.message));
