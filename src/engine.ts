/**
 * KilnEngine — headless volume engine. Owns the renderer, streaming and GPU
 * resources on a caller-supplied device, and renders into any colour view for
 * any camera. No canvas, no input handling, no frame loop: KilnViewer adds
 * those for standalone use; other hosts drive it from their own scene and camera.
 */

import { mat4 } from 'wgpu-matrix';
import type { LoadMilestones } from './core/milestones.js';
import type { PyramidPolicy } from './core/pyramid.js';
import { Renderer, VolumeRenderMode } from './core/renderer.js';
import { VolumeResources } from './core/volume-resources.js';
import { TransferFunction, TFPreset } from './core/transfer-function.js';
import { StreamingManager } from './streaming/streaming-manager.js';
import { DatasetConfig, computeAtlasGrid, emptyBrickThresholdFor } from './core/config.js';
import { detectBest16BitFormat } from './core/volume.js';
import type { ViewParams } from './core/view.js';
import type { DataProvider, VolumeMetadata } from './data/data-provider.js';
import { ShardedDataProvider } from './data/sharded-provider.js';
import { ZarrDataProvider } from './data/zarr-provider.js';

export interface EngineOptions {
  /** Initial render mode */
  mode?: VolumeRenderMode;
  /** 16-bit window centre (0–1) */
  windowCenter?: number;
  /** 16-bit window width (0–1) */
  windowWidth?: number;
  /** DVR density / opacity scale (0.1–10, default 1) */
  densityScale?: number;
  /** Isosurface threshold (0–1) */
  isoValue?: number;
  /** Render resolution scale (0.25–1) */
  renderScale?: number;
  /** LOD screen-space error threshold in pixels */
  maxPixelError?: number;
  /**
   * Atlas VRAM budget in bytes (default ~1.3 GiB). The grid shrinks to fit;
   * lower it for constrained mobile GPUs, raise it to keep 660³ for many channels.
   */
  atlasBudgetBytes?: number;
  /** Axis-aligned clip minimum, normalised 0–1 */
  clipMin?: [number, number, number];
  /** Axis-aligned clip maximum, normalised 0–1 */
  clipMax?: [number, number, number];
  /** Transfer function colour preset */
  tfPreset?: TFPreset;
  /** Transfer function opacity control points (overrides preset defaults) */
  tfPoints?: Array<{ x: number; y: number }>;
  /** performance.now() when the host obtained the GPU device (for load milestones) */
  deviceReadyAt?: number;
  /** Slice plane positions, normalised 0–1 */
  sliceX?: number;
  sliceY?: number;
  sliceZ?: number;
  /** Slice plane visibility flags (default true) */
  showSliceX?: boolean;
  showSliceY?: boolean;
  showSliceZ?: boolean;
  /** Overlay toggles */
  showWireframe?: boolean;
  showAxis?: boolean;
  /** Format of the colour view passed to render() (default: preferred canvas format) */
  outputFormat?: GPUTextureFormat;
  /** Level model: 'legacy' uniform 2:1 virtual pyramid (default) or 'native' per-axis factors. Temporary rollout switch. */
  pyramid?: PyramidPolicy;
}

/** How long after the last view change the camera still counts as interacting (ms). */
const INTERACTION_HOLD_MS = 200;

type SetupMilestones = Pick<LoadMilestones, 'datasetOpenStart' | 'deviceReady' | 'metadataReady' | 'gpuReady'>;

export class KilnEngine {
  readonly device: GPUDevice;
  readonly renderer: Renderer;
  readonly resources: VolumeResources;
  readonly transferFunction: TransferFunction;
  readonly streamingManager: StreamingManager;
  readonly dataProvider: DataProvider;
  readonly metadata: VolumeMetadata;
  readonly config: DatasetConfig;

  /** Callback invoked when float/channel ranges are derived during base LOD loading. */
  onChannelWindowsChanged?: () => void;

  /** Render scale used while the camera is moving. 0 disables the drop. */
  interactionRenderScale = 0.25;

  /** User-intended render scale; update() may temporarily override it during interaction. */
  private userRenderScale: number;
  private dirty = true;
  private disposed = false;

  private readonly vpScratch = new Float32Array(16);
  private readonly lastVP = new Float32Array(16);
  private hasLastVP = false;
  private lastMoveTime = 0;

  private readonly setupMilestones: SetupMilestones;
  private firstContentSubmit: number | null = null;
  private firstContentFrame: number | null = null;

  private constructor(
    device: GPUDevice,
    renderer: Renderer,
    resources: VolumeResources,
    transferFunction: TransferFunction,
    streamingManager: StreamingManager,
    dataProvider: DataProvider,
    metadata: VolumeMetadata,
    config: DatasetConfig,
    setupMilestones: SetupMilestones,
  ) {
    this.setupMilestones = setupMilestones;
    this.device = device;
    this.renderer = renderer;
    this.resources = resources;
    this.transferFunction = transferFunction;
    this.streamingManager = streamingManager;
    this.dataProvider = dataProvider;
    this.metadata = metadata;
    this.config = config;
    this.userRenderScale = renderer.renderScale;

    this.renderer.onDirty = () => { this.dirty = true; };
  }

  /** Request a device with the limits Kiln needs (large buffers, large 3D textures). */
  static async createDevice(): Promise<GPUDevice> {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('WebGPU not supported');

    const adapterLimits = adapter.limits;
    return adapter.requestDevice({
      requiredLimits: {
        maxBufferSize: adapterLimits.maxBufferSize,
        maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
        maxTextureDimension3D: adapterLimits.maxTextureDimension3D,
      },
    });
  }

  /** Create a fully initialised engine on `device` from a URL or DataProvider. */
  static async create(
    device: GPUDevice,
    dataset: string | DataProvider,
    options: EngineOptions = {},
  ): Promise<KilnEngine> {
    const milestones: SetupMilestones = {
      datasetOpenStart: performance.now(),
      deviceReady: options.deviceReadyAt ?? null,
      metadataReady: null,
      gpuReady: null,
    };
    const format = options.outputFormat ?? navigator.gpu.getPreferredCanvasFormat();
    const pyramid: PyramidPolicy = options.pyramid ?? 'legacy';
    if (pyramid === 'native') {
      // Providers already support it; traversal, indirection and shaders still assume 2^lod
      throw new Error('pyramid "native" is not connected to the renderer yet');
    }

    // Data provider
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

    // The level model must reach the provider before workers and brick loads exist
    dataProvider.setPyramidPolicy?.(pyramid);
    const metadata = await dataProvider.initialize();
    milestones.metadataReady = performance.now();
    if ((metadata.pyramidPolicy ?? 'legacy') !== pyramid) {
      throw new Error(`Data provider uses pyramid "${metadata.pyramidPolicy ?? 'legacy'}" but the engine requested "${pyramid}"`);
    }
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

    // Configure worker target format (string-URL providers only)
    if (!isExternalProvider) {
      const isHttpZarr = (dataset as string).includes('.zarr');
      if (isHttpZarr) {
        await (dataProvider as ZarrDataProvider).setTargetFormat(
          textureFormat as 'r8unorm' | 'r16float',
        );
      } else if (textureFormat !== 'r16unorm' || sourceBitDepth !== 16) {
        (dataProvider as ShardedDataProvider).setTargetFormat(textureFormat as 'r8unorm' | 'r16float');
      }
    } else if ('setTargetFormat' in dataProvider) {
      (dataProvider as { setTargetFormat: (f: string) => void }).setTargetFormat(textureFormat);
    }

    // Build DatasetConfig
    const emptyThreshold = emptyBrickThresholdFor(
      sourceBitDepth, metadata.channelWindows ?? (metadata.window ? [metadata.window] : undefined), metadata.isFloat,
    );
    const config = new DatasetConfig(metadata.dimensions, metadata.voxelSpacing, emptyThreshold);

    // Shrink the atlas grid with channel count so total atlas VRAM fits the
    // budget — a fixed 660³ × 4 channels (~2.3 GB) OOMs mobile GPUs at startup.
    const bytesPerVoxel = textureFormat === 'r8unorm' ? 1 : 2;
    const { gridSize, atlasSize } = computeAtlasGrid(metadata.numChannels, bytesPerVoxel, options.atlasBudgetBytes);
    const atlasVramMB = Math.round((metadata.numChannels * atlasSize ** 3 * bytesPerVoxel) / 1e6);
    console.log(`[Kiln] atlas grid ${gridSize}³ (${atlasSize}³ voxels) × ${metadata.numChannels} channel(s) ≈ ${atlasVramMB} MB VRAM`);

    // Construct subsystems
    const resources = new VolumeResources(device, effectiveBitDepth, textureFormat, config, metadata.numChannels, gridSize);
    const renderer = new Renderer(device, format, resources, config);
    milestones.gpuReady = performance.now();

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

    // Apply per-channel window/level from metadata. Float windows are
    // relative to the global dataRange (not per-channel OMERO min/max).
    if (metadata.channelWindows && metadata.numChannels > 1) {
      const useGlobalRange = (metadata.isFloat ?? false) && !!metadata.dataRange;
      for (let ch = 0; ch < metadata.channelWindows.length; ch++) {
        const w = metadata.channelWindows[ch];
        if (!w) continue;
        const lo = useGlobalRange ? metadata.dataRange![0] : w.min;
        const hi = useGlobalRange ? metadata.dataRange![1] : w.max;
        const range = hi - lo;
        if (range > 0) {
          const center = Math.max(0, Math.min(1, ((w.start + w.end) / 2 - lo) / range));
          const width = Math.max(0.01, Math.min(1, (w.end - w.start) / range));
          renderer.setChannelWindow(ch, center, width);
        }
      }
    }

    // OMERO display hints: channel colour and default visibility (alpha 0 = hidden)
    if (metadata.channels && metadata.numChannels > 1) {
      metadata.channels.slice(0, 4).forEach((ch, i) => {
        const base = i * 4;
        const [r, g, b] = ch.color ?? [renderer.channelColors[base]!, renderer.channelColors[base + 1]!, renderer.channelColors[base + 2]!];
        renderer.setChannelColor(i, r, g, b, ch.active ? 1 : 0);
      });
    }

    // Pass float32 data range to renderer for GPU normalization.
    if (metadata.isFloat && metadata.dataRange) {
      renderer.floatMin = metadata.dataRange[0];
      renderer.floatMax = metadata.dataRange[1];
    }

    const transferFunction = new TransferFunction(device);
    renderer.setTransferFunction(transferFunction);

    // Apply option overrides
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
    if (options.densityScale !== undefined) {
      renderer.densityScale = options.densityScale;
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
    if (options.tfPoints !== undefined) {
      transferFunction.setOpacityPoints(options.tfPoints);
      renderer.resetAccumulation();
    }
    if (options.sliceX !== undefined) renderer.sliceX = options.sliceX;
    if (options.sliceY !== undefined) renderer.sliceY = options.sliceY;
    if (options.sliceZ !== undefined) renderer.sliceZ = options.sliceZ;
    if (options.showSliceX !== undefined) renderer.showSliceX = options.showSliceX;
    if (options.showSliceY !== undefined) renderer.showSliceY = options.showSliceY;
    if (options.showSliceZ !== undefined) renderer.showSliceZ = options.showSliceZ;
    if (options.showWireframe !== undefined) renderer.showWireframe = options.showWireframe;
    if (options.showAxis !== undefined) renderer.showAxis = options.showAxis;

    // Streaming manager
    const streamingManager = new StreamingManager(
      resources,
      dataProvider,
      metadata,
      device,
      config,
      () => renderer.resetAccumulation(),
    );

    if (options.maxPixelError !== undefined) {
      streamingManager.maxPixelError = options.maxPixelError;
    }

    const engine = new KilnEngine(
      device, renderer, resources, transferFunction, streamingManager, dataProvider, metadata, config, milestones,
    );

    // When base LOD derives float/channel ranges, update renderer + metadata.
    streamingManager.setRangesDerivedCallback((opts) => {
      if (opts.dataRange) {
        renderer.floatMin = opts.dataRange[0];
        renderer.floatMax = opts.dataRange[1];
        renderer.resetAccumulation();
      }
      if (opts.channelRanges && metadata.channelWindows) {
        for (let ch = 0; ch < opts.channelRanges.length; ch++) {
          const w = metadata.channelWindows[ch];
          if (!w) continue;
          const range = w.max - w.min;
          if (range > 0) {
            const center = Math.max(0, Math.min(1, ((w.start + w.end) / 2 - w.min) / range));
            const width = Math.max(0.01, Math.min(1, (w.end - w.start) / range));
            renderer.setChannelWindow(ch, center, width);
          }
        }
        renderer.resetAccumulation();
      }
      engine.onChannelWindowsChanged?.();
    });

    device.lost.then(() => engine.dispose());

    return engine;
  }

  /** User-intended render scale (the interaction override is not reflected here). */
  get renderScale(): number { return this.userRenderScale; }
  set renderScale(value: number) {
    this.userRenderScale = value;
    // build the scale set now (off the gesture path) and re-render
    this.renderer.prepareScale(value);
    this.dirty = true;
  }

  /** Output size in device pixels. Call whenever the target colour view changes size. */
  setSize(width: number, height: number): void {
    this.renderer.resize(width, height);
    if (this.interactionRenderScale > 0) this.renderer.prepareScale(this.interactionRenderScale);
    this.renderer.prepareScale(this.userRenderScale);
    this.dirty = true;
  }

  /** Signal that the scene needs a re-render (without resetting accumulation). */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Advance streaming and render-scale state for this frame's view.
   * Returns true when the caller should call render(): something changed or
   * temporal accumulation has not converged yet.
   */
  update(view: ViewParams): boolean {
    if (this.disposed) return false;

    mat4.multiply(view.proj, view.view, this.vpScratch);
    let vpChanged = !this.hasLastVP;
    if (this.hasLastVP) {
      for (let i = 0; i < 16; i++) {
        if (Math.abs(this.vpScratch[i]! - this.lastVP[i]!) > 1e-6) { vpChanged = true; break; }
      }
    }
    this.lastVP.set(this.vpScratch);
    this.hasLastVP = true;

    const now = performance.now();
    if (vpChanged) {
      this.lastMoveTime = now;
      this.dirty = true;
    }
    const interacting = view.interacting ?? (now - this.lastMoveTime < INTERACTION_HOLD_MS);
    const resolved: ViewParams = view.interacting === interacting ? view : { ...view, interacting };

    // Drop to the interaction scale while the camera moves; restore afterwards
    const targetScale = interacting && this.interactionRenderScale > 0
      ? this.interactionRenderScale
      : this.userRenderScale;
    if (this.renderer.renderScale !== targetScale) {
      this.renderer.activateScale(targetScale);
      this.dirty = true;
    }

    // Always run streaming (may trigger onDirty via resetAccumulation)
    this.streamingManager.update(resolved);

    const needsRender = this.dirty || interacting || !this.renderer.isConverged;
    if (needsRender) this.dirty = false;
    return needsRender;
  }

  /** Render the volume for `view` into `colorView` (format = options.outputFormat). */
  render(colorView: GPUTextureView, view: ViewParams): void {
    if (this.disposed) return;
    this.renderer.render(colorView, view);
    if (this.firstContentSubmit === null && this.streamingManager.milestones.firstAtlasCommit !== null) {
      this.firstContentSubmit = performance.now();
    }
  }

  /** Host hook: call at the start of each animation frame to record the presentation proxy. */
  noteAnimationFrame(now = performance.now()): void {
    if (this.firstContentSubmit !== null && this.firstContentFrame === null) this.firstContentFrame = now;
  }

  /** Load milestones, all as performance.now() timestamps since navigation start. */
  get milestones(): LoadMilestones {
    return {
      ...this.setupMilestones,
      ...this.streamingManager.milestones,
      firstContentSubmit: this.firstContentSubmit,
      firstContentFrame: this.firstContentFrame,
    };
  }

  /** Stop streaming and release engine-owned GPU resources; the device stays with its owner. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.streamingManager.dispose();
    this.renderer.dispose();
    this.transferFunction.dispose();
    this.resources.dispose();
    this.dataProvider.dispose();
  }
}
