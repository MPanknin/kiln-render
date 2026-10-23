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
import { isFlagDisabled } from './core/feature-flags.js';
import { LabelGpu } from './labels/label-gpu.js';
import { DEFAULT_LABEL_BUDGET_BYTES, LabelManager } from './labels/label-manager.js';
import type { LabelPick } from './labels/label-manager.js';
import type { LabelLayerOptions } from './labels/label-layer.js';

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
  /** DVR gradient shading strength (0–1, default 0; 0 = flat) */
  shading?: number;
  /** DVR boundary emphasis: opacity follows gradient magnitude (0–1, default 0 = off) */
  gradientOpacity?: number;
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
  /**
   * Label layers to show, in drawing priority: names from the dataset's OME-Zarr `labels` group
   * or URLs of OME-Zarr label images, optionally with a style. They open after the engine is
   * created (see `engine.labels`); ones that can't be shown are skipped with a warning.
   */
  labels?: ReadonlyArray<string | (LabelLayerOptions & { source: string })>;
  /** Upper bound of the label pool's GPU memory in bytes (default 512 MiB; it grows only as needed). */
  labelBudgetBytes?: number;
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

/** One output of the engine: its renderer (render mode, accumulation) and camera tracking. */
class EngineView {
  readonly lastVP = new Float32Array(16);
  hasLastVP = false;
  lastMoveTime = 0;
  dirty = true;
  width = 0;
  height = 0;
  /** Transfer function version this view last accumulated with (views other than 0). */
  tfVersion = 0;
  constructor(public renderer: Renderer) {}
}

/** What the atlas and renderer are built from, besides the channel count. */
interface GpuSetup {
  outputFormat: GPUTextureFormat;
  textureFormat: GPUTextureFormat;
  bitDepth: 8 | 16;
  atlasBudgetBytes?: number;
  /** Ray-guided brick selection; on by default, `?rayguide=0` turns it off */
  rayGuided: boolean;
  /** Label pool and entries, shared by every renderer and kept across atlas rebuilds */
  labels: LabelGpu;
}

export class KilnEngine {
  readonly device: GPUDevice;
  readonly transferFunction: TransferFunction;
  readonly dataProvider: DataProvider;
  /** Shared with the provider and streaming manager; setSourceSelection() updates it in place. */
  readonly metadata: VolumeMetadata;
  readonly config: DatasetConfig;

  // Replaced by setSourceSelection() when the channel count changes: read them per use, don't cache.
  private readonly views: EngineView[];
  private _resources: VolumeResources;
  private _streamingManager: StreamingManager;
  /** View 0's renderer; its display settings (all but the render mode) are shared by every view. */
  get renderer(): Renderer { return this.views[0]!.renderer; }
  get resources(): VolumeResources { return this._resources; }
  get streamingManager(): StreamingManager { return this._streamingManager; }

  /** Label layers (segmentations) over the volume: add, style, pick. */
  readonly labels: LabelManager;

  /** Callback invoked when float/channel ranges are derived during base LOD loading. */
  onChannelWindowsChanged?: () => void;

  /** Render scale used while the camera is moving. 0 disables the drop. */
  interactionRenderScale = 0.25;

  /** User-intended render scale; update() may temporarily override it during interaction. */
  private userRenderScale: number;
  private disposed = false;

  private readonly vpScratch = new Float32Array(16);

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
    this.views = [new EngineView(renderer)];
    this._resources = resources;
    this.transferFunction = transferFunction;
    this.dataProvider = dataProvider;
    this.metadata = metadata;
    this.config = config;
    this.gpu = gpu;
    this.userRenderScale = renderer.renderScale;
    this.labels = new LabelManager(gpu.labels, {
      provider: dataProvider,
      metadata,
      config,
      resources: () => this._resources,
      streaming: () => this._streamingManager,
      redraw: () => { for (const view of this.views) view.renderer.resetAccumulation(); },
    });
    this._streamingManager = this.attachStreaming(resources);
    this.labels.attach(resources);
  }

  /**
   * Request a device with the limits Kiln needs (large buffers, large 3D textures), and
   * texture-formats-tier1 where available. Atlas setup separately validates filtering
   * before selecting lossless r16unorm storage.
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
    // Label discovery is a metadata read or two; it overlaps the GPU setup below
    const labelNames = dataProvider.listLabels?.().catch(() => []) ?? Promise.resolve([]);
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
      textureFormat = await detectBest16BitFormat(device, metadata.isFloat ?? false);
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

    const gpu: GpuSetup = {
      outputFormat: format, textureFormat, bitDepth: effectiveBitDepth, atlasBudgetBytes: options.atlasBudgetBytes,
      rayGuided: !isFlagDisabled('rayguide'),
      labels: new LabelGpu(device, options.labelBudgetBytes ?? DEFAULT_LABEL_BUDGET_BYTES),
    };
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
    if (options.shading !== undefined) {
      renderer.shading = options.shading;
      renderer.resetAccumulation();
    }
    if (options.gradientOpacity !== undefined) {
      renderer.gradientOpacity = options.gradientOpacity;
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

    engine.labels.available = await labelNames;
    if (options.labels?.length) void engine.labels.addAll(options.labels);

    device.lost.then(() => engine.dispose());

    return engine;
  }

  /** Every base brick is pinned, so the coarsest level must fit the atlas for `numChannels`,
   *  plus one working slot when finer levels exist; otherwise loading leaves permanent holes. */
  private static assertBaseFits(metadata: VolumeMetadata, numChannels: number, gpu: GpuSetup): void {
    const bytesPerVoxel = gpu.textureFormat === 'r8unorm' ? 1 : 2;
    const slots = computeAtlasGrid(numChannels, bytesPerVoxel, gpu.atlasBudgetBytes).gridSize ** 3;
    const base = metadata.levels.find(level => level.lod === metadata.maxLod);
    const baseBricks = base ? base.brickGrid[0] * base.brickGrid[1] * base.brickGrid[2] : 0;
    const workingSlots = metadata.maxLod > 0 ? 1 : 0;
    if (baseBricks + workingSlots > slots) {
      throw new UnsupportedDatasetError([
        `The coarsest level needs ${baseBricks} pinned bricks, but the atlas has ${slots} slots` +
        (numChannels > 1 ? ` at ${numChannels} channels` : '') +
        (workingSlots ? ' and needs a free slot for refinement' : '') +
        '. Add a coarser pyramid level or increase atlas capacity.',
      ]);
    }
  }

  /** Atlas sized to the budget for this channel count, plus the renderer that samples it. */
  private static buildGpu(device: GPUDevice, metadata: VolumeMetadata, config: DatasetConfig, gpu: GpuSetup) {
    // Shrink the atlas grid with channel count so total atlas VRAM fits the
    // budget — a fixed 660³ × 4 channels (~2.3 GB) OOMs mobile GPUs at startup.
    KilnEngine.assertBaseFits(metadata, metadata.numChannels, gpu);
    const bytesPerVoxel = gpu.textureFormat === 'r8unorm' ? 1 : 2;
    const { gridSize, atlasSize } = computeAtlasGrid(metadata.numChannels, bytesPerVoxel, gpu.atlasBudgetBytes);
    const atlasVramMB = Math.round((metadata.numChannels * atlasSize ** 3 * bytesPerVoxel) / 1e6);
    console.log(`[Kiln] atlas grid ${gridSize}³ (${atlasSize}³ voxels) × ${metadata.numChannels} channel(s) ≈ ${atlasVramMB} MB VRAM`);

    const resources = new VolumeResources(device, gpu.bitDepth, gpu.textureFormat, config, metadata.numChannels, gridSize);
    const renderer = KilnEngine.buildRenderer(device, metadata, config, gpu, resources);
    return { resources, renderer };
  }

  /** A renderer that samples `resources`. */
  private static buildRenderer(
    device: GPUDevice, metadata: VolumeMetadata, config: DatasetConfig, gpu: GpuSetup, resources: VolumeResources,
  ): Renderer {
    const renderer = new Renderer(device, gpu.outputFormat, resources, config, gpu.labels, gpu.rayGuided);
    // uint16 on r16float is stored as value - offset; map texels back to value / 65535
    if (gpu.textureFormat === 'r16float' && !metadata.isFloat) {
      renderer.texelScale = 65535;
      renderer.texelBias = -UINT16_FLOAT16_OFFSET;
    }
    return renderer;
  }

  /** Renderer for a view other than 0: same atlas and transfer function, view 0's look. */
  private buildViewRenderer(mode: VolumeRenderMode): Renderer {
    const renderer = KilnEngine.buildRenderer(this.device, this.metadata, this.config, this.gpu, this._resources);
    renderer.setTransferFunction(this.transferFunction);
    renderer.syncLook(this.renderer);
    renderer.volumeRenderMode = mode;
    renderer.renderScale = this.userRenderScale;
    return renderer;
  }

  /** Redraw requests and ray visibility of a view's renderer. */
  private wireView(view: EngineView): void {
    view.renderer.onDirty = () => { view.dirty = true; };
    if (view.renderer.rayGuided) {
      view.renderer.onRayVisibility = (bits, frames) =>
        this._streamingManager.reportRayVisibility(bits, frames, this.views.indexOf(view));
    }
  }

  /** Start streaming into `resources` for every view; derived ranges flow back into view 0's renderer. */
  private attachStreaming(resources: VolumeResources): StreamingManager {
    for (const view of this.views) this.wireView(view);
    const streamingManager = new StreamingManager(
      resources,
      this.dataProvider,
      this.metadata,
      this.device,
      this.config,
      () => { for (const view of this.views) view.renderer.resetAccumulation(); },
      visibleChannelMask(this.renderer),
    );
    if (this.gpu.rayGuided) streamingManager.enableRayGuidance();
    // When base LOD derives float/channel ranges, update renderer + metadata.
    streamingManager.setRangesDerivedCallback((opts) => {
      const renderer = this.renderer;
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
    // A different channel count resizes the atlas: reject it before anything changes.
    const nextCount = selection.sourceChannels?.length ?? Math.min(4, this.metadata.sourceChannelCount ?? this.metadata.numChannels);
    // Fewer channels never shrink the atlas, so only a growing selection can stop fitting.
    if (nextCount > this.renderer.numChannels && nextCount <= 4) {
      KilnEngine.assertBaseFits(this.metadata, nextCount, this.gpu);
    }
    this.dataProvider.setSourceSelection(selection); // validates first; throws without changing anything

    const { sourceChannels = [], timepoint = 0, numChannels } = this.metadata;
    let changedChannels = 0;
    sourceChannels.forEach((c, slot) => { if (c !== before[slot]) changedChannels |= 1 << slot; });
    const stale = timepoint !== beforeTimepoint ? (1 << numChannels) - 1 : changedChannels;
    if (!stale && numChannels === this.renderer.numChannels) return;

    this.config.emptyBrickThreshold = emptyThresholdFor(this.metadata);
    this.labels.setTimepoint(timepoint);
    if (numChannels !== this.renderer.numChannels) {
      this.rebuildGpu(changedChannels);
    } else {
      applyChannelDefaults(this.renderer, this.metadata, changedChannels, this.gpu.bitDepth);
      if (this.metadata.isFloat && this.metadata.dataRange) {
        this.renderer.floatMin = this.metadata.dataRange[0];
        this.renderer.floatMax = this.metadata.dataRange[1];
      }
      this._streamingManager.setVisibleChannels(visibleChannelMask(this.renderer));
      this._streamingManager.reload(stale);
    }
    this.renderer.resetAccumulation();
    this.markDirty();
  }

  /** New atlas + renderers for the current channel count; display state carries over, streaming restarts. */
  private rebuildGpu(changedChannels: number): void {
    KilnEngine.assertBaseFits(this.metadata, this.metadata.numChannels, this.gpu); // before tearing anything down
    const old = this.renderer;
    const { maxPixelError } = this._streamingManager;
    this._streamingManager.dispose();
    for (const view of this.views) view.renderer.dispose();
    this._resources.dispose();

    const { resources, renderer } = KilnEngine.buildGpu(this.device, this.metadata, this.config, this.gpu);
    this._resources = resources;
    this.views[0]!.renderer = renderer;

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
    renderer.shading = old.shading;
    renderer.gradientOpacity = old.gradientOpacity;
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
    for (const view of this.views.slice(1)) view.renderer = this.buildViewRenderer(view.renderer.volumeRenderMode);
    this.views.forEach((view, i) => { if (view.width > 0) this.setSize(view.width, view.height, i); });

    this._streamingManager = this.attachStreaming(resources);
    this._streamingManager.maxPixelError = maxPixelError;
    this.labels.attach(resources);
  }

  /** User-intended render scale (the interaction override is not reflected here). */
  get renderScale(): number { return this.userRenderScale; }
  set renderScale(value: number) {
    this.userRenderScale = value;
    // build the scale set now (off the gesture path) and re-render
    for (const view of this.views) view.renderer.prepareScale(value);
    this.markDirty();
  }

  /** Number of views: 1, plus one per addView(). */
  get viewCount(): number { return this.views.length; }

  /** Renderer of view `view`. Set its `volumeRenderMode` per view; other display settings follow view 0. */
  getRenderer(view = 0): Renderer {
    const v = this.views[view];
    if (!v) throw new RangeError(`No view ${view}`);
    return v.renderer;
  }

  /**
   * Add a view of the same data, e.g. one pane of a multi-view layout. It streams from the
   * same atlas and has its own camera (the ViewParams passed for it), render mode and
   * accumulation; every other display setting follows view 0. Returns its index for
   * setSize(), updateViews() and render(); call setSize() before rendering it.
   */
  addView(): number {
    const view = new EngineView(this.buildViewRenderer(this.renderer.volumeRenderMode));
    view.tfVersion = this.transferFunction.version;
    this.views.push(view);
    this.wireView(view);
    return this.views.length - 1;
  }

  /** Remove a view added with addView(); later views move down one index. */
  removeView(view: number): void {
    if (view < 1 || view >= this.views.length) throw new RangeError(`No removable view ${view}`);
    this.views.splice(view, 1)[0]!.renderer.dispose();
    this._streamingManager.removeView(view);
  }

  /** Output size of view `view` in device pixels. Call whenever its colour view changes size. */
  setSize(width: number, height: number, view = 0): void {
    const v = this.views[view];
    if (!v) throw new RangeError(`No view ${view}`);
    v.width = width;
    v.height = height;
    v.renderer.resize(width, height);
    if (this.interactionRenderScale > 0) v.renderer.prepareScale(this.interactionRenderScale);
    v.renderer.prepareScale(this.userRenderScale);
    v.dirty = true;
  }

  /** Signal that the scene needs a re-render (without resetting accumulation). */
  markDirty(): void {
    for (const view of this.views) view.dirty = true;
  }

  /**
   * Advance streaming and render-scale state for this frame's view.
   * Returns true when the caller should call render(): something changed or
   * temporal accumulation has not converged yet.
   */
  update(view: ViewParams): boolean {
    return this.updateViews([view])[0]!;
  }

  /**
   * update() for several views: `views[i]` is the camera of view i. Streams what any of
   * them needs and returns, per view, whether to call render() for it.
   */
  updateViews(views: readonly ViewParams[]): boolean[] {
    if (this.disposed) return views.map(() => false);
    if (views.length > this.views.length) throw new RangeError(`${views.length} cameras for ${this.views.length} views`);

    const now = performance.now();
    const resolved = views.map((view, i) => this.trackView(this.views[i]!, view, now));

    // Views other than 0 follow its display settings and the shared transfer function
    const primary = this.renderer;
    for (const view of this.views.slice(1)) {
      const tfChanged = view.tfVersion !== this.transferFunction.version;
      if (view.renderer.syncLook(primary) || tfChanged) {
        view.tfVersion = this.transferFunction.version;
        view.renderer.resetAccumulation();
      }
    }

    // Always run streaming (may trigger onDirty via resetAccumulation)
    if (primary.numChannels > 1) this.streamingManager.setVisibleChannels(visibleChannelMask(primary));
    resolved.forEach((_, i) => this.streamingManager.setRayGuidanceActive(this.views[i]!.renderer.marchesRays, i));
    this.streamingManager.update(resolved);
    this.labels.update();

    return resolved.map((view, i) => {
      const v = this.views[i]!;
      const needsRender = v.dirty || view.interacting === true || !v.renderer.isConverged;
      if (needsRender) v.dirty = false;
      return needsRender;
    });
  }

  /** Camera tracking of one view: whether it is interacting, and the render scale for that. */
  private trackView(v: EngineView, view: ViewParams, now: number): ViewParams {
    mat4.multiply(view.proj, view.view, this.vpScratch);
    let vpChanged = !v.hasLastVP;
    if (v.hasLastVP) {
      for (let i = 0; i < 16; i++) {
        if (Math.abs(this.vpScratch[i]! - v.lastVP[i]!) > 1e-6) { vpChanged = true; break; }
      }
    }
    v.lastVP.set(this.vpScratch);
    v.hasLastVP = true;

    if (vpChanged) {
      v.lastMoveTime = now;
      v.dirty = true;
    }
    const interacting = view.interacting ?? (now - v.lastMoveTime < INTERACTION_HOLD_MS);

    // Drop to the interaction scale while the camera moves; restore afterwards
    const targetScale = interacting && this.interactionRenderScale > 0
      ? this.interactionRenderScale
      : this.userRenderScale;
    if (v.renderer.renderScale !== targetScale) {
      v.renderer.activateScale(targetScale);
      v.dirty = true;
    }
    return view.interacting === interacting ? view : { ...view, interacting };
  }

  /** Render view `index` (default 0) for camera `view` into `colorView` (format = options.outputFormat). */
  render(colorView: GPUTextureView, view: ViewParams, index = 0): void {
    if (this.disposed) return;
    this.getRenderer(index).render(colorView, view);
    if (this.firstContentSubmit === null && this.streamingManager.milestones.firstAtlasCommit !== null) {
      this.firstContentSubmit = performance.now();
    }
  }

  /**
   * Label segments under pixel (x, y) of view `view`, in output pixels: the front-most drawn
   * label along the ray in volume modes, the slice plane under the pixel in slice mode. Resolves
   * with the hit voxel and one hit per shown layer with a segment there (top layer first), or null
   * when no layer is shown or a newer pick replaced this one.
   */
  async pickLabels(x: number, y: number, view = 0): Promise<LabelPick | null> {
    const v = this.views[view];
    if (!v) throw new RangeError(`No view ${view}`);
    if (this.disposed || this.labels.shown.length === 0) return null;
    v.dirty = true; // volume modes pick during the next render
    const record = await v.renderer.pick(x, y);
    return record && !this.disposed ? this.labels.resolvePick(record) : null;
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
    this.labels.dispose();
    this.streamingManager.dispose();
    for (const view of this.views) view.renderer.dispose();
    this.transferFunction.dispose();
    this.resources.dispose();
    this.dataProvider.dispose();
  }
}
