/**
 * KilnViewer — self-contained WebGPU volume viewer. Owns the canvas, device,
 * arcball camera, render loop and resize; delegates rendering and streaming to
 * KilnEngine. App layer handles UI.
 */

import { KilnEngine, EngineOptions } from './engine.js';
import type { Renderer, VolumeRenderMode } from './core/renderer.js';
import { Camera, UpAxis } from './core/camera.js';
import type { TransferFunction, TFPreset } from './core/transfer-function.js';
import type { StreamingManager } from './streaming/streaming-manager.js';
import type { DataProvider, VolumeMetadata } from './data/data-provider.js';

export interface ViewerOptions extends EngineOptions {
  /** Camera up axis */
  upAxis?: UpAxis;
  /** Camera orbit state [rx, ry, dist] or [rx, ry, dist, tx, ty, tz] */
  cam?: [number, number, number] | [number, number, number, number, number, number];
}

/** Serialisable snapshot of viewer state — used by the share-URL feature */
export interface ViewerState {
  mode: VolumeRenderMode;
  windowCenter: number;
  windowWidth: number;
  densityScale: number;
  isoValue: number;
  /** User-intended render scale (not the 0.25 interaction override) */
  renderScale: number;
  tfPreset: TFPreset;
  tfPoints: Array<{ x: number; y: number }>;
  upAxis: UpAxis;
  cam: [number, number, number, number, number, number];
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

export class KilnViewer {
  readonly engine: KilnEngine;
  readonly camera: Camera;

  /** Optional callback invoked at the start of every render frame. */
  onBeforeFrame?: () => void;

  /** Callback invoked when float/channel ranges are derived during base LOD loading. */
  onChannelWindowsChanged?: () => void;

  private readonly context: GPUCanvasContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver;
  private rafHandle = 0;
  private resizeTimer = 0;
  private disposed = false;

  private constructor(
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    engine: KilnEngine,
    camera: Camera,
  ) {
    this.canvas = canvas;
    this.context = context;
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
    const format = navigator.gpu.getPreferredCanvasFormat();
    const context = canvas.getContext('webgpu')!;
    context.configure({ device, format });

    const engine = await KilnEngine.create(device, dataset, { ...options, outputFormat: format });

    const camera = new Camera(canvas);
    if (options.upAxis !== undefined) camera.setUpAxis(options.upAxis);
    if (options.cam !== undefined) camera.setOrbitState(options.cam);

    const viewer = new KilnViewer(canvas, context, engine, camera);
    device.lost.then(() => viewer.dispose());
    return viewer;
  }

  // Engine subsystem accessors
  get renderer(): Renderer { return this.engine.renderer; }
  get transferFunction(): TransferFunction { return this.engine.transferFunction; }
  get streamingManager(): StreamingManager { return this.engine.streamingManager; }
  get device(): GPUDevice { return this.engine.device; }
  get metadata(): VolumeMetadata { return this.engine.metadata; }

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

  // State serialisation
  getState(): ViewerState {
    const [rx, ry, dist, tx, ty, tz] = this.camera.getOrbitState();
    return {
      mode: this.renderer.volumeRenderMode,
      windowCenter: this.renderer.windowCenter,
      windowWidth: this.renderer.windowWidth,
      densityScale: this.renderer.densityScale,
      isoValue: this.renderer.isoValue,
      renderScale: this.engine.renderScale,
      tfPreset: this.transferFunction.preset,
      tfPoints: this.transferFunction.getOpacityPoints(),
      upAxis: this.camera.getUpAxis(),
      cam: [rx, ry, dist, tx, ty, tz],
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafHandle);
    clearTimeout(this.resizeTimer);
    this.resizeObserver.disconnect();
    this.engine.dispose();
  }

  private resize(): void {
    const maxDim = this.device.limits.maxTextureDimension2D;
    const width = Math.max(1, Math.min(this.canvas.clientWidth, maxDim));
    const height = Math.max(1, Math.min(this.canvas.clientHeight, maxDim));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.engine.setSize(width, height);
    }
  }

  private frame(): void {
    if (this.disposed) return;

    const view = this.camera.getViewParams(this.canvas.width, this.canvas.height);

    if (this.engine.update(view)) {
      this.onBeforeFrame?.();
      const colorView = this.context.getCurrentTexture().createView();
      this.engine.render(colorView, view);
    }

    this.rafHandle = requestAnimationFrame(() => this.frame());
  }
}
