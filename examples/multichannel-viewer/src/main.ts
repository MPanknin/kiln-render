/**
 * Multi-channel viewer — application entry point
 */

import {
  KilnViewer,
  LocalZarrDataProvider,
  UnsupportedDatasetError,
  preValidateRemoteZarr,
  preValidateLocalZarr,
  promptForZarrDirectory,
  getStoredHandle,
  requestPermission,
  clearHandle,
} from 'kiln-render';
import type { ViewerOptions, DataProvider, UpAxis } from 'kiln-render';
import { MultichannelUI } from './ui/multichannel-ui.js';
import type { ChannelState } from './ui/multichannel-ui.js';

// const DEFAULT_VOLUME_SOURCE = 'https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0062A/6001247.zarr';
// const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/Fly-eFISH/NP01_1_1_SS00790_AstA546_CCHa1_647_1x_LOL.chunked.zarr';
// const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/multichannel/13457537.zarr/13457537.zarr';
const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/multichannel/4496763.zarr/4496763.zarr';
// const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/multichannel/13457227.zarr/13457227.zarr';



interface SliceParams {
  x: number;  // voxel position
  y: number;
  z: number;
  showX: boolean;
  showY: boolean;
  showZ: boolean;
}

function parseURLParams(): {
  dataset: string;
  up?: string;
  scale?: number;
  mode?: string;
  cam?: [number, number, number] | [number, number, number, number, number, number];
  channels?: ChannelState[];
  slice?: SliceParams;
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
  let channels: ChannelState[] | undefined;
  const channelsStr = params.get('channels');
  if (channelsStr) {
    const parsed = channelsStr.split(';').map(part => {
      const nums = part.split(',').map(Number);
      return { r: (nums[0] ?? NaN) | 0, g: (nums[1] ?? NaN) | 0, b: (nums[2] ?? NaN) | 0, a: nums[3] ?? NaN, visible: (nums[4] ?? 0) !== 0, min: nums[5] ?? 0, max: nums[6] ?? 1 };
    });
    if (parsed.every(ch => !isNaN(ch.r) && !isNaN(ch.g) && !isNaN(ch.b) && !isNaN(ch.a))) {
      channels = parsed;
    }
  }
  let slice: SliceParams | undefined;
  const sliceStr = params.get('slice');
  if (sliceStr) {
    const parts = sliceStr.split(',').map(Number);
    if (parts.length === 6 && parts.every(n => !isNaN(n))) {
      slice = { x: parts[0]!, y: parts[1]!, z: parts[2]!, showX: parts[3]! !== 0, showY: parts[4]! !== 0, showZ: parts[5]! !== 0 };
    }
  }
  return {
    dataset: params.get('dataset') ?? DEFAULT_VOLUME_SOURCE,
    up: params.get('up') ?? undefined,
    scale: params.has('scale') ? Number(params.get('scale')) : undefined,
    mode: params.get('mode') ?? undefined,
    cam,
    channels,
    slice,
  };
}

async function main() {
  const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('Canvas not found');

  const urlParams = parseURLParams();
  const volumeSource = urlParams.dataset;

  let dataset: string | DataProvider;

  const params = new URLSearchParams(window.location.search);
  const useLocal = params.get('local') === 'true';
  const storedHandle = await getStoredHandle();
  let isLocalZarr = false;

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

  const options: ViewerOptions = {
    upAxis: urlParams.up as UpAxis | undefined,
    cam: urlParams.cam,
    renderScale: urlParams.scale,
  };

  // Show spinner during metadata fetch + any pre-scans (cause 1: main-thread
  // scanFloatRange/scanChannelRanges can block for seconds on large base LODs).
  // The UI stats interval takes over once the viewer exists.
  document.getElementById('spinner')?.classList.add('active');
  const viewer = await KilnViewer.create(canvas, dataset, options);
  document.getElementById('spinner')?.classList.remove('active');

  if (urlParams.mode === 'dvr' || urlParams.mode === 'mip' || urlParams.mode === 'slice') {
    viewer.mode = urlParams.mode;
  }

  const ui = new MultichannelUI(viewer, urlParams.channels, urlParams.slice);
  viewer.onBeforeFrame = () => ui.recordFrame();
  viewer.onChannelWindowsChanged = () => ui.refreshChannelWindows();

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
      p.set('up', state.upAxis);
      p.set('mode', state.mode);
      p.set('scale', state.renderScale.toFixed(2));
      const [rx, ry, dist, tx, ty, tz] = state.cam;
      p.set('cam', `${rx.toFixed(3)},${ry.toFixed(3)},${dist.toFixed(3)},${tx.toFixed(3)},${ty.toFixed(3)},${tz.toFixed(3)}`);
      const channelState = ui.getChannelState();
      if (channelState.length > 0) {
        p.set('channels', channelState.map(ch =>
          `${ch.r},${ch.g},${ch.b},${ch.a.toFixed(2)},${ch.visible ? 1 : 0},${ch.min.toFixed(2)},${ch.max.toFixed(2)}`
        ).join(';'));
      }
      const sliceState = ui.getSliceState();
      p.set('slice', `${sliceState.x},${sliceState.y},${sliceState.z},${sliceState.showX ? 1 : 0},${sliceState.showY ? 1 : 0},${sliceState.showZ ? 1 : 0}`);

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

  const clearError = () => { if (errorEl) errorEl.style.display = 'none'; };

  loadDatasetBtn.addEventListener('click', () => { clearError(); dialog.showModal(); });
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

      if (url.includes('.zarr')) {
        const origText = remoteLoadBtn.textContent ?? 'Load';
        remoteLoadBtn.disabled = true;
        remoteLoadBtn.textContent = 'Checking…';
        try {
          const reasons = await preValidateRemoteZarr(url);
          if (reasons.length > 0) { showDialogError(reasons); return; }
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
  if (el) { el.textContent = message; el.style.display = 'block'; }
  console.error(message);
}

setupDatasetDialog();

main().catch((e) => {
  if (e instanceof UnsupportedDatasetError) {
    showDialogError(e.reasons, true);
  } else {
    showError(e instanceof Error ? e.message : String(e));
  }
});
