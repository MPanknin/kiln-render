/**
 * KilnViewer — self-contained WebGPU volume viewer. Owns the canvas, device,
 * arcball camera, render loop and resize; delegates rendering and streaming to
 * KilnEngine. App layer handles UI.
 */

import { KilnEngine, EngineOptions } from './engine.js';
import type { Renderer, VolumeRenderMode } from './core/renderer.js';
import { Camera, Projection, UpAxis } from './core/camera.js';
import type { TransferFunction, TFPreset } from './core/transfer-function.js';
import type { StreamingManager } from './streaming/streaming-manager.js';
import type { DataProvider, SourceSelection, VolumeMetadata } from './data/data-provider.js';
import type { LoadMilestones } from './core/milestones.js';

export interface ViewerOptions extends EngineOptions {
  /** Camera up axis */
  upAxis?: UpAxis;
  /** Camera orbit state [rx, ry, dist] or [rx, ry, dist, tx, ty, tz] */
  cam?: [number, number, number] | [number, number, number, number, number, number];
  /** Camera projection; default perspective */
  projection?: Projection;
}

/** Serialisable snapshot of viewer state — used by the share-URL feature */
export interface ViewerState {
  sourceChannels?: number[];
  timepoint?: number;
  mode: VolumeRenderMode;
  windowCenter: number;
  windowWidth: number;
  densityScale: number;
  shading: number;
  gradientOpacity: number;
  isoValue: number;
  /** User-intended render scale (not the 0.25 interaction override) */
  renderScale: number;
  tfPreset: TFPreset;
  tfPoints: Array<{ x: number; y: number }>;
  upAxis: UpAxis;
  cam: [number, number, number, number, number, number];
  projection: Projection;
  clipMin: [number, number, number];
  clipMax: [number, number, number];
  sliceX: number;
  sliceY: number;
  sliceZ: number;
  showSliceX: boolean;
  showSliceY: boolean;
  showSliceZ: boolean;
  showWireframe: boolean;
  showAxis: boolean;
}

/** Another view of the viewer's dataset in its own canvas, e.g. one pane of a multi-view layout. */
export interface ViewerPane {
  readonly canvas: HTMLCanvasElement;
  readonly camera: Camera;
  /** This pane's render mode; every other display setting follows the main view. Throws after removal or viewer disposal. */
  mode: VolumeRenderMode;
}

/** A pane's canvas, its WebGPU context and camera; pane i is engine view i + 1. */
interface PaneState extends ViewerPane {
  context: GPUCanvasContext;
}

export class KilnViewer {
  readonly engine: KilnEngine;
  readonly camera: Camera;

  /** Optional callback invoked at the start of every render frame. */
  onBeforeFrame?: () => void;

  /** Callback invoked when float/channel ranges are derived during base LOD loading. */
  onChannelWindowsChanged?: () => void;

  private readonly context: GPUCanvasContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly format: GPUTextureFormat;
  private readonly panes: PaneState[] = [];
  private readonly resizeObserver: ResizeObserver;
  private rafHandle = 0;
  private resizeTimer = 0;
  private disposed = false;

  private constructor(
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    engine: KilnEngine,
    camera: Camera,
  ) {
    this.canvas = canvas;
    this.context = context;
    this.format = format;
    this.engine = engine;
    this.camera = camera;

    engine.onChannelWindowsChanged = () => this.onChannelWindowsChanged?.();

    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.resize(), 100) as unknown as number;
    });
    this.resizeObserver.observe(canvas);
    this.resize(); // Ensure correct dimensions before first frame

    this.rafHandle = requestAnimationFrame(() => this.frame());
  }

  /** Create a fully initialised KilnViewer from a URL or DataProvider. */
  static async create(
    canvas: HTMLCanvasElement,
    dataset: string | DataProvider,
    options: ViewerOptions = {},
  ): Promise<KilnViewer> {
    const device = await KilnEngine.createDevice();
    const deviceReadyAt = performance.now();
    const format = navigator.gpu.getPreferredCanvasFormat();
    const context = canvas.getContext('webgpu')!;
    context.configure({ device, format });

    const engine = await KilnEngine.create(device, dataset, { ...options, outputFormat: format, deviceReadyAt });

    const camera = new Camera(canvas);
    if (options.upAxis !== undefined) camera.setUpAxis(options.upAxis);
    if (options.cam !== undefined) camera.setOrbitState(options.cam);
    if (options.projection !== undefined) camera.projection = options.projection;

    const viewer = new KilnViewer(canvas, context, format, engine, camera);
    device.lost.then(() => viewer.dispose());
    return viewer;
  }

  // Engine subsystem accessors
  get renderer(): Renderer { return this.engine.renderer; }
  get transferFunction(): TransferFunction { return this.engine.transferFunction; }
  get streamingManager(): StreamingManager { return this.engine.streamingManager; }
  get device(): GPUDevice { return this.engine.device; }
  get metadata(): VolumeMetadata { return this.engine.metadata; }
  get milestones(): LoadMilestones { return this.engine.milestones; }

  // Render state convenience API
  get mode(): VolumeRenderMode { return this.renderer.volumeRenderMode; }
  set mode(value: VolumeRenderMode) {
    this.renderer.volumeRenderMode = value;
    this.renderer.resetAccumulation();
  }

  get isoValue(): number { return this.renderer.isoValue; }
  set isoValue(value: number) {
    this.renderer.isoValue = value;
    this.renderer.resetAccumulation();
  }

  get windowCenter(): number { return this.renderer.windowCenter; }
  set windowCenter(value: number) {
    this.renderer.windowCenter = value;
    this.renderer.resetAccumulation();
  }

  get windowWidth(): number { return this.renderer.windowWidth; }
  set windowWidth(value: number) {
    this.renderer.windowWidth = value;
    this.renderer.resetAccumulation();
  }

  /** Minimum raw float value that maps to 0.0 in the shader (float32 datasets only). */
  get floatMin(): number { return this.renderer.floatMin; }
  set floatMin(value: number) {
    this.renderer.floatMin = value;
    this.renderer.resetAccumulation();
  }

  /** Maximum raw float value that maps to 1.0 in the shader (float32 datasets only). */
  get floatMax(): number { return this.renderer.floatMax; }
  set floatMax(value: number) {
    this.renderer.floatMax = value;
    this.renderer.resetAccumulation();
  }

  get renderScale(): number { return this.engine.renderScale; }
  set renderScale(value: number) { this.engine.renderScale = value; }

  /** Projection of the main view and every pane; panes added later start with it. */
  get projection(): Projection { return this.camera.projection; }
  set projection(value: Projection) {
    this.camera.projection = value;
    for (const pane of this.panes) pane.camera.projection = value;
  }

  /**
   * Show another view of the dataset in `canvas`, e.g. one pane of a multi-view layout. It
   * has its own camera and render mode (starting from the main view's); every other display
   * setting follows the main view. All panes share one render loop and one stream.
   */
  addPane(canvas: HTMLCanvasElement): ViewerPane {
    if (this.disposed) throw new Error('Cannot add a pane to a disposed viewer');
    if (canvas === this.canvas || this.panes.some(p => p.canvas === canvas)) {
      throw new Error('Canvas already belongs to this viewer');
    }
    const context = canvas.getContext('webgpu')!;
    context.configure({ device: this.device, format: this.format });
    const camera = new Camera(canvas);
    camera.setUpAxis(this.camera.getUpAxis());
    camera.projection = this.camera.projection;
    const renderer = () => {
      const index = this.panes.indexOf(state);
      if (this.disposed || index < 0) throw new Error('Pane is no longer attached to the viewer');
      return this.engine.getRenderer(index + 1);
    };
    const state: PaneState = {
      canvas,
      context,
      camera,
      get mode() { return renderer().volumeRenderMode; },
      set mode(value: VolumeRenderMode) {
        renderer().volumeRenderMode = value;
        renderer().resetAccumulation();
      },
    };
    const view = this.engine.addView();
    this.panes.push(state);
    this.resizeObserver.observe(canvas);
    this.resizeCanvas(canvas, view, true);
    return state;
  }

  /** Stop rendering a pane added with addPane(); its canvas stays in the page. */
  removePane(pane: ViewerPane): void {
    if (this.disposed) return;
    const i = this.panes.indexOf(pane as PaneState);
    if (i < 0) return;
    const [state] = this.panes.splice(i, 1);
    this.engine.removeView(i + 1);
    this.resizeObserver.unobserve(state!.canvas);
    state!.context.unconfigure();
  }

  /** Switch source channels/timepoint in place (see KilnEngine.setSourceSelection); the camera stays. */
  setSourceSelection(selection: SourceSelection): void { this.engine.setSourceSelection(selection); }

  // State serialisation
  getState(): ViewerState {
    const [rx, ry, dist, tx, ty, tz] = this.camera.getOrbitState();
    return {
      sourceChannels: this.metadata.sourceChannels && [...this.metadata.sourceChannels],
      timepoint: this.metadata.timepoint,
      mode: this.renderer.volumeRenderMode,
      windowCenter: this.renderer.windowCenter,
      windowWidth: this.renderer.windowWidth,
      densityScale: this.renderer.densityScale,
      shading: this.renderer.shading,
      gradientOpacity: this.renderer.gradientOpacity,
      isoValue: this.renderer.isoValue,
      renderScale: this.engine.renderScale,
      tfPreset: this.transferFunction.preset,
      tfPoints: this.transferFunction.getOpacityPoints(),
      upAxis: this.camera.getUpAxis(),
      cam: [rx, ry, dist, tx, ty, tz],
      projection: this.camera.projection,
      clipMin: [
        this.renderer.clipMin[0]!,
        this.renderer.clipMin[1]!,
        this.renderer.clipMin[2]!,
      ],
      clipMax: [
        this.renderer.clipMax[0]!,
        this.renderer.clipMax[1]!,
        this.renderer.clipMax[2]!,
      ],
      sliceX: this.renderer.sliceX,
      sliceY: this.renderer.sliceY,
      sliceZ: this.renderer.sliceZ,
      showSliceX: this.renderer.showSliceX,
      showSliceY: this.renderer.showSliceY,
      showSliceZ: this.renderer.showSliceZ,
      showWireframe: this.renderer.showWireframe,
      showAxis: this.renderer.showAxis,
    };
  }

  /** Render the current view and encode it as an image; call once the view has converged. */
  captureImage(type = 'image/png'): Promise<Blob> {
    // Render and snapshot in the same task, before the frame is presented
    const view = this.camera.getViewParams(this.canvas.width, this.canvas.height);
    this.engine.render(this.context.getCurrentTexture().createView(), view);
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas capture failed'))), type);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafHandle);
    clearTimeout(this.resizeTimer);
    this.resizeObserver.disconnect();
    this.engine.dispose();
    this.context.unconfigure();
    for (const pane of this.panes) pane.context.unconfigure();
  }

  /** Match every canvas's drawing buffer to its CSS size now; window resizes are followed after 100 ms. */
  resize(): void {
    this.resizeCanvas(this.canvas, 0);
    this.panes.forEach((pane, i) => this.resizeCanvas(pane.canvas, i + 1));
  }

  private resizeCanvas(canvas: HTMLCanvasElement, view: number, force = false): void {
    const maxDim = this.device.limits.maxTextureDimension2D;
    const width = Math.max(1, Math.min(canvas.clientWidth, maxDim));
    const height = Math.max(1, Math.min(canvas.clientHeight, maxDim));
    if (force || canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      this.engine.setSize(width, height, view);
    }
  }

  private frame(): void {
    if (this.disposed) return;
    this.engine.noteAnimationFrame();

    const views = [
      this.camera.getViewParams(this.canvas.width, this.canvas.height),
      ...this.panes.map(pane => pane.camera.getViewParams(pane.canvas.width, pane.canvas.height)),
    ];
    const draw = this.engine.updateViews(views);
    if (draw.some(Boolean)) this.onBeforeFrame?.();
    if (draw[0]) this.engine.render(this.context.getCurrentTexture().createView(), views[0]!);
    this.panes.forEach((pane, i) => {
      if (draw[i + 1]) this.engine.render(pane.context.getCurrentTexture().createView(), views[i + 1]!, i + 1);
    });

    this.rafHandle = requestAnimationFrame(() => this.frame());
  }
}
