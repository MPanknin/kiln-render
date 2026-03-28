/**
 * Volume Renderer UI Controls using Tweakpane
 */

import { Pane } from 'tweakpane';
import { TransferFunction, TFPreset } from '../core/transfer-function.js';
import { Renderer, VolumeRenderMode } from '../core/renderer.js';
import { Camera, UpAxis } from '../core/camera.js';
import { StreamingManager } from '../streaming/streaming-manager.js';
import type { VolumeMetadata } from '../data/data-provider.js';

// Tweakpane's types don't fully export FolderApi, so use a minimal interface
interface TweakpaneFolder {
  hidden: boolean;
  element: HTMLElement;
  addBinding: (obj: object, key: string, params?: object) => { on: (event: string, cb: (ev: { value: unknown }) => void) => void };
}

// Extended Pane type with methods that exist at runtime but aren't in types
interface ExtendedPane extends Pane {
  addBinding: (obj: object, key: string, params?: object) => { on: (event: string, cb: (ev: { value: unknown }) => void) => void };
  addFolder: (params: { title: string; expanded?: boolean }) => TweakpaneFolder;
  refresh: () => void;
}

export class VolumeUI {
  private pane: Pane;
  private statsPane: Pane;
  private renderer: Renderer;
  private camera: Camera;
  private transferFunction: TransferFunction;
  private streamingManager: StreamingManager | null = null;

  private tfCanvas: HTMLCanvasElement;
  private isDraggingPoint = false;
  private dragPointIndex = -1;

  // Callback for when user changes render scale
  private onRenderScaleChange: ((scale: number) => void) | null = null;

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
    // Render scale
    renderScale: 0.5,
    // Clipping planes (0-1 range for each axis)
    clipMinX: 0.0,
    clipMaxX: 1.0,
    clipMinY: 0.0,
    clipMaxY: 1.0,
    clipMinZ: 0.0,
    clipMaxZ: 1.0,
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
    atlasUsage: '',
    loadedBricks: '',
    pendingBricks: '',
    evictedBricks: '',
    culledBricks: '',
    emptyBricks: '',
    // Network
    throughput: '',
    totalDownloaded: '',
  };

  // Frame timing tracking
  private frameTimes: number[] = [];
  private lastFrameTime = 0;

  // Folder references for visibility toggling
  private isoFolder: TweakpaneFolder | null = null;
  private tfFolder: TweakpaneFolder | null = null;
  private windowFolder: TweakpaneFolder | null = null;

  constructor(
    renderer: Renderer,
    camera: Camera,
    transferFunction: TransferFunction
  ) {
    this.renderer = renderer;
    this.camera = camera;
    this.transferFunction = transferFunction;

    // Sync initial values from camera/renderer
    this.params.upAxis = camera.getUpAxis();
    this.params.useIndirection = renderer.useIndirection;
    this.params.showWireframe = renderer.showWireframe;
    this.params.showAxis = renderer.showAxis;
    this.params.windowCenter = renderer.windowCenter;
    this.params.windowWidth = renderer.windowWidth;
    this.params.renderScale = renderer.renderScale;

    // Create controls pane in top-left corner
    const controlsContainer = document.createElement('div');
    controlsContainer.style.cssText = 'position: fixed; left: 8px; top: 8px; z-index: 1000;';
    document.body.appendChild(controlsContainer);

    this.pane = new Pane({
      title: 'Controls',
      container: controlsContainer,
      expanded: false,
    });

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
        LOD: 'lod',
      },
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.volumeRenderMode = ev.value as VolumeRenderMode;
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
    });

    // Render scale slider
    pane.addBinding(this.params, 'renderScale', {
      label: 'Render Scale',
      min: 0.25,
      max: 1.0,
      step: 0.25,
    }).on('change', (ev: { value: unknown }) => {
      const scale = ev.value as number;
      this.renderer.renderScale = scale;
      this.renderer.resizeComputeTexture();
      // Notify callback if set (for dynamic scaling during interaction)
      this.onRenderScaleChange?.(scale);
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
    });

    this.windowFolder.addBinding(this.params, 'windowWidth', {
      label: 'Width',
      min: 0.01,
      max: 1,
      step: 0.01,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.windowWidth = ev.value as number;
      this.renderer.resetAccumulation();
    });

    // Clipping Planes folder
    const clipFolder = pane.addFolder({
      title: 'Clipping Planes',
      expanded: false,
    });

    // X-axis
    clipFolder.addBinding(this.params, 'clipMinX', {
      label: 'X Min',
      min: 0,
      max: 1,
      step: 0.01,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.clipMin[0] = ev.value as number;
      this.renderer.resetAccumulation();
    });

    clipFolder.addBinding(this.params, 'clipMaxX', {
      label: 'X Max',
      min: 0,
      max: 1,
      step: 0.01,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.clipMax[0] = ev.value as number;
      this.renderer.resetAccumulation();
    });

    // Y-axis
    clipFolder.addBinding(this.params, 'clipMinY', {
      label: 'Y Min',
      min: 0,
      max: 1,
      step: 0.01,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.clipMin[1] = ev.value as number;
      this.renderer.resetAccumulation();
    });

    clipFolder.addBinding(this.params, 'clipMaxY', {
      label: 'Y Max',
      min: 0,
      max: 1,
      step: 0.01,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.clipMax[1] = ev.value as number;
      this.renderer.resetAccumulation();
    });

    // Z-axis
    clipFolder.addBinding(this.params, 'clipMinZ', {
      label: 'Z Min',
      min: 0,
      max: 1,
      step: 0.01,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.clipMin[2] = ev.value as number;
      this.renderer.resetAccumulation();
    });

    clipFolder.addBinding(this.params, 'clipMaxZ', {
      label: 'Z Max',
      min: 0,
      max: 1,
      step: 0.01,
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.clipMax[2] = ev.value as number;
      this.renderer.resetAccumulation();
    });

    // Debug folder (collapsed by default)
    const debugFolder = pane.addFolder({ title: 'Debug', expanded: false });

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
    });

    debugFolder.addBinding(this.params, 'showAxis', {
      label: 'Axis',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.showAxis = ev.value as boolean;
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

    // Streaming section
    const streamFolder = statsPane.addFolder({ title: 'Streaming', expanded: false });

    streamFolder.addBinding(this.statsParams, 'atlasUsage', {
      label: 'Atlas',
      readonly: true,
    });

    streamFolder.addBinding(this.statsParams, 'loadedBricks', {
      label: 'Loaded',
      readonly: true,
    });

    streamFolder.addBinding(this.statsParams, 'pendingBricks', {
      label: 'Pending',
      readonly: true,
    });

    streamFolder.addBinding(this.statsParams, 'evictedBricks', {
      label: 'Evicted',
      readonly: true,
    });

    streamFolder.addBinding(this.statsParams, 'culledBricks', {
      label: 'Culled',
      readonly: true,
    });

    streamFolder.addBinding(this.statsParams, 'emptyBricks', {
      label: 'Empty',
      readonly: true,
    });

    // Network section
    const netFolder = statsPane.addFolder({ title: 'Network', expanded: false });

    netFolder.addBinding(this.statsParams, 'throughput', {
      label: 'Throughput',
      readonly: true,
    });

    netFolder.addBinding(this.statsParams, 'totalDownloaded', {
      label: 'Downloaded',
      readonly: true,
    });
  }

  /**
   * Set the streaming manager and metadata for stats display
   */
  /** Set callback for when user changes render scale via UI */
  setRenderScaleCallback(callback: (scale: number) => void): void {
    this.onRenderScaleChange = callback;
  }

  setStreamingManager(manager: StreamingManager, metadata: VolumeMetadata): void {
    this.streamingManager = manager;

    // Set static metadata info
    const dims = metadata.dimensions;
    this.statsParams.dimensions = `${dims[0]} × ${dims[1]} × ${dims[2]}`;

    // Calculate raw file size in MB based on bit depth
    const totalVoxels = dims[0] * dims[1] * dims[2];
    const bytesPerVoxel = metadata.bitDepth === 16 ? 2 : 1;
    const fileSizeMB = (totalVoxels * bytesPerVoxel) / (1024 * 1024);
    this.statsParams.fileSize = `${fileSizeMB.toFixed(1)} MB (raw ${metadata.bitDepth}-bit)`;

    const spacing = metadata.voxelSpacing ?? [1, 1, 1];
    this.statsParams.spacing = `${spacing[0].toFixed(2)} × ${spacing[1].toFixed(2)} × ${spacing[2].toFixed(2)}`;

    this.statsParams.lodLevels = `${metadata.levels.length} (LOD 0-${metadata.maxLod})`;

    const format = this.renderer.canvas.format;
    this.statsParams.textureFormat = format + (format === 'r8unorm' && metadata.bitDepth === 16 ? ' (⚠️ downsampled)' : '');

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

      const atlasPercent = ((stats.atlasUsage / stats.atlasCapacity) * 100).toFixed(0);
      this.statsParams.atlasUsage = `${stats.atlasUsage}/${stats.atlasCapacity} (${atlasPercent}%)`;
      this.statsParams.loadedBricks = `${stats.loadedCount} / ${stats.desiredCount}`;
      this.statsParams.pendingBricks = `${stats.pendingCount}`;
      this.statsParams.evictedBricks = `${stats.evictedCount}`;
      this.statsParams.culledBricks = `${stats.culledCount}`;
      this.statsParams.emptyBricks = `${stats.emptyCount}`;

      // Network stats
      const throughputMBps = stats.bytesPerSecond / (1024 * 1024);
      this.statsParams.throughput = `${throughputMBps.toFixed(2)} MB/s`;

      const totalMB = stats.totalBytesDownloaded / (1024 * 1024);
      this.statsParams.totalDownloaded = `${totalMB.toFixed(2)} MB`;

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

    canvas.addEventListener('mousemove', (e) => {
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
      if (this.dragPointIndex === 0) {
        point.y = Math.max(0, Math.min(1, 1 - canvasY / canvas.height));
      } else if (this.dragPointIndex === points.length - 1) {
        point.y = Math.max(0, Math.min(1, 1 - canvasY / canvas.height));
      } else {
        point.x = Math.max(0.01, Math.min(0.99, canvasX / canvas.width));
        point.y = Math.max(0, Math.min(1, 1 - canvasY / canvas.height));
      }

      this.transferFunction.setOpacityPoints(points);
      this.updateTFPreview();
    });

    const stopDrag = () => {
      this.isDraggingPoint = false;
      this.dragPointIndex = -1;
    };

    canvas.addEventListener('mouseup', stopDrag);
    canvas.addEventListener('mouseleave', stopDrag);
  }

  private updateTFPreview(): void {
    this.transferFunction.renderPreview(this.tfCanvas);
    this.renderer.resetAccumulation();
  }

  /** Sync UI params from current renderer/camera state (e.g. after applying URL params) */
  syncFromState(): void {
    this.params.renderMode = this.renderer.volumeRenderMode;
    this.params.isoValue = this.renderer.isoValue;
    this.params.windowCenter = this.renderer.windowCenter;
    this.params.windowWidth = this.renderer.windowWidth;
    this.params.renderScale = this.renderer.renderScale;
    this.params.upAxis = this.camera.getUpAxis();
    this.params.tfPreset = this.transferFunction.preset;
    this.params.clipMinX = this.renderer.clipMin[0]!;
    this.params.clipMinY = this.renderer.clipMin[1]!;
    this.params.clipMinZ = this.renderer.clipMin[2]!;
    this.params.clipMaxX = this.renderer.clipMax[0]!;
    this.params.clipMaxY = this.renderer.clipMax[1]!;
    this.params.clipMaxZ = this.renderer.clipMax[2]!;
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

    // ISO section only visible in ISO mode
    if (this.isoFolder) {
      this.isoFolder.hidden = mode !== 'iso';
    }

    // TF section visible in DVR and MIP modes
    if (this.tfFolder) {
      this.tfFolder.hidden = mode === 'iso';
    }

    // Window/Level section visible in all modes except LOD debug
    if (this.windowFolder) {
      this.windowFolder.hidden = mode === 'lod';
    }
  }
}
