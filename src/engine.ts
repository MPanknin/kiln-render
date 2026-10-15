/**
 * KilnEngine — headless volume engine. Owns the renderer, streaming and GPU
 * resources on a caller-supplied device, and renders into any colour view for
 * any camera. No canvas, no input handling, no frame loop: KilnViewer adds
 * those for standalone use; other hosts drive it from their own scene and camera.
 */

import { mat4 } from 'wgpu-matrix';
import type { LoadMilestones } from './core/milestones.js';
import type { PyramidLevel, PyramidPolicy } from './core/pyramid.js';
import { Renderer, VolumeRenderMode } from './core/renderer.js';
import { VolumeResources } from './core/volume-resources.js';
import { TransferFunction, TFPreset } from './core/transfer-function.js';
import { StreamingManager } from './streaming/streaming-manager.js';
import { DatasetConfig, computeAtlasGrid, emptyBrickThresholdFor, normalizeWindow } from './core/config.js';
import { detectBest16BitFormat } from './core/volume.js';
import type { ViewParams } from './core/view.js';
import type { DataProvider, SourceSelection, VolumeMetadata } from './data/data-provider.js';
import { UnsupportedDatasetError } from './data/data-provider.js';
import { MAX_LOD_LEVELS } from './shaders/uniform-layout.js';
import { ShardedDataProvider, isShardedUrl } from './data/sharded-provider.js';
import { ZarrDataProvider } from './data/zarr-provider.js';
import type { TargetFormat } from './data/brick-convert.js';
import { initializeWithPyramidFallback } from './data/pyramid-fallback.js';
import { UINT16_FLOAT16_OFFSET } from './utils/float16.js';

export interface EngineOptions {
  /** Zero-based OME-Zarr source channels, in display order (one to four). */
  sourceChannels?: readonly number[];
  /** Zero-based OME-Zarr timepoint. Both can be switched later with setSourceSelection(). */
  timepoint?: number;
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
  /**
   * Level model: 'native' per-axis factors from metadata, or 'legacy' uniform 2:1 virtual pyramid.
   * Unset: native, falling back to legacy when the stored levels don't fit the native model
   * (e.g. a coarse level a few voxels short of half its parent). Setting it disables the fallback.
   */
  pyramid?: PyramidPolicy;
  /** Initial per-channel visibility (multichannel): hidden channels start with alpha 0 and are
   *  not streamed until shown. Overrides OMERO `active`. */
  visibleChannels?: boolean[];
}

/** How long after the last view change the camera still counts as interacting (ms). */
const INTERACTION_HOLD_MS = 200;

/** Bitmask of channels the renderer currently displays (alpha weight > 0); all bits for single-channel data. */
function visibleChannelMask(renderer: Renderer): number {
  if (renderer.numChannels <= 1) return 0xf;
  let mask = 0;
  for (let ch = 0; ch < renderer.numChannels; ch++) {
    if (renderer.channelColors[ch * 4 + 3]! > 0) mask |= 1 << ch;
  }
  return mask;
}

/** Push every metadata channel window to the renderer in shader space. */
function applyChannelWindows(renderer: Renderer, metadata: VolumeMetadata): void {
  metadata.channelWindows?.forEach((cw, ch) => {
    const w = cw && normalizeWindow(cw, metadata.isFloat ?? false, metadata.dataRange);
    if (w) renderer.setChannelWindow(ch, (w.min + w.max) / 2, Math.max(0.01, w.max - w.min));
  });
}

/** Metadata display defaults for the slots in `mask`: 16-bit window, OMERO colour and visibility. */
function applyChannelDefaults(renderer: Renderer, metadata: VolumeMetadata, mask: number, bitDepth: number): void {
  if (bitDepth === 16 && (mask & 1)) {
    const w = metadata.window && normalizeWindow(metadata.window, metadata.isFloat ?? false, metadata.dataRange);
    renderer.windowCenter = w ? (w.min + w.max) / 2 : 0.5;
    renderer.windowWidth = w ? Math.max(0.01, w.max - w.min) : 1.0;
  }
  if (metadata.numChannels <= 1) return;
  metadata.channelWindows?.forEach((cw, ch) => {
    const w = (mask >> ch) & 1 && cw && normalizeWindow(cw, metadata.isFloat ?? false, metadata.dataRange);
    if (w) renderer.setChannelWindow(ch, (w.min + w.max) / 2, Math.max(0.01, w.max - w.min));
  });
  metadata.channels?.slice(0, 4).forEach((ch, i) => {
    if (!((mask >> i) & 1)) return;
    const base = i * 4;
    const [r, g, b] = ch.color ?? [renderer.channelColors[base]!, renderer.channelColors[base + 1]!, renderer.channelColors[base + 2]!];
    renderer.setChannelColor(i, r, g, b, ch.active ? 1 : 0);
  });
}

/** Empty-brick threshold for the current selection's windows. */
function emptyThresholdFor(metadata: VolumeMetadata): number {
  return emptyBrickThresholdFor(
    metadata.bitDepth, metadata.channelWindows ?? (metadata.window ? [metadata.window] : undefined), metadata.isFloat,
  );
}

type SetupMilestones = Pick<LoadMilestones, 'datasetOpenStart' | 'deviceReady' | 'metadataReady' | 'gpuReady'>;

/** Level model for DatasetConfig: the provider's validated pyramid in native mode, legacy 2:1 otherwise. */
function levelModel(policy: PyramidPolicy, metadata: VolumeMetadata): PyramidLevel[] | undefined {
  return policy === 'native' ? metadata.pyramid : undefined;
}

/** What the atlas and renderer are built from, besides the channel count. */
interface GpuSetup {
  outputFormat: GPUTextureFormat;
  textureFormat: GPUTextureFormat;
  bitDepth: 8 | 16;
  atlasBudgetBytes?: number;
}

export class KilnEngine {
  readonly device: GPUDevice;
  readonly transferFunction: TransferFunction;
  readonly dataProvider: DataProvider;
  /** Shared with the provider and streaming manager; setSourceSelection() updates it in place. */
  readonly metadata: VolumeMetadata;
  readonly config: DatasetConfig;

  // Replaced by setSourceSelection() when the channel count changes: read them per use, don't cache.
  private _renderer: Renderer;
  private _resources: VolumeResources;
  private _streamingManager: StreamingManager;
  get renderer(): Renderer { return this._renderer; }
  get resources(): VolumeResources { return this._resources; }
  get streamingManager(): StreamingManager { return this._streamingManager; }

  /** Callback invoked when float/channel ranges are derived during base LOD loading. */
  onChannelWindowsChanged?: () => void;

  /** Render scale used while the camera is moving. 0 disables the drop. */
  interactionRenderScale = 0.25;

  /** User-intended render scale; update() may temporarily override it during interaction. */
  private userRenderScale: number;
  private dirty = true;
  private disposed = false;
  private width = 0;
  private height = 0;

  private readonly vpScratch = new Float32Array(16);
  private readonly lastVP = new Float32Array(16);
  private hasLastVP = false;
  private lastMoveTime = 0;

  private readonly gpu: GpuSetup;
  private readonly setupMilestones: SetupMilestones;
  private firstContentSubmit: number | null = null;
  private firstContentFrame: number | null = null;

  private constructor(
    device: GPUDevice,
    renderer: Renderer,
    resources: VolumeResources,
    transferFunction: TransferFunction,
    dataProvider: DataProvider,
    metadata: VolumeMetadata,
    config: DatasetConfig,
    gpu: GpuSetup,
    setupMilestones: SetupMilestones,
  ) {
    this.setupMilestones = setupMilestones;
    this.device = device;
    this._renderer = renderer;
    this._resources = resources;
    this.transferFunction = transferFunction;
    this.dataProvider = dataProvider;
    this.metadata = metadata;
    this.config = config;
    this.gpu = gpu;
    this.userRenderScale = renderer.renderScale;
    this._streamingManager = this.attachStreaming(renderer, resources);
  }

  /**
   * Request a device with the limits Kiln needs (large buffers, large 3D textures), and
   * texture-formats-tier1 where available so uint16 data is stored lossless as r16unorm.
   */
  static async createDevice(): Promise<GPUDevice> {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('WebGPU not supported');

    const adapterLimits = adapter.limits;
    return adapter.requestDevice({
      requiredFeatures: adapter.features.has('texture-formats-tier1') ? ['texture-formats-tier1'] : [],
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

    // Data provider
    let dataProvider: DataProvider;
    const isExternalProvider = typeof dataset !== 'string';

    if (isExternalProvider) {
      dataProvider = dataset as DataProvider;
    } else {
      const url = dataset as string;
      dataProvider = (await isShardedUrl(url))
        ? new ShardedDataProvider(url)
        : new ZarrDataProvider(url);
    }

    if (options.sourceChannels !== undefined || options.timepoint !== undefined) {
      if (!dataProvider.setSourceSelection) {
        throw new Error('This data provider does not support channel/timepoint selection');
      }
      dataProvider.setSourceSelection({ sourceChannels: options.sourceChannels, timepoint: options.timepoint });
    }

    // The level model must reach the provider before workers and brick loads exist.
    // Native unless requested otherwise, falling back to legacy if native rejects the levels.
    const { metadata, pyramid } = await initializeWithPyramidFallback(dataProvider, options.pyramid);
    milestones.metadataReady = performance.now();
    if ((metadata.pyramidPolicy ?? 'legacy') !== pyramid) {
      throw new Error(`Data provider uses pyramid "${metadata.pyramidPolicy ?? 'legacy'}" but the engine requested "${pyramid}"`);
    }
    if (metadata.levels.length > MAX_LOD_LEVELS) {
      throw new UnsupportedDatasetError([`${metadata.levels.length} pyramid levels exceed the supported ${MAX_LOD_LEVELS}`]);
    }
    const sourceBitDepth = metadata.bitDepth;

    let textureFormat: GPUTextureFormat;
    let effectiveBitDepth = sourceBitDepth;

    if (sourceBitDepth === 16) {
      textureFormat = detectBest16BitFormat(device, metadata.isFloat ?? false);
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
      if (dataProvider instanceof ZarrDataProvider) {
        await dataProvider.setTargetFormat(textureFormat as TargetFormat);
      } else {
        (dataProvider as ShardedDataProvider).setTargetFormat(textureFormat as TargetFormat);
      }
    } else if ('setTargetFormat' in dataProvider) {
      (dataProvider as { setTargetFormat: (f: string) => void }).setTargetFormat(textureFormat);
    }

    // Build DatasetConfig
    const config = new DatasetConfig(metadata.dimensions, metadata.voxelSpacing, emptyThresholdFor(metadata), levelModel(pyramid, metadata));

    const gpu: GpuSetup = { outputFormat: format, textureFormat, bitDepth: effectiveBitDepth, atlasBudgetBytes: options.atlasBudgetBytes };
    const { resources, renderer } = KilnEngine.buildGpu(device, metadata, config, gpu);
    milestones.gpuReady = performance.now();

    // Metadata display defaults for every slot: 16-bit window, OMERO colours and visibility
    applyChannelDefaults(renderer, metadata, 0xf, effectiveBitDepth);

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

    // Hidden channels must be known before streaming starts (the base load skips them)
    if (options.visibleChannels && metadata.numChannels > 1) {
      options.visibleChannels.forEach((visible, ch) => {
        if (ch >= metadata.numChannels) return;
        const c = renderer.channelColors;
        renderer.setChannelColor(ch, c[ch * 4]!, c[ch * 4 + 1]!, c[ch * 4 + 2]!, visible ? 1 : 0);
      });
    }

    const engine = new KilnEngine(
      device, renderer, resources, transferFunction, dataProvider, metadata, config, gpu, milestones,
    );

    if (options.maxPixelError !== undefined) {
      engine.streamingManager.maxPixelError = options.maxPixelError;
    }

    device.lost.then(() => engine.dispose());

    return engine;
  }

  /** Atlas sized to the budget for this channel count, plus the renderer that samples it. */
  private static buildGpu(device: GPUDevice, metadata: VolumeMetadata, config: DatasetConfig, gpu: GpuSetup) {
    // Shrink the atlas grid with channel count so total atlas VRAM fits the
    // budget — a fixed 660³ × 4 channels (~2.3 GB) OOMs mobile GPUs at startup.
    const bytesPerVoxel = gpu.textureFormat === 'r8unorm' ? 1 : 2;
    const { gridSize, atlasSize } = computeAtlasGrid(metadata.numChannels, bytesPerVoxel, gpu.atlasBudgetBytes);
    const atlasVramMB = Math.round((metadata.numChannels * atlasSize ** 3 * bytesPerVoxel) / 1e6);
    console.log(`[Kiln] atlas grid ${gridSize}³ (${atlasSize}³ voxels) × ${metadata.numChannels} channel(s) ≈ ${atlasVramMB} MB VRAM`);

    const resources = new VolumeResources(device, gpu.bitDepth, gpu.textureFormat, config, metadata.numChannels, gridSize);
    const renderer = new Renderer(device, gpu.outputFormat, resources, config);
    // uint16 on r16float is stored as value - offset; map texels back to value / 65535
    if (gpu.textureFormat === 'r16float' && !metadata.isFloat) {
      renderer.texelScale = 65535;
      renderer.texelBias = -UINT16_FLOAT16_OFFSET;
    }
    return { resources, renderer };
  }

  /** Start streaming into `resources`; derived ranges flow back into the renderer. */
  private attachStreaming(renderer: Renderer, resources: VolumeResources): StreamingManager {
    renderer.onDirty = () => { this.dirty = true; };
    const streamingManager = new StreamingManager(
      resources,
      this.dataProvider,
      this.metadata,
      this.device,
      this.config,
      () => renderer.resetAccumulation(),
      visibleChannelMask(renderer),
    );
    // When base LOD derives float/channel ranges, update renderer + metadata.
    streamingManager.setRangesDerivedCallback((opts) => {
      if (opts.dataRange) {
        renderer.floatMin = opts.dataRange[0];
        renderer.floatMax = opts.dataRange[1];
        renderer.resetAccumulation();
      }
      if (opts.channelRanges && this.metadata.channelWindows) {
        applyChannelWindows(renderer, this.metadata);
      }
      this.onChannelWindowsChanged?.();
    });
    return streamingManager;
  }

  /**
   * Switch source channels and/or timepoint without reopening the dataset: metadata,
   * workers, camera and display settings stay; bricks re-stream (unchanged channels and
   * revisited timepoints come from the CPU brick cache). Slots whose channel changed take
   * that channel's metadata defaults; a time-only change keeps every display setting.
   * A different channel count rebuilds the atlas and renderer on the same device.
   */
  setSourceSelection(selection: SourceSelection): void {
    if (this.disposed) return;
    if (!this.dataProvider.setSourceSelection) {
      throw new Error('This data provider does not support channel/timepoint selection');
    }
    const before = [...(this.metadata.sourceChannels ?? [])];
    const beforeTimepoint = this.metadata.timepoint ?? 0;
    this.dataProvider.setSourceSelection(selection); // validates first; throws without changing anything

    const { sourceChannels = [], timepoint = 0, numChannels } = this.metadata;
    let changedChannels = 0;
    sourceChannels.forEach((c, slot) => { if (c !== before[slot]) changedChannels |= 1 << slot; });
    const stale = timepoint !== beforeTimepoint ? (1 << numChannels) - 1 : changedChannels;
    if (!stale) return;

    this.config.emptyBrickThreshold = emptyThresholdFor(this.metadata);
    if (numChannels !== this._renderer.numChannels) {
      this.rebuildGpu(changedChannels);
    } else {
      applyChannelDefaults(this._renderer, this.metadata, changedChannels, this.gpu.bitDepth);
      if (this.metadata.isFloat && this.metadata.dataRange) {
        this._renderer.floatMin = this.metadata.dataRange[0];
        this._renderer.floatMax = this.metadata.dataRange[1];
      }
      this._streamingManager.setVisibleChannels(visibleChannelMask(this._renderer));
      this._streamingManager.reload(stale);
    }
    this._renderer.resetAccumulation();
    this.dirty = true;
  }

  /** New atlas + renderer for the current channel count; display state carries over, streaming restarts. */
  private rebuildGpu(changedChannels: number): void {
    const old = this._renderer;
    const { maxPixelError } = this._streamingManager;
    this._streamingManager.dispose();
    old.dispose();
    this._resources.dispose();

    const { resources, renderer } = KilnEngine.buildGpu(this.device, this.metadata, this.config, this.gpu);
    this._resources = resources;
    this._renderer = renderer;

    // Per-slot display state: kept where the channel stayed, metadata defaults where it changed.
    renderer.channelColors.set(old.channelColors);
    for (let ch = 0; ch < 4; ch++) renderer.setChannelWindow(ch, old.channelWindowCenter[ch]!, old.channelWindowWidth[ch]!);
    renderer.windowCenter = old.windowCenter;
    renderer.windowWidth = old.windowWidth;
    applyChannelDefaults(renderer, this.metadata, changedChannels, this.gpu.bitDepth);

    renderer.volumeRenderMode = old.volumeRenderMode;
    renderer.useIndirection = old.useIndirection;
    renderer.enableJitter = old.enableJitter;
    renderer.enableTAA = old.enableTAA;
    renderer.densityScale = old.densityScale;
    renderer.isoValue = old.isoValue;
    renderer.floatMin = this.metadata.dataRange?.[0] ?? old.floatMin;
    renderer.floatMax = this.metadata.dataRange?.[1] ?? old.floatMax;
    renderer.clipMin.set(old.clipMin);
    renderer.clipMax.set(old.clipMax);
    renderer.sliceX = old.sliceX;
    renderer.sliceY = old.sliceY;
    renderer.sliceZ = old.sliceZ;
    renderer.showSliceX = old.showSliceX;
    renderer.showSliceY = old.showSliceY;
    renderer.showSliceZ = old.showSliceZ;
    renderer.showWireframe = old.showWireframe;
    renderer.showAxis = old.showAxis;
    renderer.setTransferFunction(this.transferFunction);
    renderer.renderScale = this.userRenderScale;
    if (this.width > 0) this.setSize(this.width, this.height);

    this._streamingManager = this.attachStreaming(renderer, resources);
    this._streamingManager.maxPixelError = maxPixelError;
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
    this.width = width;
    this.height = height;
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
    if (this.renderer.numChannels > 1) this.streamingManager.setVisibleChannels(visibleChannelMask(this.renderer));
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
