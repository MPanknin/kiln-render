/**
 * Kiln — application entry point
 *
 * Responsible for: URL parameter parsing, data provider selection for local
 * Zarr (File System API), error display, the dataset dialog, share button,
 * and analytics.  All rendering and streaming concerns live in KilnViewer.
 */

declare global {
  interface Window {
    goatcounter?: { count: (opts: { path: string; title: string; event: boolean }) => void };
  }
}

import { KilnViewer } from './viewer.js';
import type { ViewerOptions } from './viewer.js';
import { VolumeRenderMode } from './core/renderer.js';
import type { TFPreset } from './core/transfer-function.js';
import type { UpAxis } from './core/camera.js';
import { LocalZarrDataProvider } from './data/local-zarr-provider.js';
import type { DataProvider } from './data/data-provider.js';
import { UnsupportedDatasetError } from './data/data-provider.js';
import { preValidateRemoteZarr, preValidateLocalZarr } from './data/zarr-validator.js';
import { clearHandle } from './data/handle-storage.js';
import { VolumeUI } from './ui/volume-ui.js';
import {
  promptForZarrDirectory,
  getStoredHandle,
  requestPermission
} from './data/local-loader.js';

// Default volume source (can be overridden via ?dataset= URL parameter)
const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/chameleon-16bit';

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

  const urlParams = parseURLParams();
  const volumeSource = urlParams.dataset;

  // ── Local Zarr handling (File System API) ──────────────────────────────────

  let dataset: string | DataProvider;
  let isLocalZarr = false;

  const params = new URLSearchParams(window.location.search);
  const useLocal = params.get('local') === 'true';
  const storedHandle = await getStoredHandle();

  if (useLocal && storedHandle) {
    const hasPermission = await requestPermission(storedHandle);
    if (hasPermission) {
      dataset = new LocalZarrDataProvider(storedHandle);
      isLocalZarr = true;
    } else {
      dataset = volumeSource;
    }
  } else {
    dataset = volumeSource;
  }

  // ── Build viewer options from URL params ───────────────────────────────────

  const options: ViewerOptions = {
    mode: urlParams.mode,
    windowCenter: urlParams.wc,
    windowWidth: urlParams.ww,
    isoValue: urlParams.iso,
    tfPreset: urlParams.tf as TFPreset | undefined,
    upAxis: urlParams.up as UpAxis | undefined,
    cam: urlParams.cam,
    renderScale: urlParams.scale,
    maxPixelError: urlParams.sse,
    clipMin: urlParams.clipMin,
    clipMax: urlParams.clipMax,
    pageLoadStart: PAGE_LOAD_START,
  };

  // ── Create viewer ──────────────────────────────────────────────────────────

  const viewer = await KilnViewer.create(canvas, dataset, options);

  window.goatcounter?.count({ path: '/event/webgpu-ok', title: 'WebGPU initialized', event: true });

  // ── UI ─────────────────────────────────────────────────────────────────────

  const ui = new VolumeUI(viewer);
  viewer.onBeforeFrame = () => ui.recordFrame();
  ui.syncFromState();

  // ── Share button ───────────────────────────────────────────────────────────

  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      const toast = document.getElementById('toast');

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

      const state = viewer.getState();
      const p = new URLSearchParams();
      if (volumeSource !== DEFAULT_VOLUME_SOURCE) p.set('dataset', volumeSource);
      p.set('mode', state.mode);
      p.set('wc', state.windowCenter.toFixed(2));
      p.set('ww', state.windowWidth.toFixed(2));
      p.set('iso', state.isoValue.toFixed(2));
      p.set('tf', state.tfPreset);
      p.set('up', state.upAxis);
      p.set('scale', state.renderScale.toFixed(2));
      const [rx, ry, dist, tx, ty, tz] = state.cam;
      p.set('cam', `${rx.toFixed(3)},${ry.toFixed(3)},${dist.toFixed(3)},${tx.toFixed(3)},${ty.toFixed(3)},${tz.toFixed(3)}`);

      if (state.clipMin[0] !== 0 || state.clipMin[1] !== 0 || state.clipMin[2] !== 0) {
        p.set('clipMin', state.clipMin.map(v => v.toFixed(2)).join(','));
      }
      if (state.clipMax[0] !== 1 || state.clipMax[1] !== 1 || state.clipMax[2] !== 1) {
        p.set('clipMax', state.clipMax.map(v => v.toFixed(2)).join(','));
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

  // ── Cleanup ────────────────────────────────────────────────────────────────

  window.addEventListener('beforeunload', () => {
    viewer.dispose();
  });
}

function showDialogError(reasons: string[], cleanUrl = false): void {
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

  loadDatasetBtn.addEventListener('click', () => {
    clearError();
    dialog.showModal();
  });

  cancelBtn?.addEventListener('click', () => dialog.close());

  dialog.addEventListener('click', (e) => {
    const rect = dialog.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top  || e.clientY > rect.bottom) {
      dialog.close();
    }
  });

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

// Always wire up the dialog
setupDatasetDialog();

main().catch((e) => {
  if (e instanceof UnsupportedDatasetError) {
    showDialogError(e.reasons, true);
  } else {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'WebGPU not supported' || msg === 'WebGPU device creation failed') {
      window.goatcounter?.count({ path: '/event/webgpu-failed', title: msg, event: true });
    }
    showError(msg);
  }
});
