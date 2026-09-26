/**
 * Volume Renderer UI Controls — dependency-free (Phase 3 of the interface
 * redesign; Tweakpane removed from user-facing UI entirely).
 */

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
import { StatsPanel } from '../../../shared/stats-panel.js';
import { trackRenderMode } from '../../../shared/analytics.js';
import {
  createPanel,
  createSwapRegion,
  createCollapsible,
  createToggle,
  createSlider,
  createRangeSlider,
  createSelect,
  createSegmentedControl,
  createSliderToggleRow,
  createButtonRow,
} from '../../../shared/controls/widgets.js';
import { percentileWindow, AUTO_CONTRAST_BINS } from '../../../shared/auto-contrast.js';
import { toRawValue, formatRawValue, type ValueSpace } from '../../../shared/data-values.js';
import { mountColorbar, type Colorbar } from '../../../shared/colorbar.js';

/** Only 'dvr' | 'mip' | 'iso' | 'slice' are selectable via the Mode segmented control — 'lod'/'slice-lod' are debug visualizations, relocated to the "LOD Levels" Advanced toggle (applied on top of the base mode). */
type BaseRenderMode = 'dvr' | 'mip' | 'iso' | 'slice';

export class VolumeUI {
  private viewer: KilnViewer;
  private stats: StatsPanel;
  private colorbar: Colorbar;
  private renderer: Renderer;
  private camera: Camera;
  private transferFunction: TransferFunction;
  private metadata: VolumeMetadata | null = null;

  private tfCanvas: HTMLCanvasElement;
  private isDraggingPoint = false;
  private dragPointIndex = -1;

  private params = {
    renderMode: 'dvr' as BaseRenderMode,
    showLodLevels: false,
    isoValue: 0.2,
    tfPreset: 'grayscale' as TFPreset,
    upAxis: '-y' as UpAxis,
    useIndirection: true,
    showWireframe: false,
    showAxis: false,
    windowCenter: 0.5,
    windowWidth: 1.0,
    densityScale: 1.0,
    renderScale: 0.5,
    enableJitter: true,
    enableTAA: true,
    clipX: { min: 0.0, max: 1.0 },
    clipY: { min: 0.0, max: 1.0 },
    clipZ: { min: 0.0, max: 1.0 },
    showSliceX: true,
    sliceX: 0.5,
    showSliceY: true,
    sliceY: 0.5,
    showSliceZ: true,
    sliceZ: 0.5,
  };

  // Widget accessors, kept for syncFromState()
  private modeControl!: ReturnType<typeof createSegmentedControl>;
  private modeSwap!: ReturnType<typeof createSwapRegion>;
  private tfPresetSelect!: ReturnType<typeof createSelect>;
  private isoValueSlider!: ReturnType<typeof createSlider>;
  private windowCenterSlider!: ReturnType<typeof createSlider>;
  private windowWidthSlider!: ReturnType<typeof createSlider>;
  private densitySlider!: ReturnType<typeof createSlider>;
  private autoContrastRow!: ReturnType<typeof createButtonRow>;
  private contrastHistogram: Uint32Array | null = null;
  private sliceRows!: [ReturnType<typeof createSliderToggleRow>, ReturnType<typeof createSliderToggleRow>, ReturnType<typeof createSliderToggleRow>];
  private upAxisSelect!: ReturnType<typeof createSelect>;
  private wireframeToggle!: ReturnType<typeof createToggle>;
  private axesToggle!: ReturnType<typeof createToggle>;
  private clipSliders!: [ReturnType<typeof createRangeSlider>, ReturnType<typeof createRangeSlider>, ReturnType<typeof createRangeSlider>];
  private clipSection!: HTMLElement;
  private renderScaleSlider!: ReturnType<typeof createSlider>;
  private jitterToggle!: ReturnType<typeof createToggle>;
  private taaToggle!: ReturnType<typeof createToggle>;
  private indirectionToggle!: ReturnType<typeof createToggle>;
  private lodLevelsToggle!: ReturnType<typeof createToggle>;
  private tfPresetEl!: HTMLElement;
  private tfCanvasContainer!: HTMLElement;

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
    this.decomposeRenderMode(this.renderer.volumeRenderMode);
    this.params.upAxis = this.camera.getUpAxis();
    this.params.useIndirection = this.renderer.useIndirection;
    this.params.showWireframe = this.renderer.showWireframe;
    this.params.showAxis = this.renderer.showAxis;
    this.params.windowCenter = this.renderer.windowCenter;
    this.params.windowWidth = this.renderer.windowWidth;
    this.params.renderScale = this.renderer.renderScale;

    const controlsContainer = document.createElement('div');
    controlsContainer.style.cssText = 'position: fixed; left: 8px; top: 44px; z-index: 1000;';
    document.body.appendChild(controlsContainer);

    const statsContainer = document.createElement('div');
    statsContainer.style.cssText = 'position: fixed; right: 8px; bottom: calc(36px + env(safe-area-inset-bottom, 0px)); z-index: 1000;';
    document.body.appendChild(statsContainer);
    this.stats = new StatsPanel(statsContainer);
    this.colorbar = mountColorbar();

    this.tfCanvas = document.createElement('canvas');
    this.tfCanvas.width = 256;
    this.tfCanvas.height = 80;
    this.tfCanvas.className = 'ctl-tf-canvas';

    this.buildPanel(controlsContainer);
    this.setupTFCanvasEvents();
    this.updateTFPreview();
    this.updateVisibility();
    this.initStreaming(viewer.streamingManager, viewer.metadata);
  }

  /** Decompose a (possibly debug) renderer mode into { base mode, showLodLevels }. */
  private decomposeRenderMode(mode: VolumeRenderMode): void {
    if (mode === 'lod') {
      this.params.renderMode = 'dvr';
      this.params.showLodLevels = true;
    } else if (mode === 'slice-lod') {
      this.params.renderMode = 'slice';
      this.params.showLodLevels = true;
    } else {
      this.params.renderMode = mode;
      this.params.showLodLevels = false;
    }
  }

  /** Apply { base mode, showLodLevels } onto the renderer's actual VolumeRenderMode. */
  private applyEffectiveMode(): void {
    const base = this.params.renderMode;
    const effective: VolumeRenderMode = !this.params.showLodLevels
      ? base
      : base === 'slice' ? 'slice-lod' : 'lod';
    this.renderer.volumeRenderMode = effective;
    this.renderer.resetAccumulation();
    this.updateVisibility();
  }

  /** Switch base render mode and keep the Mode control in sync (keyboard shortcuts). */
  setBaseMode(mode: BaseRenderMode): void {
    this.params.renderMode = mode;
    this.modeControl.setValue(mode);
    this.applyEffectiveMode();
    trackRenderMode(mode);
  }

  private buildPanel(container: HTMLElement): void {
    const { el: panelEl, body } = createPanel('Controls', { defaultCollapsed: true });
    container.appendChild(panelEl);

    // --- Mode segmented control ---
    this.modeControl = createSegmentedControl({
      options: [
        { label: 'DVR', value: 'dvr' },
        { label: 'MIP', value: 'mip' },
        { label: 'ISO', value: 'iso' },
        { label: 'Slice', value: 'slice' },
      ],
      value: this.params.renderMode,
      onChange: (v) => this.setBaseMode(v as BaseRenderMode),
    });
    body.appendChild(this.modeControl.el);

    // --- Mode-options swap region (contents depend on base mode) ---
    this.modeSwap = createSwapRegion();
    body.appendChild(this.modeSwap.el);
    this.buildModeOptionsWidgets();

    // --- Scene section (mode-independent, collapsible, open by default) ---
    const { el: sceneEl, body: sceneSection } = createCollapsible('Scene', true);
    body.appendChild(sceneEl);

    this.upAxisSelect = createSelect({
      label: 'Up Axis',
      options: [
        { label: 'X', value: 'x' }, { label: 'Y', value: 'y' }, { label: 'Z', value: 'z' },
        { label: '-X', value: '-x' }, { label: '-Y', value: '-y' }, { label: '-Z', value: '-z' },
      ],
      value: this.params.upAxis,
      onChange: (v) => {
        this.camera.setUpAxis(v as UpAxis);
        this.renderer.resetAccumulation();
      },
    });
    sceneSection.appendChild(this.upAxisSelect.el);

    this.wireframeToggle = createToggle({
      label: 'Wireframe',
      value: this.params.showWireframe,
      onChange: (v) => { this.renderer.showWireframe = v; this.renderer.markDirty(); },
    });
    sceneSection.appendChild(this.wireframeToggle.el);

    this.axesToggle = createToggle({
      label: 'Axes',
      value: this.params.showAxis,
      onChange: (v) => { this.renderer.showAxis = v; this.renderer.markDirty(); },
    });
    sceneSection.appendChild(this.axesToggle.el);

    this.clipSection = document.createElement('div');
    sceneSection.appendChild(this.clipSection);
    const clipDims = this.viewer.metadata.dimensions;
    const clipX = createRangeSlider({
      label: 'Clip X', min: 0, max: clipDims[0], step: 1,
      valueMin: this.params.clipX.min, valueMax: this.params.clipX.max,
      format: (v) => v.toFixed(0),
      onChange: (min, max) => {
        this.renderer.clipMin[0] = min / clipDims[0];
        this.renderer.clipMax[0] = max / clipDims[0];
        this.renderer.resetAccumulation();
      },
    });
    const clipY = createRangeSlider({
      label: 'Clip Y', min: 0, max: clipDims[1], step: 1,
      valueMin: this.params.clipY.min, valueMax: this.params.clipY.max,
      format: (v) => v.toFixed(0),
      onChange: (min, max) => {
        this.renderer.clipMin[1] = min / clipDims[1];
        this.renderer.clipMax[1] = max / clipDims[1];
        this.renderer.resetAccumulation();
      },
    });
    const clipZ = createRangeSlider({
      label: 'Clip Z', min: 0, max: clipDims[2], step: 1,
      valueMin: this.params.clipZ.min, valueMax: this.params.clipZ.max,
      format: (v) => v.toFixed(0),
      onChange: (min, max) => {
        this.renderer.clipMin[2] = min / clipDims[2];
        this.renderer.clipMax[2] = max / clipDims[2];
        this.renderer.resetAccumulation();
      },
    });
    this.clipSliders = [clipX, clipY, clipZ];
    this.clipSection.appendChild(clipX.el);
    this.clipSection.appendChild(clipY.el);
    this.clipSection.appendChild(clipZ.el);

    // --- Advanced (collapsed by default) ---
    const { el: advancedEl, body: advancedBody } = createCollapsible('Advanced', false);
    body.appendChild(advancedEl);

    this.renderScaleSlider = createSlider({
      label: 'Render Scale', min: 0.25, max: 1.0, step: 0.25, value: this.params.renderScale,
      format: (v) => v.toFixed(2),
      onChange: (v) => { this.viewer.renderScale = v; },
    });
    advancedBody.appendChild(this.renderScaleSlider.el);

    this.lodLevelsToggle = createToggle({
      label: 'LOD Levels',
      value: this.params.showLodLevels,
      onChange: (v) => { this.params.showLodLevels = v; this.applyEffectiveMode(); },
    });
    advancedBody.appendChild(this.lodLevelsToggle.el);

    this.jitterToggle = createToggle({
      label: 'Jitter',
      value: this.params.enableJitter,
      onChange: (v) => { this.renderer.enableJitter = v; this.renderer.resetAccumulation(); },
    });
    advancedBody.appendChild(this.jitterToggle.el);

    this.taaToggle = createToggle({
      label: 'TAA',
      value: this.params.enableTAA,
      onChange: (v) => { this.renderer.enableTAA = v; this.renderer.resetAccumulation(); },
    });
    advancedBody.appendChild(this.taaToggle.el);

    this.indirectionToggle = createToggle({
      label: 'Indirection',
      value: this.params.useIndirection,
      onChange: (v) => { this.renderer.useIndirection = v; this.renderer.resetAccumulation(); },
    });
    advancedBody.appendChild(this.indirectionToggle.el);
  }

  /** Builds the persistent mode-options widgets once; updateVisibility() swaps which are shown. */
  private buildModeOptionsWidgets(): void {
    this.tfPresetSelect = createSelect({
      label: 'Preset',
      options: [
        { label: 'Cool-Warm', value: 'coolwarm' },
        { label: 'Grayscale', value: 'grayscale' },
        { label: 'Grayscale (inverted)', value: 'grayscale-inverted' },
        { label: 'Hot', value: 'hot' },
        { label: 'Cool', value: 'cool' },
        { label: 'Viridis', value: 'viridis' },
        { label: 'Plasma', value: 'plasma' },
        { label: 'Seismic', value: 'seismic' },
      ],
      value: this.params.tfPreset,
      onChange: (v) => {
        this.transferFunction.setPreset(v as TFPreset);
        this.renderer.resetAccumulation();
        this.updateTFPreview();
      },
    });

    const helpText = document.createElement('div');
    helpText.className = 'ctl-tf-help';
    helpText.textContent = 'Click to add, drag to move, dbl-click to remove';

    this.isoValueSlider = createSlider({
      label: 'ISO Value', min: 0, max: 1, step: 0.01, value: this.params.isoValue,
      format: (v) => this.formatRaw(v),
      onChange: (v) => { this.renderer.isoValue = v; this.renderer.resetAccumulation(); },
    });

    this.windowCenterSlider = createSlider({
      label: 'Center', min: 0, max: 1, step: 0.01, value: this.params.windowCenter,
      format: (v) => this.formatRaw(v),
      onChange: (v) => {
        this.renderer.windowCenter = v;
        this.renderer.resetAccumulation();
        this.updateTFPreview();
      },
    });

    this.windowWidthSlider = createSlider({
      label: 'Width', min: 0.01, max: 1, step: 0.01, value: this.params.windowWidth,
      format: (v) => formatRawValue(toRawValue(v, this.valueSpace()) - toRawValue(0, this.valueSpace()), this.valueSpace()),
      onChange: (v) => {
        this.renderer.windowWidth = v;
        this.renderer.resetAccumulation();
        this.updateTFPreview();
      },
    });

    this.autoContrastRow = createButtonRow({
      label: 'Contrast', text: 'Auto', title: 'Fit the window to the data (A)',
      onClick: () => this.autoContrast(),
    });
    this.autoContrastRow.setDisabled(true);

    this.densitySlider = createSlider({
      label: 'Density', min: 0.1, max: 10.0, step: 0.1, value: this.params.densityScale,
      format: (v) => v.toFixed(2),
      onChange: (v) => { this.renderer.densityScale = v; this.renderer.resetAccumulation(); },
    });

    const sliceDims = this.viewer.metadata.dimensions;
    const sliceX = createSliderToggleRow({
      label: 'X', min: 0, max: sliceDims[0], step: 1, value: this.params.sliceX, checked: this.params.showSliceX,
      onValueChange: (v) => { this.renderer.sliceX = v / sliceDims[0]; this.renderer.markDirty(); },
      onCheckedChange: (v) => { this.renderer.showSliceX = v; this.renderer.markDirty(); },
    });
    const sliceY = createSliderToggleRow({
      label: 'Y', min: 0, max: sliceDims[1], step: 1, value: this.params.sliceY, checked: this.params.showSliceY,
      onValueChange: (v) => { this.renderer.sliceY = v / sliceDims[1]; this.renderer.markDirty(); },
      onCheckedChange: (v) => { this.renderer.showSliceY = v; this.renderer.markDirty(); },
    });
    const sliceZ = createSliderToggleRow({
      label: 'Z', min: 0, max: sliceDims[2], step: 1, value: this.params.sliceZ, checked: this.params.showSliceZ,
      onValueChange: (v) => { this.renderer.sliceZ = v / sliceDims[2]; this.renderer.markDirty(); },
      onCheckedChange: (v) => { this.renderer.showSliceZ = v; this.renderer.markDirty(); },
    });
    this.sliceRows = [sliceX, sliceY, sliceZ];

    // Store the TF widget group for reuse across dvr/mip/slice
    this.tfPresetEl = this.tfPresetSelect.el;
    this.tfCanvasContainer = document.createElement('div');
    this.tfCanvasContainer.className = 'ctl-tf-canvas-container';
    this.tfCanvasContainer.appendChild(this.tfCanvas);
    this.tfCanvasContainer.appendChild(helpText);
  }

  private initStreaming(manager: StreamingManager, metadata: VolumeMetadata): void {
    this.metadata = metadata;
    this.stats.setDatasetInfo(metadata, this.renderer.canvas.format, { includeCodec: true });

    // Set up histogram computation when base LOD is loaded
    manager.setBaseLodLoadedCallback((brickData) => {
      this.onBaseLodLoaded(brickData);
    });

    this.stats.bindStreaming(manager, () => this.viewer.milestones);
  }

  /**
   * Record a frame time for performance tracking
   * Call this once per frame from the render loop
   */
  recordFrame(): void {
    this.stats.recordFrame();
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
    this.updateColorbar();
    this.renderer.resetAccumulation();
  }

  private valueSpace(): ValueSpace {
    const m = this.viewer.metadata;
    return { isFloat: m.isFloat ?? false, bitDepth: m.bitDepth, floatMin: this.renderer.floatMin, floatMax: this.renderer.floatMax };
  }

  /** Normalized (shader) value → raw data value text. */
  private formatRaw(n: number): string {
    const space = this.valueSpace();
    return formatRawValue(toRawValue(n, space), space);
  }

  private updateColorbar(): void {
    const { windowCenter: c, windowWidth: w } = this.renderer;
    this.colorbar.update((t) => this.transferFunction.getColor(t), this.formatRaw(c - w / 2), this.formatRaw(c + w / 2));
  }

  /** Re-render raw-value labels, e.g. after the float data range is derived. */
  refreshValueLabels(): void {
    this.isoValueSlider.setValue(this.renderer.isoValue);
    this.windowCenterSlider.setValue(this.renderer.windowCenter);
    this.windowWidthSlider.setValue(this.renderer.windowWidth);
    this.updateColorbar();
  }

  refreshTFPreview(): void {
    this.updateTFPreview();
  }

  /** Called when base LOD is loaded - computes and displays histogram */
  private onBaseLodLoaded(brickData: (Uint8Array | Uint16Array)[]): void {
    if (!this.metadata) return;

    const histogramOf = (bins: number) => computeHistogram(
      brickData,
      this.metadata!.bitDepth,
      bins,
      this.metadata!.isFloat ?? false,
      this.metadata!.dataRange?.[0] ?? 0,
      this.metadata!.dataRange?.[1] ?? 1,
      this.renderer.canvas.format,
    );
    this.transferFunction.setHistogram(histogramOf(256));
    this.contrastHistogram = histogramOf(AUTO_CONTRAST_BINS);
    this.autoContrastRow.setDisabled(false);
    this.updateTFPreview();
  }

  /** Fit window center/width to the base-LOD value distribution. */
  autoContrast(): void {
    const w = this.contrastHistogram && percentileWindow(this.contrastHistogram);
    if (!w) return;
    this.renderer.windowCenter = w.center;
    this.renderer.windowWidth = w.width;
    this.windowCenterSlider.setValue(w.center);
    this.windowWidthSlider.setValue(w.width);
    this.updateTFPreview();
  }

  /** Sync UI params from current renderer/camera state (e.g. after applying URL params) */
  syncFromState(): void {
    this.decomposeRenderMode(this.renderer.volumeRenderMode);
    this.params.isoValue = this.renderer.isoValue;
    this.params.windowCenter = this.renderer.windowCenter;
    this.params.windowWidth = this.renderer.windowWidth;
    this.params.densityScale = this.renderer.densityScale;
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

    this.modeControl.setValue(this.params.renderMode);
    this.lodLevelsToggle.setValue(this.params.showLodLevels);
    this.isoValueSlider.setValue(this.params.isoValue);
    this.windowCenterSlider.setValue(this.params.windowCenter);
    this.windowWidthSlider.setValue(this.params.windowWidth);
    this.densitySlider.setValue(this.params.densityScale);
    this.renderScaleSlider.setValue(this.params.renderScale);
    this.upAxisSelect.setValue(this.params.upAxis);
    this.tfPresetSelect.setValue(this.params.tfPreset);
    this.clipSliders[0].setValue(this.params.clipX.min, this.params.clipX.max);
    this.clipSliders[1].setValue(this.params.clipY.min, this.params.clipY.max);
    this.clipSliders[2].setValue(this.params.clipZ.min, this.params.clipZ.max);
    this.sliceRows[0].setValue(this.params.sliceX); this.sliceRows[0].setChecked(this.params.showSliceX);
    this.sliceRows[1].setValue(this.params.sliceY); this.sliceRows[1].setChecked(this.params.showSliceY);
    this.sliceRows[2].setValue(this.params.sliceZ); this.sliceRows[2].setChecked(this.params.showSliceZ);
    this.wireframeToggle.setValue(this.params.showWireframe);
    this.axesToggle.setValue(this.params.showAxis);

    this.updateVisibility();
    this.updateTFPreview();
  }

  private updateVisibility(): void {
    const mode = this.params.renderMode;
    const isSlice = mode === 'slice';
    // Standalone LOD-debug visualization replaces the whole image when the
    // toggle is on and we're not in slice mode (slice+toggle just tints the
    // existing slice render, see applyEffectiveMode).
    const isLodDebug = this.params.showLodLevels && !isSlice;

    // Clipping planes only relevant in volume modes
    this.clipSection.style.display = isSlice ? 'none' : '';

    // Mode-options region: TF (preset+canvas) shown for dvr/mip/slice (hidden
    // for iso, matching the shader's per-mode TF sampling); Window/Level
    // shown everywhere except the standalone LOD debug view; Density is
    // DVR-only (the only shader that reads densityScale); ISO gets its
    // threshold slider instead of TF. Slice mode samples the same TF and
    // window, so its plane rows go below them (as in the multichannel viewer).
    const children: HTMLElement[] = [];
    if (mode !== 'iso') {
      children.push(this.tfPresetEl, this.tfCanvasContainer);
    }
    if (mode === 'iso') {
      children.push(this.isoValueSlider.el);
    }
    if (!isLodDebug) {
      children.push(this.windowCenterSlider.el, this.windowWidthSlider.el, this.autoContrastRow.el);
    }
    if (mode === 'dvr') {
      children.push(this.densitySlider.el);
    }
    if (isSlice) {
      children.push(this.sliceRows[0].el, this.sliceRows[1].el, this.sliceRows[2].el);
    }
    this.modeSwap.setContent(children);
    this.colorbar.setVisible(mode !== 'iso' && !isLodDebug);
  }
}
