/**
 * Kiln — application entry point. URL parsing, data provider selection,
 * dataset dialog, and share button. Rendering lives in KilnViewer.
 */

import {
  KilnViewer,
  LocalZarrDataProvider,
  UnsupportedDatasetError,
  VolumeRenderMode,
  getStoredHandle,
  requestPermission,
} from 'kiln-render';
import type { ViewerOptions, DataProvider, TFPreset, UpAxis } from 'kiln-render';
import { VolumeUI } from './ui/volume-ui.js';
import { mountDatasetDialog, showDialogError } from '../../shared/dataset-dialog.js';
import { mountToast } from '../../shared/toast.js';
import { setupShareButton } from '../../shared/share-button.js';
import { mountTopBar } from '../../shared/top-bar.js';
import { trackEvent, trackDataset, trackRenderMode } from '../../shared/analytics.js';
import { maybeRunBench } from '../../shared/bench.js';
import '../../shared/viewer-shell.css';
import '../../shared/controls/controls.css';

// Default volume source (can be overridden via ?dataset= URL parameter)
const DEFAULT_VOLUME_SOURCE = 'https://d39zu0xtgv0613.cloudfront.net/chameleon-16bit';

// ?embed=1 — rendering only: no top bar, dataset dialog, controls/stats panel,
// or share button. Camera orbit/pan/zoom still works — that's wired directly
// onto the canvas by the Camera class, independent of any of this example's UI.
const IS_EMBED = new URLSearchParams(window.location.search).get('embed') === '1';

/** Parse URL parameters for per-dataset configuration */
function parseURLParams(): {
  dataset: string;
  mode?: VolumeRenderMode;
  wc?: number;
  ww?: number;
  density?: number;
  iso?: number;
  tf?: string;
  up?: string;
  sse?: number;
  scale?: number;
  cam?: [number, number, number] | [number, number, number, number, number, number];
  clipMin?: [number, number, number];
  clipMax?: [number, number, number];
  slices?: [number, number, number];
  sliceVis?: [boolean, boolean, boolean];
  tfPoints?: Array<{ x: number; y: number }>;
  wireframe?: boolean;
  axis?: boolean;
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

  let slices: [number, number, number] | undefined;
  const slicesStr = params.get('slices');
  if (slicesStr) {
    const parts = slicesStr.split(',').map(Number);
    if (parts.length === 3 && parts.every(n => !isNaN(n))) {
      slices = parts as [number, number, number];
    }
  }

  let sliceVis: [boolean, boolean, boolean] | undefined;
  const sliceVisStr = params.get('sliceVis');
  if (sliceVisStr !== null) {
    const mask = parseInt(sliceVisStr, 10);
    if (!isNaN(mask)) {
      sliceVis = [!!(mask & 1), !!(mask & 2), !!(mask & 4)];
    }
  }

  let tfPoints: Array<{ x: number; y: number }> | undefined;
  const tfPtsStr = params.get('tfpts');
  if (tfPtsStr) {
    const nums = tfPtsStr.split(',').map(Number);
    if (nums.length >= 2 && nums.length % 2 === 0 && nums.every(n => !isNaN(n))) {
      tfPoints = [];
      for (let i = 0; i < nums.length; i += 2) {
        tfPoints.push({ x: nums[i]!, y: nums[i + 1]! });
      }
    }
  }

  return {
    dataset: params.get('dataset') ?? DEFAULT_VOLUME_SOURCE,
    mode: (params.get('mode') as VolumeRenderMode) ?? undefined,
    wc: params.has('wc') ? Number(params.get('wc')) : undefined,
    ww: params.has('ww') ? Number(params.get('ww')) : undefined,
    density: params.has('density') ? Number(params.get('density')) : undefined,
    iso: params.has('iso') ? Number(params.get('iso')) : undefined,
    tf: params.get('tf') ?? undefined,
    up: params.get('up') ?? undefined,
    sse: params.has('sse') ? Number(params.get('sse')) : undefined,
    scale: params.has('scale') ? Number(params.get('scale')) : undefined,
    cam,
    clipMin,
    clipMax,
    slices,
    sliceVis,
    tfPoints,
    wireframe: params.get('wireframe') === '1' ? true : undefined,
    axis: params.get('axis') === '1' ? true : undefined,
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
    densityScale: urlParams.density,
    isoValue: urlParams.iso,
    tfPreset: urlParams.tf as TFPreset | undefined,
    tfPoints: urlParams.tfPoints,
    upAxis: urlParams.up as UpAxis | undefined,
    cam: urlParams.cam,
    renderScale: urlParams.scale,
    maxPixelError: urlParams.sse,
    clipMin: urlParams.clipMin,
    clipMax: urlParams.clipMax,
    sliceX: urlParams.slices?.[0],
    sliceY: urlParams.slices?.[1],
    sliceZ: urlParams.slices?.[2],
    showSliceX: urlParams.sliceVis?.[0],
    showSliceY: urlParams.sliceVis?.[1],
    showSliceZ: urlParams.sliceVis?.[2],
    showWireframe: urlParams.wireframe,
    showAxis: urlParams.axis,
    pageLoadStart: PAGE_LOAD_START,
  };

  // ── Create viewer ──────────────────────────────────────────────────────────

  // Show spinner during metadata fetch + any pre-scans (cause 1: main-thread
  // scanFloatRange/scanChannelRanges can block for seconds on large base LODs).
  // The UI stats interval takes over once the viewer exists.
  document.getElementById('spinner')?.classList.add('active');
  const viewer = await KilnViewer.create(canvas, dataset, options);
  document.getElementById('spinner')?.classList.remove('active');
  // Test hook: the Playwright WebGPU smoke test (test/e2e) polls this to know
  // when the viewer exists and to read streaming stats. Not part of the API.
  (window as unknown as { __kiln?: KilnViewer }).__kiln = viewer;
  topBar?.setDatasetName(viewer.metadata.name);

  trackEvent('webgpu-ok', 'WebGPU initialized');
  trackDataset(viewer.metadata.name);
  trackRenderMode(viewer.getState().mode);

  // Fetch-pattern benchmark — no-op unless ?bench=1 (see examples/shared/bench.ts).
  void maybeRunBench(viewer);

  // ── UI (skipped in embed mode — rendering + camera interaction only) ───────

  if (!IS_EMBED) {
    const ui = new VolumeUI(viewer);
    viewer.onBeforeFrame = () => ui.recordFrame();
    ui.syncFromState();

    const toast = mountToast();
    setupShareButton({
      isLocalZarr,
      toast,
      buildShareUrl: () => {
        const state = viewer.getState();
        const p = new URLSearchParams();
        if (volumeSource !== DEFAULT_VOLUME_SOURCE) p.set('dataset', volumeSource);
        p.set('mode', state.mode);
        p.set('wc', state.windowCenter.toFixed(2));
        p.set('ww', state.windowWidth.toFixed(2));
        p.set('density', state.densityScale.toFixed(2));
        p.set('iso', state.isoValue.toFixed(2));
        p.set('tf', state.tfPreset);
        p.set('tfpts', state.tfPoints.map(pt => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(','));
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

        // Overlays — only emit when non-default (both default to false)
        if (state.showWireframe) p.set('wireframe', '1');
        if (state.showAxis) p.set('axis', '1');

        // Slice planes — only emit when in slice mode
        if (state.mode === 'slice') {
          p.set('slices', `${state.sliceX.toFixed(2)},${state.sliceY.toFixed(2)},${state.sliceZ.toFixed(2)}`);
          const visMask = (state.showSliceX ? 1 : 0) | (state.showSliceY ? 2 : 0) | (state.showSliceZ ? 4 : 0);
          if (visMask !== 7) p.set('sliceVis', String(visMask)); // omit when all visible
        }

        return `${window.location.origin}${window.location.pathname}?${p.toString()}`;
      },
    });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  window.addEventListener('beforeunload', () => {
    viewer.dispose();
  });
}

function showError(message: string) {
  const el = document.getElementById('error');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
  console.error(message);
}

// Wire up the top bar (provides #load-dataset-btn / #share-btn) and dialog —
// skipped entirely in embed mode.
const topBar = IS_EMBED ? null : mountTopBar();
if (!IS_EMBED) {
  mountDatasetDialog({
    remoteDescription: 'Enter URL to an OME-Zarr dataset or Kiln sharded binary',
    docsLink: 'https://github.com/MPanknin/kiln-render/blob/main/docs/data/ome-zarr.md',
  });
}

main().catch((e) => {
  if (e instanceof UnsupportedDatasetError) {
    showDialogError(e.reasons, true);
  } else {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'WebGPU not supported' || msg === 'WebGPU device creation failed') {
      trackEvent('webgpu-failed', msg);
    }
    showError(msg);
  }
});
