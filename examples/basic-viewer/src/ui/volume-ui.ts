/**
 * Volume Renderer UI Controls using Tweakpane
 */

import { Pane } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
// @kiln/* is a dev-only path alias (src/ → @kiln/) defined in vite.config.ts and
// tsconfig.json. It gives the example direct access to internal library types that
// are not part of the public API.
import type { TransferFunction, TFPreset } from '@kiln/core/transfer-function.js';
import type { Renderer, VolumeRenderMode } from '@kiln/core/renderer.js';
import type { Camera, UpAxis } from '@kiln/core/camera.js';
import type { StreamingManager } from '@kiln/streaming/streaming-manager.js';
import type { VolumeMetadata } from '@kiln/data/data-provider.js';
import { computeHistogram } from '@kiln/core/histogram.js';
import type { KilnViewer } from 'kiln-render';

// Tweakpane's types don't fully export FolderApi, so use a minimal interface
interface TweakpaneFolder {
  hidden: boolean;
  element: HTMLElement;
  addBinding: (obj: object, key: string, params?: object) => { element: HTMLElement; on: (event: string, cb: (ev: { value: unknown }) => void) => void };
}

// Extended Pane type with methods that exist at runtime but aren't in types
interface ExtendedPane extends Pane {
  addBinding: (obj: object, key: string, params?: object) => { on: (event: string, cb: (ev: { value: unknown }) => void) => void };
  addFolder: (params: { title: string; expanded?: boolean }) => TweakpaneFolder;
  refresh: () => void;
}

export class VolumeUI {
  private viewer: KilnViewer;
  private pane: Pane;
  private statsPane: Pane;
  private renderer: Renderer;
  private camera: Camera;
  private transferFunction: TransferFunction;
  private streamingManager: StreamingManager | null = null;
  private metadata: VolumeMetadata | null = null;

  private tfCanvas: HTMLCanvasElement;
  private isDraggingPoint = false;
  private dragPointIndex = -1;

  // Tweakpane params object
  private params = {
    renderMode: 'dvr' as VolumeRenderMode,
    isoValue: 0.2,
    tfPreset: 'grayscale' as TFPreset,
    upAxis: '-y' as UpAxis,
    useIndirection: true,
    showWireframe: false,
    showAxis: false,
    // Windowing/Leveling for 16-bit data
    windowCenter: 0.5,
    windowWidth: 1.0,
    densityScale: 1.0,
    // Render scale
    renderScale: 0.5,
    // Jitter / TAA
    enableJitter: true,
    enableTAA: true,
    // Clipping planes (0-1 range for each axis)
    clipX: { min: 0.0, max: 1.0 },
    clipY: { min: 0.0, max: 1.0 },
    clipZ: { min: 0.0, max: 1.0 },
    // Slice planes
    showSliceX: true,
    sliceX: 0.5,
    showSliceY: true,
    sliceY: 0.5,
    showSliceZ: true,
    sliceZ: 0.5,
  };

  // Stats display (read-only, updated periodically)
  private statsParams = {
    // Performance
    fps: '',
    frameTime: '',
    timeToFirstRender: '',
    // Dataset
    dimensions: '',
    fileSize: '',
    spacing: '',
    lodLevels: '',
    textureFormat: '',
    // Streaming
    cacheUsage: '',
    pendingBricks: '',
    evictedBricks: '',
    throughput: '',
    totalDownloaded: '',
    brickLatency: '',
    // Pipeline
    pipelineQueue: '',
    pipelineFetch: '',
    pipelineAssembly: '',
    pipelineUpload: '',
    brickLifecycle: '',
    wastedRate: '',
    chunkCacheHit: '',
  };

  // Frame timing tracking
  private frameTimes: number[] = [];
  private lastFrameTime = 0;

  // Folder references for visibility toggling
  private isoFolder: TweakpaneFolder | null = null;
  private tfFolder: TweakpaneFolder | null = null;
  private windowFolder: TweakpaneFolder | null = null;
  private clipFolder: TweakpaneFolder | null = null;
  private sliceFolder: TweakpaneFolder | null = null;

  constructor(viewer: KilnViewer) {
    this.viewer = viewer;
    this.renderer = viewer.renderer;
    this.camera = viewer.camera;
    this.transferFunction = viewer.transferFunction;

    // Initialize slice/clip params in absolute dataset coordinates
    const dims = viewer.metadata.dimensions;
    this.params.sliceX = Math.round(dims[0] / 2);
    this.params.sliceY = Math.round(dims[1] / 2);
    this.params.sliceZ = Math.round(dims[2] / 2);
    this.params.clipX = { min: 0, max: dims[0] };
    this.params.clipY = { min: 0, max: dims[1] };
    this.params.clipZ = { min: 0, max: dims[2] };

    // Sync initial values from camera/renderer
    this.params.upAxis = this.camera.getUpAxis();
    this.params.useIndirection = this.renderer.useIndirection;
    this.params.showWireframe = this.renderer.showWireframe;
    this.params.showAxis = this.renderer.showAxis;
    this.params.windowCenter = this.renderer.windowCenter;
    this.params.windowWidth = this.renderer.windowWidth;
    this.params.renderScale = this.renderer.renderScale;

    // Create controls pane in top-left corner
    const controlsContainer = document.createElement('div');
    controlsContainer.style.cssText = 'position: fixed; left: 8px; top: 50px; z-index: 1000;';
    document.body.appendChild(controlsContainer);

    this.pane = new Pane({
      title: 'Controls',
      container: controlsContainer,
      expanded: false,
    });
    this.pane.registerPlugin(EssentialsPlugin);

    // Icon-only collapsed state for controls pane
    this.setupIconCollapse(this.pane, '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/></svg>', 'Controls');

    // Create stats pane in lower left corner
    const statsContainer = document.createElement('div');
    statsContainer.style.cssText = 'position: fixed; left: 8px; bottom: calc(8px + env(safe-area-inset-bottom, 0px)); z-index: 1000;';
    document.body.appendChild(statsContainer);

    this.statsPane = new Pane({
      title: 'Stats',
      container: statsContainer,
      expanded: false,
    });

    // Icon-only collapsed state for stats pane
    this.setupIconCollapse(this.statsPane, '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1 11a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1zm5-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1zm5-5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1z"/></svg>', 'Stats');

    this.tfCanvas = document.createElement('canvas');
    this.tfCanvas.width = 256;
    this.tfCanvas.height = 80;

    this.setupControls();
    this.setupStatsPane();
    this.setupTFCanvasEvents();
    this.updateTFPreview();
    this.updateVisibility();
    this.initStreaming(viewer.streamingManager, viewer.metadata);
  }

  private setupControls(): void {
    const pane = this.pane as unknown as ExtendedPane;

    // Render Mode
    pane.addBinding(this.params, 'renderMode', {
      label: 'Mode',
      options: {
        DVR: 'dvr',
        MIP: 'mip',
        ISO: 'iso',
        Slices: 'slice',
        LOD: 'lod',
        'Slice LOD': 'slice-lod',
      },
    }).on('change', (ev: { value: unknown }) => {
      const mode = ev.value as VolumeRenderMode;
      this.renderer.volumeRenderMode = mode;
      this.renderer.resetAccumulation();
      this.updateVisibility();
    });

    // Camera Up Axis
    pane.addBinding(this.params, 'upAxis', {
      label: 'Up Axis',
      options: {
        'X': 'x',
        'Y': 'y',
        'Z': 'z',
        '-X': '-x',
        '-Y': '-y',
        '-Z': '-z',
      },
    }).on('change', (ev: { value: unknown }) => {
      this.camera.setUpAxis(ev.value as UpAxis);
      this.renderer.resetAccumulation();
    });

    // Render scale slider
    pane.addBinding(this.params, 'renderScale', {
      label: 'Render Scale',
      min: 0.25,
      max: 1.0,
      step: 0.25,
    }).on('change', (ev: { value: unknown }) => {
      this.viewer.renderScale = ev.value as number;
    });

    // Isosurface folder
    this.isoFolder = pane.addFolder({
      title: 'Isosurface',
    });

    this.isoFolder.addBinding(this.params, 'isoValue', {
      label: 'ISO Value',
      min: 0,
      max: 1,
      step: 0.01,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.isoValue = ev.value as number;
      this.renderer.resetAccumulation();
    });

    // Transfer Function folder
    this.tfFolder = pane.addFolder({
      title: 'Transfer Function',
    });

    this.tfFolder.addBinding(this.params, 'tfPreset', {
      label: 'Preset',
      options: {
        'Cool-Warm': 'coolwarm',
        'Grayscale': 'grayscale',
        'Grayscale (inverted)': 'grayscale-inverted',
        'Hot': 'hot',
        'Cool': 'cool',
        'Viridis': 'viridis',
        'Plasma': 'plasma',
        'Seismic': 'seismic',
      },
    }).on('change', (ev: { value: unknown }) => {
      this.transferFunction.setPreset(ev.value as TFPreset);
      this.renderer.resetAccumulation();
      this.updateTFPreview();
    });

    // Add canvas as a blade element
    const canvasContainer = document.createElement('div');
    canvasContainer.style.cssText = 'padding: 4px 0;';

    this.tfCanvas.style.cssText = `
      width: 100%;
      height: 80px;
      border: 1px solid #555;
      border-radius: 4px;
      cursor: crosshair;
      box-sizing: border-box;
    `;
    canvasContainer.appendChild(this.tfCanvas);

    const helpText = document.createElement('div');
    helpText.textContent = 'Click to add, drag to move, dbl-click to remove';
    helpText.style.cssText = 'font-size: 10px; color: #666; margin-top: 4px;';
    canvasContainer.appendChild(helpText);

    // Inject canvas into the TF folder
    const tfFolderElement = this.tfFolder.element;
    const containerEl = tfFolderElement.querySelector('.tp-fldv_c');
    if (containerEl) {
      containerEl.appendChild(canvasContainer);
    }

    // Windowing/Leveling folder (for 16-bit data contrast adjustment)
    this.windowFolder = pane.addFolder({
      title: 'Window/Level',
    });

    this.windowFolder.addBinding(this.params, 'windowCenter', {
      label: 'Center',
      min: 0,
      max: 1,
      step: 0.01,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.windowCenter = ev.value as number;
      this.renderer.resetAccumulation();
      this.updateTFPreview();
    });

    this.windowFolder.addBinding(this.params, 'windowWidth', {
      label: 'Width',
      min: 0.01,
      max: 1,
      step: 0.01,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.windowWidth = ev.value as number;
      this.renderer.resetAccumulation();
      this.updateTFPreview();
    });

    this.windowFolder.addBinding(this.params, 'densityScale', {
      label: 'Density',
      min: 0.1,
      max: 10.0,
      step: 0.1,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.densityScale = ev.value as number;
      this.renderer.resetAccumulation();
    });

    // Clipping Planes folder
    this.clipFolder = pane.addFolder({
      title: 'Clipping Planes',
      expanded: false,
    });
    const clipFolder = this.clipFolder;

    const clipDims = this.viewer.metadata.dimensions;

    clipFolder.addBinding(this.params, 'clipX', {
      label: 'X', min: 0, max: clipDims[0], step: 1,
    }).on('change', (ev: { value: unknown }) => {
      const v = ev.value as { min: number; max: number };
      this.renderer.clipMin[0] = v.min / clipDims[0];
      this.renderer.clipMax[0] = v.max / clipDims[0];
      this.renderer.resetAccumulation();
    });

    clipFolder.addBinding(this.params, 'clipY', {
      label: 'Y', min: 0, max: clipDims[1], step: 1,
    }).on('change', (ev: { value: unknown }) => {
      const v = ev.value as { min: number; max: number };
      this.renderer.clipMin[1] = v.min / clipDims[1];
      this.renderer.clipMax[1] = v.max / clipDims[1];
      this.renderer.resetAccumulation();
    });

    clipFolder.addBinding(this.params, 'clipZ', {
      label: 'Z', min: 0, max: clipDims[2], step: 1,
    }).on('change', (ev: { value: unknown }) => {
      const v = ev.value as { min: number; max: number };
      this.renderer.clipMin[2] = v.min / clipDims[2];
      this.renderer.clipMax[2] = v.max / clipDims[2];
      this.renderer.resetAccumulation();
    });

    // Slice Planes folder (hidden until slice mode is selected)
    this.sliceFolder = pane.addFolder({ title: 'Slice Planes', expanded: true });

    const sliceDims = this.viewer.metadata.dimensions;
    const addSliceRow = (label: string, posKey: keyof typeof this.params, visKey: keyof typeof this.params, dim: number) => {
      const folder = this.sliceFolder!;
      const posBinding = folder.addBinding(this.params, posKey as string, { label, min: 0, max: dim, step: 1 });
      posBinding.on('change', (ev: { value: unknown }) => {
        (this.renderer as unknown as Record<string, number>)[posKey as string] = (ev.value as number) / dim;
        this.renderer.markDirty();
      });
      const visBinding = folder.addBinding(this.params, visKey as string, { label: '' });
      visBinding.on('change', (ev: { value: unknown }) => {
        (this.renderer as unknown as Record<string, boolean>)[visKey as string] = ev.value as boolean;
        this.renderer.markDirty();
      });

      // Combine into a single flex row
      const posEl = posBinding.element as HTMLElement;
      const visEl = visBinding.element as HTMLElement;
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display: flex; align-items: center; width: 100%;';
      posEl.style.flex = '1';
      // Compact checkbox: hide label text, shrink to fit
      const visLabelEl = visEl.querySelector('.tp-lblv_l') as HTMLElement | null;
      if (visLabelEl) visLabelEl.style.display = 'none';
      const visValueEl = visEl.querySelector('.tp-lblv_v') as HTMLElement | null;
      if (visValueEl) visValueEl.style.width = 'auto';
      posEl.parentElement?.insertBefore(wrapper, posEl);
      wrapper.appendChild(posEl);
      wrapper.appendChild(visEl);
    };

    addSliceRow('X', 'sliceX', 'showSliceX', sliceDims[0]);
    addSliceRow('Y', 'sliceY', 'showSliceY', sliceDims[1]);
    addSliceRow('Z', 'sliceZ', 'showSliceZ', sliceDims[2]);

    // Debug folder (collapsed by default)
    const debugFolder = pane.addFolder({ title: 'Debug', expanded: false });

    debugFolder.addBinding(this.params, 'enableJitter', {
      label: 'Jitter',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.enableJitter = ev.value as boolean;
      this.renderer.resetAccumulation();
    });

    debugFolder.addBinding(this.params, 'enableTAA', {
      label: 'TAA',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.enableTAA = ev.value as boolean;
      this.renderer.resetAccumulation();
    });

    debugFolder.addBinding(this.params, 'useIndirection', {
      label: 'Indirection',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.useIndirection = ev.value as boolean;
      this.renderer.resetAccumulation();
    });

    debugFolder.addBinding(this.params, 'showWireframe', {
      label: 'Wireframe',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.showWireframe = ev.value as boolean;
      this.renderer.markDirty();
    });

    debugFolder.addBinding(this.params, 'showAxis', {
      label: 'Axis',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.showAxis = ev.value as boolean;
      this.renderer.markDirty();
    });
  }

  private setupStatsPane(): void {
    const statsPane = this.statsPane as unknown as ExtendedPane;

    // Performance section
    const perfFolder = statsPane.addFolder({ title: 'Performance' });

    perfFolder.addBinding(this.statsParams, 'fps', {
      label: 'FPS',
      readonly: true,
    });

    perfFolder.addBinding(this.statsParams, 'frameTime', {
      label: 'Frame',
      readonly: true,
    });

    perfFolder.addBinding(this.statsParams, 'timeToFirstRender', {
      label: 'First Render',
      readonly: true,
    });

    // Dataset section
    const dataFolder = statsPane.addFolder({ title: 'Dataset' });

    dataFolder.addBinding(this.statsParams, 'dimensions', {
      label: 'Size',
      readonly: true,
    });

    dataFolder.addBinding(this.statsParams, 'fileSize', {
      label: 'File Size',
      readonly: true,
    });

    dataFolder.addBinding(this.statsParams, 'spacing', {
      label: 'Spacing',
      readonly: true,
    });

    dataFolder.addBinding(this.statsParams, 'lodLevels', {
      label: 'LODs',
      readonly: true,
    });

    dataFolder.addBinding(this.statsParams, 'textureFormat', {
      label: 'Format',
      readonly: true,
    });

    // Streaming section — operational health
    const streamFolder = statsPane.addFolder({ title: 'Streaming', expanded: false });
    streamFolder.addBinding(this.statsParams, 'cacheUsage', { label: 'Cache', readonly: true });
    streamFolder.addBinding(this.statsParams, 'pendingBricks', { label: 'Pending', readonly: true });
    streamFolder.addBinding(this.statsParams, 'evictedBricks', { label: 'Evicted', readonly: true });
    streamFolder.addBinding(this.statsParams, 'throughput', { label: 'Throughput', readonly: true });
    streamFolder.addBinding(this.statsParams, 'totalDownloaded', { label: 'Downloaded', readonly: true });
    streamFolder.addBinding(this.statsParams, 'brickLatency', { label: 'Latency', readonly: true });

    // Pipeline section — per-brick diagnostics
    const pipeFolder = statsPane.addFolder({ title: 'Pipeline', expanded: false });
    pipeFolder.addBinding(this.statsParams, 'pipelineQueue', { label: 'Queue', readonly: true });
    pipeFolder.addBinding(this.statsParams, 'pipelineFetch', { label: 'Fetch', readonly: true });
    pipeFolder.addBinding(this.statsParams, 'pipelineAssembly', { label: 'Assembly', readonly: true });
    pipeFolder.addBinding(this.statsParams, 'pipelineUpload', { label: 'Upload', readonly: true });
    pipeFolder.addBinding(this.statsParams, 'brickLifecycle', { label: 'Lifecycle', readonly: true });
    pipeFolder.addBinding(this.statsParams, 'wastedRate', { label: 'Wasted', readonly: true });
    pipeFolder.addBinding(this.statsParams, 'chunkCacheHit', { label: 'Cache hit', readonly: true });
  }

  private initStreaming(manager: StreamingManager, metadata: VolumeMetadata): void {
    this.streamingManager = manager;
    this.metadata = metadata;

    // Set static metadata info
    const dims = metadata.dimensions;
    const chSuffix = metadata.numChannels > 1 ? ` × ${metadata.numChannels}ch` : '';
    this.statsParams.dimensions = `${dims[0]} × ${dims[1]} × ${dims[2]}${chSuffix}`;

    // Calculate raw file size in MB based on bit depth
    const totalVoxels = dims[0] * dims[1] * dims[2];
    const bytesPerVoxel = metadata.bitDepth === 16 ? 2 : 1;
    const fileSizeMB = (totalVoxels * bytesPerVoxel) / (1024 * 1024);
    this.statsParams.fileSize = `${fileSizeMB.toFixed(1)} MB (raw ${metadata.bitDepth}-bit)`;

    const spacing = metadata.voxelSpacing ?? [1, 1, 1];
    this.statsParams.spacing = `${spacing[0].toFixed(2)} × ${spacing[1].toFixed(2)} × ${spacing[2].toFixed(2)}`;

    const codec = metadata.compression;
    this.statsParams.lodLevels = `${metadata.levels.length} (LOD 0-${metadata.maxLod})${codec ? ` · ${codec}` : ''}`;

    const format = this.renderer.canvas.format;
    this.statsParams.textureFormat = format + (format === 'r8unorm' && metadata.bitDepth === 16 ? ' (⚠️ downsampled)' : '');

    // Set up histogram computation when base LOD is loaded
    manager.setBaseLodLoadedCallback((brickData) => {
      this.onBaseLodLoaded(brickData);
    });

    // Start periodic stats update
    this.startStatsUpdate();
  }

  private statsUpdateInterval: number | null = null;

  private startStatsUpdate(): void {
    if (this.statsUpdateInterval !== null) return;

    this.statsUpdateInterval = window.setInterval(() => {
      this.updateStats();
    }, 250); // Update 4 times per second
  }

  private updateStats(): void {
    // Update performance stats
    if (this.frameTimes.length > 0) {
      const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      const fps = 1000 / avgFrameTime;
      this.statsParams.fps = `${fps.toFixed(1)}`;
      this.statsParams.frameTime = `${avgFrameTime.toFixed(2)} ms`;
    }

    // Update streaming stats
    if (this.streamingManager) {
      const stats = this.streamingManager.getStats();

      // Streaming
      const atlasPercent = ((stats.atlasUsage / stats.atlasCapacity) * 100).toFixed(0);
      this.statsParams.cacheUsage = `${stats.atlasUsage}/${stats.atlasCapacity} (${atlasPercent}%)`;
      this.statsParams.pendingBricks = `${stats.pendingCount}`;
      this.statsParams.evictedBricks = `${stats.evictedCount}`;
      const throughputMBps = stats.bytesPerSecond / (1024 * 1024);
      this.statsParams.throughput = `${throughputMBps.toFixed(2)} MB/s`;
      const totalMB = stats.totalBytesDownloaded / (1024 * 1024);
      this.statsParams.totalDownloaded = `${totalMB.toFixed(2)} MB`;
      this.statsParams.brickLatency = stats.avgBrickLatencyMs > 0 ? `${stats.avgBrickLatencyMs.toFixed(1)} ms` : '—';

      // Pipeline
      const pt = stats.pipelineTimings;
      this.statsParams.pipelineQueue = pt.sampleCount > 0 ? `${pt.avgQueueMs.toFixed(1)} ms` : '—';
      this.statsParams.pipelineFetch = pt.sampleCount > 0 ? `${pt.avgFetchMs.toFixed(1)} ms` : '—';
      this.statsParams.pipelineAssembly = pt.sampleCount > 0 ? `${pt.avgAssemblyMs.toFixed(1)} ms` : '—';
      this.statsParams.pipelineUpload = pt.sampleCount > 0 ? `${pt.avgUploadMs.toFixed(1)} ms` : '—';
      const d = stats.bricksDispatched;
      const c = stats.bricksCommitted;
      const x = stats.bricksCancelled;
      const w = stats.bricksDiscarded;
      this.statsParams.brickLifecycle = `D:${d} C:${c} X:${x} W:${w}`;
      const wastedDenom = c + w;
      this.statsParams.wastedRate = wastedDenom > 0 ? `${((w / wastedDenom) * 100).toFixed(1)}%` : '—';
      const hitRatio = pt.chunkCacheHitRatio;
      this.statsParams.chunkCacheHit = hitRatio !== undefined ? `${(hitRatio * 100).toFixed(1)}%` : '—';

      // Time to first render
      if (stats.timeToFirstRender !== null) {
        this.statsParams.timeToFirstRender = `${stats.timeToFirstRender.toFixed(0)} ms`;
      } else {
        this.statsParams.timeToFirstRender = 'Loading...';
      }

      // Update loading spinner
      const spinner = document.getElementById('spinner');
      if (spinner) {
        spinner.classList.toggle('active', stats.pendingCount > 0);
      }
    }

    // Force stats pane refresh
    (this.statsPane as unknown as ExtendedPane).refresh();
  }

  /**
   * Record a frame time for performance tracking
   * Call this once per frame from the render loop
   */
  recordFrame(): void {
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      const delta = now - this.lastFrameTime;
      this.frameTimes.push(delta);
      // Keep last 60 frames for averaging
      if (this.frameTimes.length > 60) {
        this.frameTimes.shift();
      }
    }
    this.lastFrameTime = now;
  }

  private setupTFCanvasEvents(): void {
    const canvas = this.tfCanvas;
    let lastClickTime = 0;

    const getPointAt = (x: number, y: number): number => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (x - rect.left) * scaleX;
      const canvasY = (y - rect.top) * scaleY;

      const points = this.transferFunction.getOpacityPoints();
      for (let i = 0; i < points.length; i++) {
        const px = points[i]!.x * canvas.width;
        const py = canvas.height - points[i]!.y * canvas.height;
        const dist = Math.sqrt((canvasX - px) ** 2 + (canvasY - py) ** 2);
        if (dist < 10) return i;
      }
      return -1;
    };

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      const now = Date.now();
      const isDoubleClick = now - lastClickTime < 300;
      lastClickTime = now;

      const pointIndex = getPointAt(e.clientX, e.clientY);

      if (isDoubleClick && pointIndex > 0 && pointIndex < this.transferFunction.getOpacityPoints().length - 1) {
        // Double click on non-endpoint: remove point
        const points = this.transferFunction.getOpacityPoints();
        points.splice(pointIndex, 1);
        this.transferFunction.setOpacityPoints(points);
        this.updateTFPreview();
      } else if (pointIndex >= 0) {
        // Start dragging existing point
        this.isDraggingPoint = true;
        this.dragPointIndex = pointIndex;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', stopDrag);
      } else {
        // Add new point
        const x = canvasX / canvas.width;
        const y = 1 - canvasY / canvas.height;
        const points = this.transferFunction.getOpacityPoints();
        points.push({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
        this.transferFunction.setOpacityPoints(points);
        this.updateTFPreview();
      }
    });

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isDraggingPoint) return;

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      const points = this.transferFunction.getOpacityPoints();
      const point = points[this.dragPointIndex];
      if (!point) return;

      // Endpoints can only move vertically
      if (this.dragPointIndex === 0 || this.dragPointIndex === points.length - 1) {
        point.y = Math.max(0, Math.min(1, 1 - canvasY / canvas.height));
      } else {
        point.x = Math.max(0.01, Math.min(0.99, canvasX / canvas.width));
        point.y = Math.max(0, Math.min(1, 1 - canvasY / canvas.height));
      }

      this.transferFunction.setOpacityPoints(points);
      this.updateTFPreview();
    };

    const stopDrag = () => {
      if (!this.isDraggingPoint) return;
      this.isDraggingPoint = false;
      this.dragPointIndex = -1;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', stopDrag);
    };

  }

  private updateTFPreview(): void {
    this.transferFunction.renderPreview(
      this.tfCanvas,
      this.renderer.windowCenter,
      this.renderer.windowWidth
    );
    this.renderer.resetAccumulation();
  }

  refreshTFPreview(): void {
    this.updateTFPreview();
  }

  /** Called when base LOD is loaded - computes and displays histogram */
  private onBaseLodLoaded(brickData: (Uint8Array | Uint16Array)[]): void {
    if (!this.metadata) return;

    const histogram = computeHistogram(
      brickData,
      this.metadata.bitDepth,
      256,
      this.metadata.isFloat ?? false,
      this.metadata.dataRange?.[0] ?? 0,
      this.metadata.dataRange?.[1] ?? 1,
      this.renderer.canvas.format,
    );
    this.transferFunction.setHistogram(histogram);
    this.updateTFPreview();
  }

  /** Sync UI params from current renderer/camera state (e.g. after applying URL params) */
  syncFromState(): void {
    this.params.renderMode = this.renderer.volumeRenderMode;
    this.params.isoValue = this.renderer.isoValue;
    this.params.windowCenter = this.renderer.windowCenter;
    this.params.windowWidth = this.renderer.windowWidth;
    this.params.renderScale = this.viewer.renderScale;
    this.params.upAxis = this.camera.getUpAxis();
    this.params.tfPreset = this.transferFunction.preset;
    const syncDims = this.viewer.metadata.dimensions;
    this.params.clipX = { min: Math.round(this.renderer.clipMin[0]! * syncDims[0]), max: Math.round(this.renderer.clipMax[0]! * syncDims[0]) };
    this.params.clipY = { min: Math.round(this.renderer.clipMin[1]! * syncDims[1]), max: Math.round(this.renderer.clipMax[1]! * syncDims[1]) };
    this.params.clipZ = { min: Math.round(this.renderer.clipMin[2]! * syncDims[2]), max: Math.round(this.renderer.clipMax[2]! * syncDims[2]) };
    this.params.sliceX = Math.round(this.renderer.sliceX * syncDims[0]);
    this.params.sliceY = Math.round(this.renderer.sliceY * syncDims[1]);
    this.params.sliceZ = Math.round(this.renderer.sliceZ * syncDims[2]);
    this.params.showSliceX = this.renderer.showSliceX;
    this.params.showSliceY = this.renderer.showSliceY;
    this.params.showSliceZ = this.renderer.showSliceZ;
    this.params.showWireframe = this.renderer.showWireframe;
    this.params.showAxis = this.renderer.showAxis;
    (this.pane as unknown as ExtendedPane).refresh();
    this.updateVisibility();
    this.updateTFPreview();
  }

  /** Make a Tweakpane pane show only an icon when collapsed, full title when expanded */
  private setupIconCollapse(pane: Pane, iconSvg: string, title: string): void {
    const el = pane.element;
    const titleEl = el.querySelector('.tp-rotv_t') as HTMLElement | null;
    const btn = el.querySelector('.tp-rotv_b') as HTMLElement | null;
    const arrow = el.querySelector('.tp-rotv_m') as HTMLElement | null;
    if (!titleEl || !btn) return;

    const applyCollapsed = () => {
      titleEl.innerHTML = iconSvg;
      titleEl.style.display = 'flex';
      titleEl.style.alignItems = 'center';
      titleEl.style.justifyContent = 'center';
      btn.style.width = '36px';
      btn.style.height = '36px';
      btn.style.padding = '0';
      btn.style.textAlign = 'center';
      btn.style.borderRadius = '6px';
      el.style.width = '36px';
      if (arrow) arrow.style.display = 'none';
    };

    const applyExpanded = () => {
      titleEl.innerHTML = title;
      titleEl.style.display = '';
      titleEl.style.alignItems = '';
      titleEl.style.justifyContent = '';
      btn.style.width = '';
      btn.style.height = '';
      btn.style.padding = '';
      btn.style.textAlign = '';
      btn.style.borderRadius = '';
      el.style.width = '';
      if (arrow) arrow.style.display = '';
    };

    // Set initial state
    applyCollapsed();

    // Listen for expand/collapse
    btn.addEventListener('click', () => {
      // Tweakpane toggles after the click, so defer
      requestAnimationFrame(() => {
        const isExpanded = el.classList.contains('tp-rotv-expanded');
        if (isExpanded) {
          applyExpanded();
        } else {
          applyCollapsed();
        }
      });
    });
  }

  private updateVisibility(): void {
    const mode = this.params.renderMode;
    const isSlice = mode === 'slice' || mode === 'slice-lod';

    // ISO section only in ISO mode
    if (this.isoFolder) this.isoFolder.hidden = mode !== 'iso';

    // TF hidden only in ISO mode
    if (this.tfFolder) this.tfFolder.hidden = mode === 'iso';

    // Window/Level hidden in LOD debug
    if (this.windowFolder) this.windowFolder.hidden = mode === 'lod';

    // Clipping planes only relevant in volume modes
    if (this.clipFolder) this.clipFolder.hidden = isSlice;

    // Slice folder only visible in slice mode
    if (this.sliceFolder) this.sliceFolder.hidden = !isSlice;
  }
}
