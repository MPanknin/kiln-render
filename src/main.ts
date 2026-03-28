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
import { detectBest16BitFormat } from './core/volume.js';
import { getDecompressionPool } from './data/decompression-pool.js';

// Default volume source (can be overridden via ?dataset= URL parameter)
const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/chameleon-16bit';
// const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/beechnut.ome.zarr';

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
  clipMin?: [number, number, number];
  clipMax?: [number, number, number];
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

  let clipMin: [number, number, number] | undefined;
  let clipMax: [number, number, number] | undefined;
  const clipMinStr = params.get('clipMin');
  const clipMaxStr = params.get('clipMax');
  if (clipMinStr) {
    const parts = clipMinStr.split(',').map(Number);
    if (parts.length === 3 && parts.every(n => !isNaN(n))) {
      clipMin = parts as [number, number, number];
    }
  }
  if (clipMaxStr) {
    const parts = clipMaxStr.split(',').map(Number);
    if (parts.length === 3 && parts.every(n => !isNaN(n))) {
      clipMax = parts as [number, number, number];
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
    clipMin,
    clipMax,
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

  // Create data provider (but don't initialize yet)
  const isZarr = volumeSource.includes('.zarr');
  const dataProvider: DataProvider = isZarr
    ? new ZarrDataProvider(volumeSource)
    : new ShardedDataProvider(volumeSource);

  // Store for cleanup on page unload
  globalDataProvider = dataProvider;

  // Initialize metadata
  const metadata = await dataProvider.initialize();
  const sourceBitDepth = metadata.bitDepth;

  // Detect best texture format
  let textureFormat: GPUTextureFormat;
  let effectiveBitDepth = sourceBitDepth;

  if (sourceBitDepth === 16) {
    textureFormat = detectBest16BitFormat(device);
    if (textureFormat === 'r8unorm') {
      effectiveBitDepth = 8;
      console.warn(
        '[Kiln] ⚠️  GPU does not support 16-bit textures (r16unorm/r16float).\n' +
        'Downsampling to 8-bit (quality loss).'
      );
    }
  } else {
    textureFormat = 'r8unorm';
  }

  // Configure workers to output the correct format
  if (textureFormat !== 'r16unorm' || sourceBitDepth !== 16) {
    // Need format conversion: r8unorm (8-bit) or r16float (float16)
    if (isZarr) {
      await (dataProvider as ZarrDataProvider).setTargetFormat(textureFormat as 'r8unorm' | 'r16float');
    } else {
      const decompressionPool = getDecompressionPool();
      decompressionPool.setTargetFormat(textureFormat as 'r8unorm' | 'r16float');
    }
  }

  // Configure dataset size from metadata
  const spacing = metadata.voxelSpacing;
  setDatasetSize(metadata.dimensions, spacing);

  // Create renderer with effective bit depth and texture format
  const renderer = new Renderer(device, format, effectiveBitDepth, textureFormat);

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

  // Store desired render scale
  let userRenderScale = renderer.renderScale;

  // Create UI
  const ui = new VolumeUI(renderer, camera, transferFunction);
  ui.setStreamingManager(streamingManager, metadata);

  ui.setRenderScaleCallback((scale) => {
    userRenderScale = scale;
  });

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
    userRenderScale = urlParams.scale;
    renderer.renderScale = userRenderScale;
    renderer.resizeComputeTexture();
  }
  if (urlParams.clipMin) {
    renderer.clipMin.set(urlParams.clipMin);
    renderer.resetAccumulation();
  }
  if (urlParams.clipMax) {
    renderer.clipMax.set(urlParams.clipMax);
    renderer.resetAccumulation();
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

      const clipMin = renderer.clipMin;
      const clipMax = renderer.clipMax;
      if (clipMin[0]! !== 0 || clipMin[1]! !== 0 || clipMin[2]! !== 0) {
        p.set('clipMin', `${clipMin[0]!.toFixed(2)},${clipMin[1]!.toFixed(2)},${clipMin[2]!.toFixed(2)}`);
      }
      if (clipMax[0]! !== 1 || clipMax[1]! !== 1 || clipMax[2]! !== 1) {
        p.set('clipMax', `${clipMax[0]!.toFixed(2)},${clipMax[1]!.toFixed(2)},${clipMax[2]!.toFixed(2)}`);
      }

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

    // Drop to 0.25 during camera interaction
    const isInteracting = camera.isInteracting();
    const targetScale = isInteracting ? 0.25 : userRenderScale;

    if (renderer.renderScale !== targetScale) {
      renderer.renderScale = targetScale;
      renderer.resizeComputeTexture();
    }

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

// Store provider for cleanup
let globalDataProvider: DataProvider | null = null;

// Cleanup workers on page unload
window.addEventListener('beforeunload', () => {
  globalDataProvider?.dispose();
  getDecompressionPool().terminate();
});

main().catch((e) => showError(e.message));
