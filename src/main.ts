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
import { LocalZarrDataProvider } from './data/local-zarr-provider.js';
import type { DataProvider } from './data/data-provider.js';
import { UnsupportedDatasetError } from './data/data-provider.js';
import { preValidateRemoteZarr, preValidateLocalZarr } from './data/zarr-validator.js';
import { clearHandle } from './data/handle-storage.js';
import { TransferFunction, TFPreset } from './core/transfer-function.js';
import { VolumeUI } from './ui/volume-ui.js';
import { StreamingManager } from './streaming/streaming-manager.js';
import { detectBest16BitFormat } from './core/volume.js';
import { getDecompressionPool } from './data/decompression-pool.js';
import {
  promptForZarrDirectory,
  getStoredHandle,
  requestPermission
} from './data/local-loader.js';

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

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapterLimits.maxBufferSize,
      maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
      maxTextureDimension3D: adapterLimits.maxTextureDimension3D,
    },
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

  // Check for local zarr handle (with permission check)
  let dataProvider: DataProvider;
  let isLocalZarr = false;

  const params = new URLSearchParams(window.location.search);
  const useLocal = params.get('local') === 'true';
  const storedHandle = await getStoredHandle();

  if (useLocal && storedHandle) {
    const hasPermission = await requestPermission(storedHandle);
    if (hasPermission) {
      dataProvider = new LocalZarrDataProvider(storedHandle);
      isLocalZarr = true;
    } else {
      // No permission, fall back to HTTP
      const isZarr = volumeSource.includes('.zarr');
      dataProvider = isZarr ? new ZarrDataProvider(volumeSource) : new ShardedDataProvider(volumeSource);
    }
  } else {
    // Create HTTP data provider
    const isZarr = volumeSource.includes('.zarr');
    dataProvider = isZarr ? new ZarrDataProvider(volumeSource) : new ShardedDataProvider(volumeSource);
  }

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

  // Configure workers to output the correct format (only for HTTP providers)
  if (!isLocalZarr && (textureFormat !== 'r16unorm' || sourceBitDepth !== 16)) {
    const isHttpZarr = volumeSource.includes('.zarr');
    if (isHttpZarr) {
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

  if (effectiveBitDepth === 16) {
    if (metadata.window) {
      const { start, end, min, max } = metadata.window;
      const range = max - min;
      if (range > 0) {
        const windowCenter = ((start + end) / 2 - min) / range;
        const windowWidth = (end - start) / range;
        renderer.windowCenter = Math.max(0, Math.min(1, windowCenter));
        renderer.windowWidth = Math.max(0.01, Math.min(1, windowWidth));
      }
    } else {
      renderer.windowCenter = 0.5;
      renderer.windowWidth = 1.0;
    }
  }

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
  const hasWindowParams = urlParams.wc !== undefined || urlParams.ww !== undefined;
  // Don't auto-level if url requests a specific window
  if (hasWindowParams) {
    if (urlParams.wc !== undefined) {
      renderer.windowCenter = urlParams.wc;
    }
    if (urlParams.ww !== undefined) {
      renderer.windowWidth = urlParams.ww;
    }
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
      const toast = document.getElementById('toast');

      // Check if this is a local dataset - can't be shared via URL
      if (isLocalZarr) {
        if (toast) {
          toast.textContent = 'Local datasets cannot be shared via link';
          toast.classList.add('visible');
          setTimeout(() => {
            toast.classList.remove('visible');
            toast.textContent = 'Current view copied to clipboard'; 
          }, 2500);
        }
        return;
      }

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

function showDialogError(reasons: string[], cleanUrl = false): void {
  // For URL-param failures: clear the URL and any stored local handle so a
  // refresh doesn't loop back into the same error.
  if (cleanUrl) {
    const wasLocal = new URLSearchParams(window.location.search).get('local') === 'true';
    history.replaceState({}, '', window.location.pathname);
    if (wasLocal) clearHandle().catch(() => {});
  }

  const dialog = document.getElementById('dataset-dialog') as HTMLDialogElement | null;
  const errorEl = document.getElementById('dialog-error');
  if (!dialog || !errorEl) return;

  errorEl.innerHTML =
    `<strong>Dataset not supported</strong>` +
    `<ul>${reasons.map(r => `<li>${r}</li>`).join('')}</ul>`;
  errorEl.style.display = 'block';

  if (!dialog.open) dialog.showModal();
}

function setupDatasetDialog() {
  const dialog = document.getElementById('dataset-dialog') as HTMLDialogElement;
  const loadDatasetBtn = document.getElementById('load-dataset-btn');
  const localBtn = document.getElementById('local-zarr-btn') as HTMLButtonElement | null;
  const remoteInput = document.getElementById('remote-url-input') as HTMLInputElement;
  const remoteLoadBtn = document.getElementById('remote-load-btn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('dialog-cancel-btn');
  const errorEl = document.getElementById('dialog-error');

  if (!dialog || !loadDatasetBtn) return;

  const clearError = () => {
    if (errorEl) errorEl.style.display = 'none';
  };

  // Open dialog (clear any previous error)
  loadDatasetBtn.addEventListener('click', () => {
    clearError();
    dialog.showModal();
  });

  // Close on cancel
  cancelBtn?.addEventListener('click', () => dialog.close());

  // Close on backdrop click
  dialog.addEventListener('click', (e) => {
    const rect = dialog.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top  || e.clientY > rect.bottom) {
      dialog.close();
    }
  });

  // --- Local directory picker ---
  if (localBtn) {
    if (!('showDirectoryPicker' in window)) {
      localBtn.disabled = true;
      localBtn.textContent = 'Not supported in this browser';
    } else {
      localBtn.addEventListener('click', async () => {
        clearError();
        let handle: FileSystemDirectoryHandle;
        try {
          handle = await promptForZarrDirectory();
        } catch (e) {
          const msg = e instanceof Error ? e.message : '';
          if (!msg.includes('cancelled') && !msg.includes('aborted')) {
            showDialogError([msg || 'Failed to open directory']);
          }
          return;
        }

        const orig = localBtn.textContent ?? '';
        localBtn.disabled = true;
        localBtn.textContent = 'Checking…';
        try {
          const reasons = await preValidateLocalZarr(handle);
          if (reasons.length > 0) {
            await clearHandle();
            showDialogError(reasons);
            return;
          }
        } catch (_) {
          showDialogError(['Could not read dataset metadata — is this a valid .zarr directory?']);
          await clearHandle();
          return;
        } finally {
          localBtn.disabled = false;
          localBtn.textContent = orig;
        }

        window.location.href = window.location.pathname + '?local=true';
      });
    }
  }

  // --- Remote URL ---
  if (remoteInput && remoteLoadBtn) {
    const loadRemote = async () => {
      const url = remoteInput.value.trim();
      if (!url) return;
      clearError();

      const isZarr = url.includes('.zarr');
      if (isZarr) {
        const origText = remoteLoadBtn.textContent ?? 'Load';
        remoteLoadBtn.disabled = true;
        remoteLoadBtn.textContent = 'Checking…';
        try {
          const reasons = await preValidateRemoteZarr(url);
          if (reasons.length > 0) {
            showDialogError(reasons);
            return;
          }
        } catch (_) {
          showDialogError(['Could not reach dataset — check the URL is correct and publicly accessible']);
          return;
        } finally {
          remoteLoadBtn.disabled = false;
          remoteLoadBtn.textContent = origText;
        }
      }

      window.location.href = window.location.pathname + '?dataset=' + encodeURIComponent(url);
    };

    remoteLoadBtn.addEventListener('click', loadRemote);
    remoteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRemote(); });
  }
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

// Always wire up the dialog
setupDatasetDialog();

main().catch((e) => {
  if (e instanceof UnsupportedDatasetError) {
    showDialogError(e.reasons, true);
  } else {
    showError(e instanceof Error ? e.message : String(e));
  }
});
