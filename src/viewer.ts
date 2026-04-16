/**
 * KilnViewer — self-contained WebGPU volume renderer
 *
 * Encapsulates WebGPU initialisation, data provider selection, subsystem
 * construction, the render loop, and resize handling.  The application layer
 * (main.ts) is responsible for URL parsing, the dataset dialog, the share
 * button, analytics, and the optional VolumeUI panel.
 */

import { Renderer, VolumeRenderMode } from './core/renderer.js';
import { Camera, UpAxis } from './core/camera.js';
import { TransferFunction, TFPreset } from './core/transfer-function.js';
import { StreamingManager } from './streaming/streaming-manager.js';
import { DatasetConfig } from './core/config.js';
import { detectBest16BitFormat } from './core/volume.js';
import type { DataProvider, VolumeMetadata } from './data/data-provider.js';
import { ShardedDataProvider } from './data/sharded-provider.js';
import { ZarrDataProvider } from './data/zarr-provider.js';
import { getDecompressionPool, terminateDecompressionPool } from './data/decompression-pool.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface ViewerOptions {
  /** Initial render mode */
  mode?: VolumeRenderMode;
  /** 16-bit window centre (0–1) */
  windowCenter?: number;
  /** 16-bit window width (0–1) */
  windowWidth?: number;
  /** Isosurface threshold (0–1) */
  isoValue?: number;
  /** Render resolution scale (0.25–1) */
  renderScale?: number;
  /** LOD screen-space error threshold in pixels */
  maxPixelError?: number;
  /** Axis-aligned clip minimum, normalised 0–1 */
  clipMin?: [number, number, number];
  /** Axis-aligned clip maximum, normalised 0–1 */
  clipMax?: [number, number, number];
  /** Transfer function colour preset */
  tfPreset?: TFPreset;
  /** Camera up axis */
  upAxis?: UpAxis;
  /** Camera orbit state [rx, ry, dist] or [rx, ry, dist, tx, ty, tz] */
  cam?: [number, number, number] | [number, number, number, number, number, number];
  /** performance.now() at page load, used for time-to-first-render metric */
  pageLoadStart?: number;
}

/** Serialisable snapshot of viewer state — used by the share-URL feature */
export interface ViewerState {
  mode: VolumeRenderMode;
  windowCenter: number;
  windowWidth: number;
  isoValue: number;
  /** User-intended render scale (not the 0.25 interaction override) */
  renderScale: number;
  tfPreset: TFPreset;
  upAxis: string;
  cam: [number, number, number, number, number, number];
  clipMin: [number, number, number];
  clipMax: [number, number, number];
}

// ─── KilnViewer ──────────────────────────────────────────────────────────────

export class KilnViewer {
  // Public subsystems — read-only access for advanced use (e.g. VolumeUI)
  readonly renderer: Renderer;
  readonly camera: Camera;
  readonly transferFunction: TransferFunction;
  readonly streamingManager: StreamingManager;
  readonly device: GPUDevice;
  readonly metadata: VolumeMetadata;

  /**
   * Optional callback invoked at the start of every render frame.
   * Use this to drive frame-rate tracking in the UI layer.
   *
   * @example
   * viewer.onBeforeFrame = () => ui.recordFrame();
   */
  onBeforeFrame?: () => void;

  // ── Private state ──────────────────────────────────────────────────────────

  private readonly _dataProvider: DataProvider;
  private readonly _context: GPUCanvasContext;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _resizeObserver: ResizeObserver;
  private _rafHandle = 0;
  /** User-intended render scale; the frame loop may temporarily override it to
   *  0.25 during camera interaction. */
  private _userRenderScale: number;
  private _disposed = false;

  // ── Private constructor — use KilnViewer.create() ─────────────────────────

  private constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    renderer: Renderer,
    camera: Camera,
    transferFunction: TransferFunction,
    streamingManager: StreamingManager,
    dataProvider: DataProvider,
    metadata: VolumeMetadata,
    userRenderScale: number,
  ) {
    this.device = device;
    this._canvas = canvas;
    this._context = context;
    this.renderer = renderer;
    this.camera = camera;
    this.transferFunction = transferFunction;
    this.streamingManager = streamingManager;
    this._dataProvider = dataProvider;
    this.metadata = metadata;
    this._userRenderScale = userRenderScale;

    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(canvas);
    this._resize(); // Ensure correct dimensions before first frame

    this._rafHandle = requestAnimationFrame(() => this._frame());
  }

  // ── Static factory ────────────────────────────────────────────────────────

  /**
   * Create a fully initialised KilnViewer.
   *
   * @param canvas  The canvas element to render into.
   * @param dataset URL string (HTTP sharded or OME-Zarr) **or** a pre-constructed
   *                DataProvider (e.g. LocalZarrDataProvider for File System API).
   * @param options Optional initial viewer state.
   */
  static async create(
    canvas: HTMLCanvasElement,
    dataset: string | DataProvider,
    options: ViewerOptions = {},
  ): Promise<KilnViewer> {

    // ── 1. WebGPU init ────────────────────────────────────────────────────

    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU not supported');

    const adapterLimits = adapter.limits;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxBufferSize: adapterLimits.maxBufferSize,
        maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
        maxTextureDimension3D: adapterLimits.maxTextureDimension3D,
      },
    });
    if (!device) throw new Error('WebGPU device creation failed');

    const format = navigator.gpu.getPreferredCanvasFormat();
    const context = canvas.getContext('webgpu')!;
    context.configure({ device, format });

    // ── 2. Data provider ─────────────────────────────────────────────────

    let dataProvider: DataProvider;
    const isExternalProvider = typeof dataset !== 'string';

    if (isExternalProvider) {
      dataProvider = dataset as DataProvider;
    } else {
      const isZarr = (dataset as string).includes('.zarr');
      dataProvider = isZarr
        ? new ZarrDataProvider(dataset as string)
        : new ShardedDataProvider(dataset as string);
    }

    // ── 3. Metadata + texture format detection ────────────────────────────

    const metadata = await dataProvider.initialize();
    const sourceBitDepth = metadata.bitDepth;

    let textureFormat: GPUTextureFormat;
    let effectiveBitDepth = sourceBitDepth;

    if (sourceBitDepth === 16) {
      textureFormat = detectBest16BitFormat(device);
      if (textureFormat === 'r8unorm') {
        effectiveBitDepth = 8;
        console.warn(
          '[Kiln] ⚠️  GPU does not support 16-bit textures (r16unorm/r16float).\n' +
          'Downsampling to 8-bit (quality loss).',
        );
      }
    } else {
      textureFormat = 'r8unorm';
    }

    // ── 4. Configure worker target format (string-URL providers only) ─────

    if (!isExternalProvider) {
      const isHttpZarr = (dataset as string).includes('.zarr');
      if (isHttpZarr) {
        await (dataProvider as ZarrDataProvider).setTargetFormat(
          textureFormat as 'r8unorm' | 'r16float',
        );
      } else if (textureFormat !== 'r16unorm' || sourceBitDepth !== 16) {
        getDecompressionPool().setTargetFormat(textureFormat as 'r8unorm' | 'r16float');
      }
    }

    // ── 5. Build DatasetConfig (MUST precede Renderer construction) ───────

    const config = new DatasetConfig(metadata.dimensions, metadata.voxelSpacing);

    // ── 6. Construct subsystems ───────────────────────────────────────────

    const renderer = new Renderer(device, format, effectiveBitDepth, textureFormat, config);

    // Apply 16-bit window/level defaults from metadata
    if (effectiveBitDepth === 16) {
      if (metadata.window) {
        const { start, end, min, max } = metadata.window;
        const range = max - min;
        if (range > 0) {
          renderer.windowCenter = Math.max(0, Math.min(1, ((start + end) / 2 - min) / range));
          renderer.windowWidth = Math.max(0.01, Math.min(1, (end - start) / range));
        }
      } else {
        renderer.windowCenter = 0.5;
        renderer.windowWidth = 1.0;
      }
    }

    const transferFunction = new TransferFunction(device);
    renderer.setTransferFunction(transferFunction);

    const camera = new Camera(canvas);

    // ── 7. Apply ViewerOptions overrides ──────────────────────────────────
    //    Applied after metadata defaults so URL params take precedence.

    if (options.mode !== undefined) {
      renderer.volumeRenderMode = options.mode;
      renderer.resetAccumulation();
    }
    if (options.windowCenter !== undefined) {
      renderer.windowCenter = options.windowCenter;
      renderer.resetAccumulation();
    }
    if (options.windowWidth !== undefined) {
      renderer.windowWidth = options.windowWidth;
      renderer.resetAccumulation();
    }
    if (options.isoValue !== undefined) {
      renderer.isoValue = options.isoValue;
      renderer.resetAccumulation();
    }
    if (options.renderScale !== undefined) {
      renderer.renderScale = options.renderScale;
    }
    if (options.clipMin !== undefined) {
      renderer.clipMin.set(options.clipMin);
      renderer.resetAccumulation();
    }
    if (options.clipMax !== undefined) {
      renderer.clipMax.set(options.clipMax);
      renderer.resetAccumulation();
    }
    if (options.tfPreset !== undefined) {
      transferFunction.setPreset(options.tfPreset);
      renderer.resetAccumulation();
    }
    if (options.upAxis !== undefined) {
      camera.setUpAxis(options.upAxis);
    }
    if (options.cam !== undefined) {
      camera.setOrbitState(options.cam);
    }

    // ── 8. Streaming manager ──────────────────────────────────────────────

    const streamingManager = new StreamingManager(
      renderer,
      dataProvider,
      metadata,
      device,
      config,
      options.pageLoadStart,
    );

    if (options.maxPixelError !== undefined) {
      streamingManager.maxPixelError = options.maxPixelError;
    }

    // ── 9. Construct and return viewer ────────────────────────────────────

    const userRenderScale = renderer.renderScale;

    return new KilnViewer(
      device,
      canvas,
      context,
      renderer,
      camera,
      transferFunction,
      streamingManager,
      dataProvider,
      metadata,
      userRenderScale,
    );
  }

  // ── Render state convenience API ──────────────────────────────────────────

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

  /**
   * User-intended render scale (0.25–1).
   *
   * The frame loop may temporarily override the actual `renderer.renderScale`
   * to 0.25 during camera interaction; this property always reflects the
   * user's intended value and is what gets serialised into the share URL.
   */
  get renderScale(): number { return this._userRenderScale; }
  set renderScale(value: number) {
    this._userRenderScale = value;
    // renderer.renderScale and resizeComputeTexture() are applied each frame
    // by _frame(), which handles the interaction-override logic in one place.
  }

  // ── State serialisation ───────────────────────────────────────────────────

  /** Returns a snapshot of the current viewer state for share-URL serialisation. */
  getState(): ViewerState {
    const [rx, ry, dist, tx, ty, tz] = this.camera.getOrbitState();
    return {
      mode: this.renderer.volumeRenderMode,
      windowCenter: this.renderer.windowCenter,
      windowWidth: this.renderer.windowWidth,
      isoValue: this.renderer.isoValue,
      renderScale: this._userRenderScale,
      tfPreset: this.transferFunction.preset,
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
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this._rafHandle);
    this._resizeObserver.disconnect();
    this._dataProvider.dispose();
    terminateDecompressionPool();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _resize(): void {
    const maxDim = this.device.limits.maxTextureDimension2D;
    const width = Math.max(1, Math.min(this._canvas.clientWidth, maxDim));
    const height = Math.max(1, Math.min(this._canvas.clientHeight, maxDim));
    if (this._canvas.width !== width || this._canvas.height !== height) {
      this._canvas.width = width;
      this._canvas.height = height;
      this.renderer.resize(width, height);
    }
  }

  private _frame(): void {
    if (this._disposed) return;

    this.onBeforeFrame?.();

    // Drop to 0.25 during camera interaction; restore to user scale afterward
    const targetScale = this.camera.isInteracting() ? 0.25 : this._userRenderScale;
    if (this.renderer.renderScale !== targetScale) {
      this.renderer.renderScale = targetScale;
      this.renderer.resizeComputeTexture();
    }

    this.streamingManager.update(this.camera, this._canvas);

    const view = this._context.getCurrentTexture().createView();
    this.renderer.render(view, this.camera);

    this._rafHandle = requestAnimationFrame(() => this._frame());
  }
}
