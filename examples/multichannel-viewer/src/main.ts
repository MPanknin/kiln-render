/**
 * Multi-channel viewer — application entry point
 */

import {
  KilnViewer,
  LocalZarrDataProvider,
  UnsupportedDatasetError,
  getStoredHandle,
  requestPermission,
} from 'kiln-render';
import type { ViewerOptions, DataProvider, UpAxis } from 'kiln-render';
import { MultichannelUI } from './ui/multichannel-ui.js';
import type { ChannelState } from './ui/multichannel-ui.js';
import { mountDatasetDialog, showDialogError } from '../../shared/dataset-dialog.js';
import { mountToast } from '../../shared/toast.js';
import { setupShareButton } from '../../shared/share-button.js';
import { setupScreenshotButton } from '../../shared/screenshot.js';
import { mountOrientationGizmo } from '../../shared/orientation-gizmo.js';
import { mountShortcuts, axisSnapShortcut } from '../../shared/shortcuts.js';
import { mountTopBar } from '../../shared/top-bar.js';
import { trackDataset, trackRenderMode } from '../../shared/analytics.js';
import { maybeRunBench } from '../../shared/bench.js';
import '../../shared/viewer-shell.css';
import '../../shared/controls/controls.css';

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
  pyramid?: 'legacy' | 'native';
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
    pyramid: params.get('pyramid') === 'legacy' ? 'legacy' : params.get('pyramid') === 'native' ? 'native' : undefined,
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
    pyramid: urlParams.pyramid,
    // Hidden channels in the share URL must not be streamed for the base load
    visibleChannels: urlParams.channels?.map(ch => ch.visible),
  };

  // Show spinner during metadata fetch + any pre-scans (cause 1: main-thread
  // scanFloatRange/scanChannelRanges can block for seconds on large base LODs).
  // The UI stats interval takes over once the viewer exists.
  document.getElementById('spinner')?.classList.add('active');
  const viewer = await KilnViewer.create(canvas, dataset, options);
  document.getElementById('spinner')?.classList.remove('active');
  topBar.setDatasetName(viewer.metadata.name);

  if (urlParams.mode === 'dvr' || urlParams.mode === 'mip' || urlParams.mode === 'slice') {
    viewer.mode = urlParams.mode;
  }

  trackDataset(viewer.metadata.name);
  trackRenderMode(viewer.getState().mode);

  // Fetch-pattern benchmark — no-op unless ?bench=1 (see examples/shared/bench.ts).
  void maybeRunBench(viewer);

  const ui = new MultichannelUI(viewer, urlParams.channels, urlParams.slice);
  viewer.onBeforeFrame = () => ui.recordFrame();
  viewer.onChannelWindowsChanged = () => ui.refreshChannelWindows();

  // ── Share button ───────────────────────────────────────────────────────────

  const toast = mountToast();
  const takeScreenshot = setupScreenshotButton(viewer, toast);
  const gizmo = mountOrientationGizmo(viewer.camera);
  mountShortcuts([
    { keys: ['1', '2', '3'], display: '1 – 3', label: 'DVR / MIP / Slice',
      run: (e) => ui.setBaseMode((['dvr', 'mip', 'slice'] as const)[Number(e.key) - 1]!) },
    axisSnapShortcut((dir) => gizmo.snap(dir)),
    { keys: ['r', 'R'], display: 'R', label: 'Reset view', run: () => gizmo.reset() },
    { keys: ['s', 'S'], display: 'S', label: 'Save screenshot', run: takeScreenshot },
    { keys: ['d', 'D'], display: 'D', label: 'Diagnostics panel' },
  ]);
  setupShareButton({
    isLocalZarr,
    toast,
    buildShareUrl: () => {
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

      return `${window.location.origin}${window.location.pathname}?${p.toString()}`;
    },
  });

  window.addEventListener('beforeunload', () => {
    viewer.dispose();
  });
}

function showError(message: string) {
  const el = document.getElementById('error');
  if (el) { el.textContent = message; el.style.display = 'block'; }
  console.error(message);
}

// Always wire up the top bar (provides #load-dataset-btn / #share-btn) and dialog
const topBar = mountTopBar({ beta: true });
mountDatasetDialog({
  remoteDescription: 'Enter URL to an OME-Zarr dataset with multiple channels',
});

main().catch((e) => {
  if (e instanceof UnsupportedDatasetError) {
    showDialogError(e.reasons, true);
  } else {
    showError(e instanceof Error ? e.message : String(e));
  }
});
