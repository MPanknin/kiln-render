/**
 * Volume Renderer UI Controls using Tweakpane
 */

import { Pane } from 'tweakpane';
import { TransferFunction, TFPreset } from '../core/transfer-function.js';
import { Renderer, VolumeRenderMode } from '../core/renderer.js';
import { Camera, UpAxis } from '../core/camera.js';
import { StreamingManager } from '../streaming/streaming-manager.js';
import type { BrickMetadata } from '../streaming/brick-loader.js';

// Tweakpane's types don't fully export FolderApi, so use a minimal interface
interface TweakpaneFolder {
  hidden: boolean;
  element: HTMLElement;
  addBinding: (obj: object, key: string, params?: object) => { on: (event: string, cb: (ev: { value: unknown }) => void) => void };
}

// Extended Pane type with methods that exist at runtime but aren't in types
interface ExtendedPane extends Pane {
  addBinding: (obj: object, key: string, params?: object) => { on: (event: string, cb: (ev: { value: unknown }) => void) => void };
  addFolder: (params: { title: string }) => TweakpaneFolder;
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

  // Tweakpane params object
  private params = {
    renderMode: 'dvr' as VolumeRenderMode,
    isoValue: 0.5,
    tfPreset: 'coolwarm' as TFPreset,
    upAxis: 'y' as UpAxis,
    useIndirection: true,
    showWireframe: true,
    showAxis: true,
  };

  // Stats display (read-only, updated periodically)
  private statsParams = {
    dimensions: '',
    spacing: '',
    lodLevels: '',
    atlasUsage: '',
    loadedBricks: '',
    pendingBricks: '',
  };

  // Folder references for visibility toggling
  private isoFolder: TweakpaneFolder | null = null;
  private tfFolder: TweakpaneFolder | null = null;

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

    this.pane = new Pane({
      title: 'Volume Controls',
    });

    // Create stats pane in lower left corner
    const statsContainer = document.createElement('div');
    statsContainer.style.cssText = 'position: fixed; left: 8px; bottom: 8px; z-index: 1000;';
    document.body.appendChild(statsContainer);

    this.statsPane = new Pane({
      title: 'Dataset Stats',
      container: statsContainer,
    });

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

    // Indirection toggle
    pane.addBinding(this.params, 'useIndirection', {
      label: 'Indirection',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.useIndirection = ev.value as boolean;
    });

    // Wireframe toggle
    pane.addBinding(this.params, 'showWireframe', {
      label: 'Wireframe',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.showWireframe = ev.value as boolean;
    });

    // Axis toggle
    pane.addBinding(this.params, 'showAxis', {
      label: 'Axis',
    }).on('change', (ev: { value: unknown }) => {
      this.renderer.showAxis = ev.value as boolean;
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
      },
    }).on('change', (ev: { value: unknown }) => {
      this.transferFunction.setPreset(ev.value as TFPreset);
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
  }

  private setupStatsPane(): void {
    const statsPane = this.statsPane as unknown as ExtendedPane;

    statsPane.addBinding(this.statsParams, 'dimensions', {
      label: 'Dimensions',
      readonly: true,
    });

    statsPane.addBinding(this.statsParams, 'spacing', {
      label: 'Spacing',
      readonly: true,
    });

    statsPane.addBinding(this.statsParams, 'lodLevels', {
      label: 'LOD Levels',
      readonly: true,
    });

    statsPane.addBinding(this.statsParams, 'atlasUsage', {
      label: 'Atlas',
      readonly: true,
    });

    statsPane.addBinding(this.statsParams, 'loadedBricks', {
      label: 'Loaded',
      readonly: true,
    });

    statsPane.addBinding(this.statsParams, 'pendingBricks', {
      label: 'Pending',
      readonly: true,
    });
  }

  /**
   * Set the streaming manager and metadata for stats display
   */
  setStreamingManager(manager: StreamingManager, metadata: BrickMetadata): void {
    this.streamingManager = manager;

    // Set static metadata info
    const dims = metadata.originalDimensions;
    this.statsParams.dimensions = `${dims[0]} × ${dims[1]} × ${dims[2]}`;

    const spacing = metadata.voxelSpacing ?? [1, 1, 1];
    this.statsParams.spacing = `${spacing[0].toFixed(2)} × ${spacing[1].toFixed(2)} × ${spacing[2].toFixed(2)}`;

    this.statsParams.lodLevels = `${metadata.levels.length} (LOD 0-${metadata.maxLod})`;

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
    if (!this.streamingManager) return;

    const stats = this.streamingManager.getStats();

    this.statsParams.atlasUsage = `${stats.atlasUsage} / ${stats.atlasCapacity}`;
    this.statsParams.loadedBricks = `${stats.loadedCount} / ${stats.desiredCount}`;
    this.statsParams.pendingBricks = `${stats.pendingCount}`;

    // Force stats pane refresh
    (this.statsPane as unknown as ExtendedPane).refresh();
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
  }
}
