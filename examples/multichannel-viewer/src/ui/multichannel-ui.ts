/**
 * Multi-channel viewer UI controls using Tweakpane
 */

import { Pane } from 'tweakpane';
import type { Renderer } from '@kiln/core/renderer.js';
import type { Camera, UpAxis } from '@kiln/core/camera.js';
import type { StreamingManager } from '@kiln/streaming/streaming-manager.js';
import type { VolumeMetadata } from '@kiln/data/data-provider.js';
import type { KilnViewer } from 'kiln-render';

interface TweakpaneFolder {
  hidden: boolean;
  element: HTMLElement;
  addBinding: (obj: object, key: string, params?: object) => { on: (event: string, cb: (ev: { value: unknown }) => void) => void };
}

interface ExtendedPane extends Pane {
  addBinding: (obj: object, key: string, params?: object) => { on: (event: string, cb: (ev: { value: unknown }) => void) => void };
  addFolder: (params: { title: string; expanded?: boolean }) => TweakpaneFolder;
  refresh: () => void;
}

// Default channel colors matching renderer defaults (0-255 for Tweakpane)
const CHANNEL_COLOR_DEFAULTS = [
  { r:   0, g:   0, b: 255 },  // ch0: blue
  { r: 255, g: 255, b:   0 },  // ch1: yellow
  { r: 255, g:   0, b:   0 },  // ch2: red
  { r: 255, g: 255, b: 255 },  // ch3: white
];

export interface ChannelState {
  r: number;      // 0-255
  g: number;      // 0-255
  b: number;      // 0-255
  a: number;      // 0-1
  visible: boolean;
  min: number;    // 0-1 normalized
  max: number;    // 0-1 normalized
}

export class MultichannelUI {
  private viewer: KilnViewer;
  private renderer: Renderer;
  private camera: Camera;
  private streamingManager: StreamingManager | null = null;

  private pane: Pane;
  private statsPane: Pane;

  private params = {
    upAxis: '-y' as UpAxis,
    renderScale: 0.5,
    showWireframe: false,
    showAxis: false,
  };

  // Per-channel params — populated dynamically in constructor
  private channelParams: Array<{
    color: { r: number; g: number; b: number; a: number };
    visible: boolean;
    min: number;
    max: number;
  }> = [];

  private statsParams = {
    fps: '',
    frameTime: '',
    timeToFirstRender: '',
    dimensions: '',
    fileSize: '',
    spacing: '',
    lodLevels: '',
    textureFormat: '',
    atlasUsage: '',
    pendingBricks: '',
    evictedBricks: '',
    throughput: '',
    totalDownloaded: '',
  };

  private frameTimes: number[] = [];
  private lastFrameTime = 0;

  constructor(viewer: KilnViewer, initialChannels?: ChannelState[]) {
    this.viewer = viewer;
    this.renderer = viewer.renderer;
    this.camera = viewer.camera;

    // Sync initial values
    this.params.upAxis = this.camera.getUpAxis();
    this.params.showWireframe = this.renderer.showWireframe;
    this.params.showAxis = this.renderer.showAxis;
    this.params.renderScale = this.renderer.renderScale;

    // Build per-channel params from renderer state (or URL-restored state)
    for (let i = 0; i < this.renderer.numChannels; i++) {
      const restored = initialChannels?.[i];
      if (restored) {
        this.channelParams.push({ color: { r: restored.r, g: restored.g, b: restored.b, a: restored.a }, visible: restored.visible, min: restored.min, max: restored.max });
        this.renderer.setChannelColor(i, restored.r / 255, restored.g / 255, restored.b / 255, restored.visible ? restored.a : 0);
        this.renderer.setChannelWindow(i, (restored.min + restored.max) / 2, Math.max(0.001, restored.max - restored.min));
      } else {
        const defaults = CHANNEL_COLOR_DEFAULTS[i] ?? { r: 255, g: 255, b: 255 };
        const base = i * 4;
        let min = 0, max = 1;
        const w = viewer.metadata.channelWindows?.[i];
        if (w && w.max > w.min) {
          const range = w.max - w.min;
          min = Math.max(0, Math.min(1, (w.start - w.min) / range));
          max = Math.max(0, Math.min(1, (w.end - w.min) / range));
        }
        this.channelParams.push({
          color: {
            r: Math.round((this.renderer.channelColors[base]     ?? defaults.r / 255) * 255),
            g: Math.round((this.renderer.channelColors[base + 1] ?? defaults.g / 255) * 255),
            b: Math.round((this.renderer.channelColors[base + 2] ?? defaults.b / 255) * 255),
            a: this.renderer.channelColors[base + 3] ?? 1.0,
          },
          visible: true,
          min,
          max,
        });
        this.renderer.setChannelWindow(i, (min + max) / 2, Math.max(0.001, max - min));
      }
    }

    this.injectColorSwatchCSS();

    // Controls pane — top-left, below toolbar button
    const controlsContainer = document.createElement('div');
    controlsContainer.style.cssText = 'position: fixed; left: 8px; top: 50px; z-index: 1000;';
    document.body.appendChild(controlsContainer);

    this.pane = new Pane({
      title: 'Controls',
      container: controlsContainer,
      expanded: false,
    });

    this.setupIconCollapse(this.pane,
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/></svg>',
      'Controls',
    );

    // Stats pane — bottom-left
    const statsContainer = document.createElement('div');
    statsContainer.style.cssText = 'position: fixed; left: 8px; bottom: calc(8px + env(safe-area-inset-bottom, 0px)); z-index: 1000;';
    document.body.appendChild(statsContainer);

    this.statsPane = new Pane({
      title: 'Stats',
      container: statsContainer,
      expanded: false,
    });

    this.setupIconCollapse(this.statsPane,
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1 11a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1zm5-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1zm5-5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1z"/></svg>',
      'Stats',
    );

    this.setupControls();
    this.setupStatsPane();
    this.initStreaming(viewer.streamingManager, viewer.metadata);
  }

  private setupControls(): void {
    const pane = this.pane as unknown as ExtendedPane;

    pane.addBinding(this.params, 'upAxis', {
      label: 'Up Axis',
      options: { 'X': 'x', 'Y': 'y', 'Z': 'z', '-X': '-x', '-Y': '-y', '-Z': '-z' },
    }).on('change', (ev: { value: unknown }) => {
      this.camera.setUpAxis(ev.value as UpAxis);
    });

    pane.addBinding(this.params, 'renderScale', {
      label: 'Render Scale',
      min: 0.25,
      max: 1.0,
      step: 0.25,
    }).on('change', (ev: { value: unknown }) => {
      this.viewer.renderScale = ev.value as number;
    });

    // Per-channel folders
    for (let ch = 0; ch < this.renderer.numChannels; ch++) {
      const chParam = this.channelParams[ch]!;
      const folder = pane.addFolder({ title: `Channel ${ch}`, expanded: ch === 0 });

      folder.addBinding(chParam, 'visible', {
        label: 'Visible',
      }).on('change', (ev: { value: unknown }) => {
        const visible = ev.value as boolean;
        const c = this.channelParams[ch]!.color;
        this.renderer.setChannelColor(ch, c.r / 255, c.g / 255, c.b / 255, visible ? c.a : 0);
      });

      folder.addBinding(chParam, 'color', {
        label: 'Color',
        color: { type: 'int' },  // RGBA auto-detected from `a`; alpha is always 0-1
      }).on('change', (ev: { value: unknown }) => {
        const c = ev.value as { r: number; g: number; b: number; a: number };
        const alpha = this.channelParams[ch]!.visible ? c.a : 0;
        this.renderer.setChannelColor(ch, c.r / 255, c.g / 255, c.b / 255, alpha);
      });

      folder.addBinding(chParam, 'min', {
        label: 'Min',
        min: 0, max: 1, step: 0.01,
      }).on('change', (ev: { value: unknown }) => {
        const min = ev.value as number;
        const max = this.channelParams[ch]!.max;
        this.renderer.setChannelWindow(ch, (min + max) / 2, Math.max(0.001, max - min));
      });

      folder.addBinding(chParam, 'max', {
        label: 'Max',
        min: 0, max: 1, step: 0.01,
      }).on('change', (ev: { value: unknown }) => {
        const min = this.channelParams[ch]!.min;
        const max = ev.value as number;
        this.renderer.setChannelWindow(ch, (min + max) / 2, Math.max(0.001, max - min));
      });
    }

    // Debug folder
    const debugFolder = pane.addFolder({ title: 'Debug', expanded: false });

    debugFolder.addBinding(this.params, 'showWireframe', {
      label: 'Wireframe',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.showWireframe = ev.value as boolean;
    });

    debugFolder.addBinding(this.params, 'showAxis', {
      label: 'Axes',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.showAxis = ev.value as boolean;
    });
  }

  private setupStatsPane(): void {
    const statsPane = this.statsPane as unknown as ExtendedPane;

    const perfFolder = statsPane.addFolder({ title: 'Performance' });
    perfFolder.addBinding(this.statsParams, 'fps', { label: 'FPS', readonly: true });
    perfFolder.addBinding(this.statsParams, 'frameTime', { label: 'Frame', readonly: true });
    perfFolder.addBinding(this.statsParams, 'timeToFirstRender', { label: 'First Render', readonly: true });

    const dataFolder = statsPane.addFolder({ title: 'Dataset' });
    dataFolder.addBinding(this.statsParams, 'dimensions', { label: 'Size', readonly: true });
    dataFolder.addBinding(this.statsParams, 'fileSize', { label: 'File Size', readonly: true });
    dataFolder.addBinding(this.statsParams, 'spacing', { label: 'Spacing', readonly: true });
    dataFolder.addBinding(this.statsParams, 'lodLevels', { label: 'LODs', readonly: true });
    dataFolder.addBinding(this.statsParams, 'textureFormat', { label: 'Format', readonly: true });

    const streamFolder = statsPane.addFolder({ title: 'Streaming', expanded: false });
    streamFolder.addBinding(this.statsParams, 'atlasUsage', { label: 'Atlas', readonly: true });
    streamFolder.addBinding(this.statsParams, 'pendingBricks', { label: 'Pending', readonly: true });
    streamFolder.addBinding(this.statsParams, 'evictedBricks', { label: 'Evicted', readonly: true });

    const netFolder = statsPane.addFolder({ title: 'Network', expanded: false });
    netFolder.addBinding(this.statsParams, 'throughput', { label: 'Throughput', readonly: true });
    netFolder.addBinding(this.statsParams, 'totalDownloaded', { label: 'Downloaded', readonly: true });
  }

  private initStreaming(manager: StreamingManager, metadata: VolumeMetadata): void {
    this.streamingManager = manager;

    const dims = metadata.dimensions;
    const chSuffix = metadata.numChannels > 1 ? ` × ${metadata.numChannels}ch` : '';
    this.statsParams.dimensions = `${dims[0]} × ${dims[1]} × ${dims[2]}${chSuffix}`;

    const totalVoxels = dims[0] * dims[1] * dims[2];
    const bytesPerVoxel = metadata.bitDepth === 16 ? 2 : 1;
    const fileSizeMB = (totalVoxels * bytesPerVoxel) / (1024 * 1024);
    this.statsParams.fileSize = `${fileSizeMB.toFixed(1)} MB (raw ${metadata.bitDepth}-bit)`;

    const spacing = metadata.voxelSpacing ?? [1, 1, 1];
    this.statsParams.spacing = `${spacing[0].toFixed(2)} × ${spacing[1].toFixed(2)} × ${spacing[2].toFixed(2)}`;

    this.statsParams.lodLevels = `${metadata.levels.length} (LOD 0-${metadata.maxLod})`;

    const format = this.renderer.canvas.format;
    this.statsParams.textureFormat = format + (format === 'r8unorm' && metadata.bitDepth === 16 ? ' (⚠️ downsampled)' : '');

    this.startStatsUpdate();
  }

  private statsUpdateInterval: number | null = null;

  private startStatsUpdate(): void {
    if (this.statsUpdateInterval !== null) return;
    this.statsUpdateInterval = window.setInterval(() => this.updateStats(), 250);
  }

  private updateStats(): void {
    if (this.frameTimes.length > 0) {
      const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      this.statsParams.fps = `${(1000 / avgFrameTime).toFixed(1)}`;
      this.statsParams.frameTime = `${avgFrameTime.toFixed(2)} ms`;
    }

    if (this.streamingManager) {
      const stats = this.streamingManager.getStats();

      const atlasPercent = ((stats.atlasUsage / stats.atlasCapacity) * 100).toFixed(0);
      this.statsParams.atlasUsage = `${stats.atlasUsage}/${stats.atlasCapacity} (${atlasPercent}%)`;
      this.statsParams.pendingBricks = `${stats.pendingCount}`;
      this.statsParams.evictedBricks = `${stats.evictedCount}`;

      const throughputMBps = stats.bytesPerSecond / (1024 * 1024);
      this.statsParams.throughput = `${throughputMBps.toFixed(2)} MB/s`;

      const totalMB = stats.totalBytesDownloaded / (1024 * 1024);
      this.statsParams.totalDownloaded = `${totalMB.toFixed(2)} MB`;

      if (stats.timeToFirstRender !== null) {
        this.statsParams.timeToFirstRender = `${stats.timeToFirstRender.toFixed(0)} ms`;
      } else {
        this.statsParams.timeToFirstRender = 'Loading...';
      }

      const spinner = document.getElementById('spinner');
      if (spinner) {
        spinner.classList.toggle('active', stats.pendingCount > 0);
      }
    }

    (this.statsPane as unknown as ExtendedPane).refresh();
  }

  getChannelState(): ChannelState[] {
    return this.channelParams.map(ch => ({
      r: ch.color.r,
      g: ch.color.g,
      b: ch.color.b,
      a: ch.color.a,
      visible: ch.visible,
      min: ch.min,
      max: ch.max,
    }));
  }

  recordFrame(): void {
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      this.frameTimes.push(now - this.lastFrameTime);
      if (this.frameTimes.length > 60) this.frameTimes.shift();
    }
    this.lastFrameTime = now;
  }

  // Hide the hex/rgba text next to the color swatch — the swatch is self-explanatory
  private injectColorSwatchCSS(): void {
    if (document.getElementById('kiln-colswatch-style')) return;
    const style = document.createElement('style');
    style.id = 'kiln-colswatch-style';
    style.textContent = '.tp-colv_t { display: none !important; }';
    document.head.appendChild(style);
  }

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

    applyCollapsed();

    btn.addEventListener('click', () => {
      requestAnimationFrame(() => {
        if (el.classList.contains('tp-rotv-expanded')) {
          applyExpanded();
        } else {
          applyCollapsed();
        }
      });
    });
  }
}
