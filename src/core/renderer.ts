/**
 * Volume Renderer using proxy box geometry
 */

import { mat4 } from 'wgpu-matrix';
import { isOrthographic, type ViewParams } from './view.js';
import { createBox, createAxis } from '../utils/geometry.js';
import { TransferFunction } from './transfer-function.js';
import { VolumeResources } from './volume-resources.js';
import { wireframeShader, axisShader, buildComputeShader, blitShader, accumulateShader, buildSlicePlanesShader } from '../shaders/index.js';
import { COMPUTE_UNIFORMS, SLICE_UNIFORMS, MAX_LOD_LEVELS } from '../shaders/uniform-layout.js';
import type { DatasetConfig } from './config.js';
import { RayVisibility } from '../streaming/ray-visibility.js';
import { PICK_BYTES } from '../labels/label-gpu.js';
import type { LabelGpu } from '../labels/label-gpu.js';

// Batch ray visibility while rendering continues; always flush the final frame before going idle.
const RAY_READBACK_INTERVAL = 4;

// Display settings that the views of a multi-view layout share (all but the render mode)
const LOOK_SCALARS = [
  'useIndirection', 'showWireframe', 'densityScale', 'shading', 'gradientOpacity', 'showAxis',
  'enableJitter', 'enableTAA', 'isoValue', 'windowCenter', 'windowWidth', 'floatMin', 'floatMax',
  'texelScale', 'texelBias', 'sliceX', 'sliceY', 'sliceZ', 'showSliceX', 'showSliceY', 'showSliceZ',
] as const;
const LOOK_ARRAYS = ['clipMin', 'clipMax', 'channelColors', 'channelWindowCenter', 'channelWindowWidth'] as const;

// With `softReset`, a brick commit keeps the history weighted as this many frames.
export const SOFT_RESET_FRAMES = 4;

// Volume render mode (shader-side)
export type VolumeRenderMode = 'dvr' | 'mip' | 'iso' | 'lod' | 'slice' | 'slice-lod';

/** pre-allocated compute/accumulation resources for one render scale */
interface ScaleSet {
  scale: number;
  width: number;
  height: number;
  outputTexture: GPUTexture;
  outputView: GPUTextureView;
  accumTextures: [GPUTexture, GPUTexture];
  accumViews: [GPUTextureView, GPUTextureView];
  accumBindGroups: [GPUBindGroup, GPUBindGroup];
  computeBindGroup: GPUBindGroup;
  directBlitBindGroup: GPUBindGroup;
  blitBindGroups: [GPUBindGroup, GPUBindGroup];
  accumIndex: number;
  accumFrameCount: number;
}

export class Renderer {
  private device: GPUDevice;

  /** Volume atlas textures, indirection table, and slot allocator */
  readonly resources: VolumeResources;

  // Delegate getters for backwards compatibility
  get numChannels(): number { return this.resources.numChannels; }
  get canvas() { return this.resources.canvas; }
  get canvases() { return this.resources.canvases; }

  // Debug: toggle indirection on/off
  useIndirection = true;

  // Show wireframe box
  showWireframe = false;

  // Density scale for DVR compositing (1.0 = default)
  densityScale = 1.0;

  // DVR gradient shading strength (0 = flat, 1 = full headlight shading at sharp boundaries)
  shading = 0.0;

  // DVR boundary emphasis: how far opacity follows gradient magnitude (0 = off, 1 = boundaries only)
  gradientOpacity = 0.0;

  // Show axis helper
  showAxis = false;

  // Jitter: randomize ray start position per frame to dither brick seams
  enableJitter = true;

  // TAA: accumulate jittered frames for temporal anti-aliasing
  enableTAA = true;

  // Experimental (`?softreset=1`): brick commits keep part of the accumulated history,
  // and jitter is seeded per pixel instead of per ray direction.
  softReset = false;

  // Volume render mode: dvr, mip, or iso
  volumeRenderMode: VolumeRenderMode = 'dvr';

  // ISO surface threshold (0-1)
  isoValue = 0.2;

  // Windowing/Leveling for 16-bit data (0-1 normalized range)
  // windowCenter: center of the display window (default 0.5 = middle of range)
  // windowWidth: width of the display window (default 1.0 = full range)
  windowCenter = 0.5;
  windowWidth = 1.0;

  // Float normalization range (raw atlas value → [0, 1]).
  // For uint8/uint16 data these stay at 0/1 (identity — shader expression is a no-op).
  // For float32 data the viewer sets these from metadata.dataRange after load.
  floatMin = 0;
  floatMax = 1;

  // Stored texel = value × texelScale + texelBias, folded into floatMin/floatMax on upload.
  // Identity except for uint16 on r16float, which is stored as value - UINT16_FLOAT16_OFFSET.
  texelScale = 1;
  texelBias = 0;

  // Axis-aligned clipping planes (0-1 normalized range)
  clipMin = new Float32Array([0, 0, 0]);
  clipMax = new Float32Array([1, 1, 1]);

  // Slice planes — active when volumeRenderMode === 'slice'
  sliceX = 0.5;
  sliceY = 0.5;
  sliceZ = 0.5;
  showSliceX = true;
  showSliceY = true;
  showSliceZ = true;

  // Render scale for compute shader (0.25–1.0, lower = faster but blurrier)
  renderScale = 0.5;

  // Overlay pipelines (rasterized wireframe, axis, slice)
  private wireframePipeline: GPURenderPipeline;
  private axisPipeline: GPURenderPipeline;
  private slicePipeline: GPURenderPipeline;
  private sliceBindGroup: GPUBindGroup;
  private sliceUniformBuffer: GPUBuffer;

  // Compute-based pipeline
  private computePipeline: GPUComputePipeline;
  // Label pick: one invocation that looks up every shown layer at the picked voxel
  private pickPipeline: GPUComputePipeline;
  private pickBindGroup: GPUBindGroup | null = null;
  private readonly pickReadback: GPUBuffer;
  private pickPending: { x: number; y: number; resolve: (record: ArrayBuffer | null) => void } | null = null;
  private pickBusy = false;
  /** LabelGpu.version the bind groups were built with */
  private labelVersion = -1;
  // Camera of the last rendered frame, to pick on slice planes
  private readonly lastCameraPos = new Float32Array(3);
  private lastOrthographic = false;
  private hasRendered = false;
  private blitPipeline: GPURenderPipeline;
  private computeUniformBuffer: GPUBuffer;

  // Ray-guided streaming: bitset of brick cells rays entered, and its staging copy (null when off)
  private readonly rayVisitedBuffer: GPUBuffer;
  private readonly rayReadback: GPUBuffer | null;
  private rayReadbackBusy = false;
  private rayFramesPending = 0;
  /** Frames covered by the copy currently being read back. */
  private rayReadbackFrames = 0;
  /** Called with each visibility readback (bit i ⇔ a ray entered finest-level cell i) and the frames it covers. */
  onRayVisibility?: (bits: Uint32Array, frames: number) => void;

  // Temporal accumulation
  private accumPipeline: GPUComputePipeline;
  private accumUniformBuffer: GPUBuffer;

  // pre-allocated per-scale resources. 
  // avoids texture/bind-group creation on gesture start/end 
  
  private scaleSets = new Map<number, ScaleSet>();
  private active!: ScaleSet;

  private prevVP: Float32Array | null = null;

  // Overlay bind groups
  private wireframeBindGroup: GPUBindGroup;
  private axisBindGroup: GPUBindGroup;

  // Buffers
  private vertexBuffer: GPUBuffer;
  private wireframeIndexBuffer: GPUBuffer;
  private wireframeUniformBuffer: GPUBuffer;
  private axisVertexBuffer: GPUBuffer;
  private axisUniformBuffer: GPUBuffer;

  // Depth
  private depthTexture: GPUTexture;
  private depthView: GPUTextureView;

  // Samplers (reused across bind groups)
  private volumeSampler: GPUSampler;
  private tfSampler: GPUSampler;
  private blitSampler: GPUSampler;
  private tfTexture: GPUTexture;

  // Counts
  private wireframeIndexCount: number;

  // Screen size (full resolution)
  private screenWidth = 1;
  private screenHeight = 1;

  // Frame counter for temporal jitter
  private frameIndex = 0;
  private disposed = false;

  private readonly config: DatasetConfig;

  // Per-channel display colors: RGBA (rgb = hue, a = intensity weight). Defaults: blue, yellow, red, white.
  readonly channelColors = new Float32Array([
    0, 0, 1, 1,   // ch0: blue
    1, 1, 0, 1,   // ch1: yellow
    1, 0, 0, 1,   // ch2: red
    1, 1, 1, 1,   // ch3: white
  ]);

  // Per-channel windowing (0-1 normalized). Defaults: center=0.5, width=1.0 (full range).
  readonly channelWindowCenter = new Float32Array([0.5, 0.5, 0.5, 0.5]);
  readonly channelWindowWidth  = new Float32Array([1.0, 1.0, 1.0, 1.0]);

  // Pre-allocated scratch buffers (avoid per-frame GC pressure)
  private readonly vpScratch = new Float32Array(16);
  private readonly invVPScratch = new Float32Array(16);
  private readonly computeUniformScratch = new Float32Array(COMPUTE_UNIFORMS.size / 4);
  private readonly computeUniformView = new DataView(this.computeUniformScratch.buffer);
  private readonly accumScratch = new Float32Array(4);
  private readonly sliceUniformScratch = new Float32Array(SLICE_UNIFORMS.size / 4);
  private readonly sliceUniformView = new DataView(this.sliceUniformScratch.buffer);

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    resources: VolumeResources,
    config: DatasetConfig,
    /** Label layers drawn over the volume (shared by every view) */
    private readonly labels: LabelGpu,
    /** Mark the brick cells rays enter and read them back for ray-guided streaming */
    readonly rayGuided = false,
  ) {
    this.device = device;
    this.config = config;
    this.resources = resources;
    this.pickReadback = device.createBuffer({ size: PICK_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    // One word (unused) switches marking off in the shader; enabled, word 0 stays unused too
    const rayWords = rayGuided ? 1 + RayVisibility.wordCount(config.datasetGrid) : 1;
    this.rayVisitedBuffer = device.createBuffer({
      size: rayWords * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.rayReadback = rayGuided
      ? device.createBuffer({ size: (rayWords - 1) * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
      : null;

    // Per-level voxel scale table is static for the dataset; both uniform structs carry it
    const lodScales = config.lodScaleTable(MAX_LOD_LEVELS);
    this.computeUniformScratch.set(lodScales, COMPUTE_UNIFORMS.offsets.lodScales / 4);
    this.sliceUniformScratch.set(lodScales, SLICE_UNIFORMS.offsets.lodScales / 4);

    // Create geometry (normalized proxy based on dataset aspect ratio)
    const box = createBox(config.normalizedSize);

    this.vertexBuffer = device.createBuffer({
      size: box.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, box.vertices as Float32Array<ArrayBuffer>);

    this.wireframeIndexBuffer = device.createBuffer({
      size: box.wireframeIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.wireframeIndexBuffer, 0, box.wireframeIndices as Uint16Array<ArrayBuffer>);
    this.wireframeIndexCount = box.wireframeIndices.length;

    // Create axis geometry (slightly larger than normalized proxy for visibility)
    const axis = createAxis(0.6);
    this.axisVertexBuffer = device.createBuffer({
      size: axis.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.axisVertexBuffer, 0, axis.vertices as Float32Array<ArrayBuffer>);

    // Wireframe: mat4 mvp (64)
    this.wireframeUniformBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Axis: mat4 vp (64)
    this.axisUniformBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Transfer function texture will be set externally
    this.tfTexture = null!;  // Will be set by setTransferFunction()

    // Create samplers (stored as members for reuse)
    this.volumeSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.tfSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
    });

    this.blitSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Depth stencil state
    const depthStencil: GPUDepthStencilState = {
      depthWriteEnabled: true,
      depthCompare: 'less',
      format: 'depth24plus',
    };

    // Create depth texture (will be resized)
    this.depthTexture = device.createTexture({
      size: [1, 1],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();

    // Vertex buffer layout
    const vertexLayout: GPUVertexBufferLayout = {
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
    };

    // Wireframe pipeline
    const wireframeModule = device.createShaderModule({ code: wireframeShader });
    this.wireframePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: wireframeModule, entryPoint: 'vs', buffers: [vertexLayout] },
      fragment: { module: wireframeModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil,
    });

    // Axis pipeline
    const axisModule = device.createShaderModule({ code: axisShader });
    const axisVertexLayout: GPUVertexBufferLayout = {
      arrayStride: 24, // 6 floats (pos + color)
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },  // position
        { shaderLocation: 1, offset: 12, format: 'float32x3' }, // color
      ],
    };
    this.axisPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: axisModule, entryPoint: 'vs', buffers: [axisVertexLayout] },
      fragment: { module: axisModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil,
    });

    // Slice planes pipeline
    this.sliceUniformBuffer = device.createBuffer({
      size: SLICE_UNIFORMS.size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const sliceModule = device.createShaderModule({ code: buildSlicePlanesShader(resources.atlasSize) });
    this.slicePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: sliceModule, entryPoint: 'vs' },
      fragment: {
        module: sliceModule,
        entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });

    // Slice bind group created when TF is set
    this.sliceBindGroup = null!;

    // Wireframe and axis bind groups (don't depend on TF)
    this.wireframeBindGroup = device.createBindGroup({
      layout: this.wireframePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.wireframeUniformBuffer } }],
    });

    this.axisBindGroup = device.createBindGroup({
      layout: this.axisPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.axisUniformBuffer } }],
    });

    // ===== Compute shader pipeline =====

    this.computeUniformBuffer = device.createBuffer({
      size: COMPUTE_UNIFORMS.size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Compute pipeline
    const computeModule = device.createShaderModule({ code: buildComputeShader(resources.atlasSize) });
    this.computePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: computeModule, entryPoint: 'main' },
    });
    this.pickPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: computeModule, entryPoint: 'pickLabels' },
    });

    // Blit pipeline (fullscreen quad to display compute output)
    const blitModule = device.createShaderModule({ code: blitShader });
    this.blitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blitModule, entryPoint: 'vs' },
      fragment: { module: blitModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { depthWriteEnabled: false, depthCompare: 'always', format: 'depth24plus' },
    });

    // Accumulation pipeline
    const accumModule = device.createShaderModule({ code: accumulateShader });
    this.accumPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: accumModule, entryPoint: 'main' },
    });

    // Accumulation uniform buffer: vec2 screenSize (8) + weight (4) + pad (4) = 16
    this.accumUniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // initial dummy scale set (will be properly sized at first resize)
    this.active = this.buildScaleSet(this.renderScale);
    this.scaleSets.set(this.renderScale, this.active);
  }

  /** Callback invoked when the scene needs a re-render (parameter change, brick arrival, etc.) */
  onDirty?: () => void;

  /** Signal that the scene changed and needs a re-render (without resetting accumulation) */
  markDirty(): void {
    this.onDirty?.();
  }

  /** Reset temporal accumulation (call when rendering parameters change) */
  resetAccumulation(): void {
    for (const set of this.scaleSets.values()) {
      set.accumFrameCount = 0;
    }
    this.onDirty?.();
  }

  /**
   * Copy the shared display settings of `src` (everything but the render mode) into this
   * renderer. Returns true if anything changed; the caller then resets accumulation.
   */
  syncLook(src: Renderer): boolean {
    let changed = false;
    const dst = this as Record<(typeof LOOK_SCALARS)[number], unknown>;
    for (const key of LOOK_SCALARS) {
      if (dst[key] !== src[key]) {
        dst[key] = src[key];
        changed = true;
      }
    }
    for (const key of LOOK_ARRAYS) {
      if (this[key].some((v, i) => v !== src[key][i])) {
        this[key].set(src[key]);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Show newly committed bricks. Restarts accumulation, or with `softReset` keeps the
   * history as SOFT_RESET_FRAMES frames: the new data blends in over a few frames instead
   * of the image dropping back to one jittered sample per pixel, which shows as woodgrain.
   */
  bricksCommitted(): void {
    if (!this.softReset) {
      this.resetAccumulation();
      return;
    }
    for (const set of this.scaleSets.values()) {
      set.accumFrameCount = Math.min(set.accumFrameCount, SOFT_RESET_FRAMES);
    }
    this.onDirty?.();
  }

  /** Jitter uniform: 0 = off, 1 = seeded by ray direction, 2 = seeded per pixel (`softReset`). */
  get jitterMode(): number {
    if (!this.enableJitter || !this.enableTAA) return 0;
    return this.softReset ? 2 : 1;
  }

  /** Whether the image is stable (no further rendering will change the output) */
  private get isSliceMode(): boolean {
    return this.volumeRenderMode === 'slice' || this.volumeRenderMode === 'slice-lod';
  }

  get isConverged(): boolean {
    return this.isSliceMode
      || !this.enableTAA
      || this.active.accumFrameCount >= 64;
  }

  /** Set the display color and intensity weight for a channel (0–3). Resets accumulation. */
  setChannelColor(ch: number, r: number, g: number, b: number, a = 1.0): void {
    const base = Math.min(Math.max(0, ch), 3) * 4;
    this.channelColors[base]     = r;
    this.channelColors[base + 1] = g;
    this.channelColors[base + 2] = b;
    this.channelColors[base + 3] = a;
    this.resetAccumulation();
  }

  /** Set the window center and width for a channel (0–3). Resets accumulation. */
  setChannelWindow(ch: number, center: number, width: number): void {
    const i = Math.min(Math.max(0, ch), 3);
    this.channelWindowCenter[i] = center;
    this.channelWindowWidth[i]  = width;
    this.resetAccumulation();
  }

  /**
   * Set the transfer function and recreate bind groups
   */
  setTransferFunction(tf: TransferFunction): void {
    this.tfTexture = tf.texture;
    this.recreateVolumeBindGroups();
  }

  private recreateVolumeBindGroups(): void {
    if (!this.tfTexture) return;
    this.labelVersion = this.labels.version;

    this.sliceBindGroup = this.device.createBindGroup({
      layout: this.slicePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.sliceUniformBuffer } },
        { binding: 1, resource: this.volumeSampler },
        { binding: 2, resource: this.resources.atlasView(0) },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 6, resource: this.resources.indirection.texture.createView() },
        { binding: 8, resource: this.resources.atlasView(1) },
        { binding: 9, resource: this.resources.atlasView(2) },
        { binding: 10, resource: this.resources.atlasView(3) },
        ...this.labelBindings(),
      ],
    });

    this.pickBindGroup = this.device.createBindGroup({
      layout: this.pickPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 6, resource: this.resources.indirection.texture.createView() },
        ...this.labelBindings(),
        { binding: 16, resource: { buffer: this.labels.pick } },
      ],
    });

    // rebuild bind groups for all pre-allocated scale sets
    for (const set of this.scaleSets.values()) {
      this.rebuildScaleSetBindGroups(set);
    }
  }

  resize(width: number, height: number) {
    if (this.disposed) return;
    this.screenWidth = width;
    this.screenHeight = height;

    // Resize depth texture (always full resolution for overlays)
    this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();

    // rebuild all pre-allocated scale sets at new screen size
    // Always include the current renderScale — it may have been set externally
    // (e.g. via ViewerOptions) before this first resize, and wouldn't be in the map yet.
    const scales = Array.from(new Set([...this.scaleSets.keys(), this.renderScale]));
    for (const set of this.scaleSets.values()) this.destroyScaleSet(set);
    this.scaleSets.clear();

    for (const scale of scales) {
      this.scaleSets.set(scale, this.buildScaleSet(scale));
    }
    this.active = this.scaleSets.get(this.renderScale)!;
  }

  prepareScale(scale: number): void {
    if (this.scaleSets.has(scale)) return;
    this.scaleSets.set(scale, this.buildScaleSet(scale));
  }

  /** switch to a pre-allocated scale set */
  activateScale(scale: number): void {
    if (this.renderScale === scale) return;
    this.renderScale = scale;
    let set = this.scaleSets.get(scale);
    if (!set) {
      set = this.buildScaleSet(scale);
      this.scaleSets.set(scale, set);
    }
    this.active = set;
    this.active.accumFrameCount = 0;
    this.active.accumIndex = 0;
  }

  private buildScaleSet(scale: number): ScaleSet {
    const width = Math.max(1, Math.round(this.screenWidth * scale));
    const height = Math.max(1, Math.round(this.screenHeight * scale));
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;

    const outputTexture = this.device.createTexture({ size: [width, height], format: 'rgba16float', usage });
    const outputView = outputTexture.createView();
    const accumTextures: [GPUTexture, GPUTexture] = [
      this.device.createTexture({ size: [width, height], format: 'rgba16float', usage }),
      this.device.createTexture({ size: [width, height], format: 'rgba16float', usage }),
    ];
    const accumViews: [GPUTextureView, GPUTextureView] = [
      accumTextures[0].createView(), accumTextures[1].createView(),
    ];

    const set: ScaleSet = {
      scale, width, height,
      outputTexture, outputView,
      accumTextures, accumViews,
      accumBindGroups: [null!, null!],
      computeBindGroup: null!,
      directBlitBindGroup: null!,
      blitBindGroups: [null!, null!],
      accumIndex: 0,
      accumFrameCount: 0,
    };

    this.rebuildScaleSetBindGroups(set);
    return set;
  }

  private destroyScaleSet(set: ScaleSet): void {
    set.outputTexture.destroy();
    for (const tex of set.accumTextures) tex.destroy();
  }

  /** Bytes of the render targets: output and two accumulation rgba16float textures per scale set, plus depth. */
  get renderTargetBytes(): number {
    let bytes = this.screenWidth * this.screenHeight * 4; // depth24plus
    for (const set of this.scaleSets.values()) bytes += 3 * set.width * set.height * 8;
    return bytes;
  }

  /** Scale sets allocated (one per render scale used). */
  get scaleSetCount(): number { return this.scaleSets.size; }

  /** Bytes of the renderer's buffers: ray visibility and its readback, pick readback. */
  get bufferBytes(): number {
    return this.rayVisitedBuffer.size + (this.rayReadback?.size ?? 0) + this.pickReadback.size;
  }

  /** Destroy renderer-owned GPU textures and buffers (device, atlas and TF texture are external). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const set of this.scaleSets.values()) this.destroyScaleSet(set);
    this.scaleSets.clear();
    this.depthTexture.destroy();
    const buffers = [
      this.sliceUniformBuffer, this.computeUniformBuffer, this.accumUniformBuffer, this.vertexBuffer,
      this.wireframeIndexBuffer, this.wireframeUniformBuffer, this.axisVertexBuffer, this.axisUniformBuffer,
      this.rayVisitedBuffer, ...(this.rayReadback ? [this.rayReadback] : []), this.pickReadback,
    ];
    for (const buffer of buffers) buffer.destroy();
    this.pickPending?.resolve(null);
    this.pickPending = null;
  }

  private rebuildScaleSetBindGroups(set: ScaleSet): void {
    if (!this.tfTexture) return;

    set.computeBindGroup = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: this.volumeSampler },
        { binding: 2, resource: this.resources.atlasView(0) },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 6, resource: this.resources.indirection.texture.createView() },
        { binding: 7, resource: set.outputView },
        { binding: 8, resource: this.resources.atlasView(1) },
        { binding: 9, resource: this.resources.atlasView(2) },
        { binding: 10, resource: this.resources.atlasView(3) },
        { binding: 11, resource: { buffer: this.rayVisitedBuffer } },
        ...this.labelBindings(),
        { binding: 16, resource: { buffer: this.labels.pick } },
      ],
    });

    const accumLayout = this.accumPipeline.getBindGroupLayout(0);
    set.accumBindGroups = [
      this.device.createBindGroup({
        layout: accumLayout,
        entries: [
          { binding: 0, resource: { buffer: this.accumUniformBuffer } },
          { binding: 1, resource: set.outputView },
          { binding: 2, resource: set.accumViews[1] },
          { binding: 3, resource: set.accumViews[0] },
        ],
      }),
      this.device.createBindGroup({
        layout: accumLayout,
        entries: [
          { binding: 0, resource: { buffer: this.accumUniformBuffer } },
          { binding: 1, resource: set.outputView },
          { binding: 2, resource: set.accumViews[0] },
          { binding: 3, resource: set.accumViews[1] },
        ],
      }),
    ];

    const blitLayout = this.blitPipeline.getBindGroupLayout(0);
    set.directBlitBindGroup = this.device.createBindGroup({
      layout: blitLayout,
      entries: [
        { binding: 0, resource: set.outputView },
        { binding: 1, resource: this.blitSampler },
      ],
    });
    set.blitBindGroups = [
      this.device.createBindGroup({
        layout: blitLayout,
        entries: [
          { binding: 0, resource: set.accumViews[0] },
          { binding: 1, resource: this.blitSampler },
        ],
      }),
      this.device.createBindGroup({
        layout: blitLayout,
        entries: [
          { binding: 0, resource: set.accumViews[1] },
          { binding: 1, resource: this.blitSampler },
        ],
      }),
    ];
  }

  /** Pool, entries, palette and styles of the label layers. */
  private labelBindings(): GPUBindGroupEntry[] {
    return [
      { binding: 12, resource: this.labels.pool.createView() },
      { binding: 13, resource: { buffer: this.labels.entries } },
      { binding: 14, resource: { buffer: this.labels.palette } },
      { binding: 15, resource: { buffer: this.labels.params } },
    ];
  }

  /**
   * The label record (see LabelGpu.pick) at pixel (x, y) of this view, in output pixels: the
   * front-most drawn label along the ray in volume modes (taken by the next render, so the caller
   * marks the view dirty), the slice plane under the pixel in slice mode. Resolves null when
   * superseded by a newer pick.
   */
  pick(x: number, y: number): Promise<ArrayBuffer | null> {
    this.pickPending?.resolve(null);
    return new Promise(resolve => {
      this.pickPending = { x, y, resolve };
      if (this.isSliceMode) this.pickSlices();
    });
  }

  /** Slice mode: intersect the pixel's ray with the shown planes on the CPU, then look labels up. */
  private pickSlices(): void {
    const pick = this.pickPending;
    if (!pick || this.pickBusy || !this.hasRendered || !this.pickBindGroup) return;
    this.pickPending = null;
    const hit = new Float32Array(4);
    const voxel = this.slicePlaneVoxel(pick.x, pick.y);
    if (voxel) hit.set([...voxel, 1]);
    this.device.queue.writeBuffer(this.labels.pick, 0, hit);
    const encoder = this.device.createCommandEncoder();
    this.encodePick(encoder);
    this.device.queue.submit([encoder.finish()]);
    this.readPick(pick.resolve);
  }

  /** Finest-level voxel where the pixel's ray first meets a shown slice plane, or null. */
  private slicePlaneVoxel(x: number, y: number): [number, number, number] | null {
    const inv = this.invVPScratch;
    const ndcX = (x + 0.5) / this.screenWidth * 2 - 1;
    const ndcY = 1 - (y + 0.5) / this.screenHeight * 2;
    const unproject = (z: number) => {
      const v = [0, 1, 2, 3].map(r => inv[r]! * ndcX + inv[4 + r]! * ndcY + inv[8 + r]! * z + inv[12 + r]!);
      return [v[0]! / v[3]!, v[1]! / v[3]!, v[2]! / v[3]!];
    };
    const near = unproject(-1);
    const far = unproject(1);
    // Like the ray march: orthographic rays start on the near plane, perspective ones at the camera
    const origin = this.lastOrthographic ? near : [...this.lastCameraPos];
    const dir = far.map((f, i) => f - near[i]!);
    const ns = this.config.normalizedSize;
    const planes = [
      this.showSliceX ? this.sliceX : null, this.showSliceY ? this.sliceY : null, this.showSliceZ ? this.sliceZ : null,
    ];
    let best: number[] | null = null;
    let bestT = Infinity;
    planes.forEach((position, axis) => {
      if (position === null || Math.abs(dir[axis]!) < 1e-12) return;
      const t = ((position - 0.5) * ns[axis]! - origin[axis]!) / dir[axis]!;
      if (!(t > 0) || t >= bestT) return;
      const p = origin.map((o, i) => o + dir[i]! * t);
      if (p.some((v, i) => i !== axis && Math.abs(v) > ns[i]! / 2)) return;
      p[axis] = (position - 0.5) * ns[axis]!;
      best = p;
      bestT = t;
    });
    if (!best) return null;
    const dims = this.config.dimensions;
    return (best as number[]).map((v, i) => Math.min(dims[i]! - 1e-3, Math.max(0, (v / ns[i]! + 0.5) * dims[i]!))) as [number, number, number];
  }

  private encodePick(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pickPipeline);
    pass.setBindGroup(0, this.pickBindGroup!);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(this.labels.pick, 0, this.pickReadback, 0, PICK_BYTES);
  }

  private readPick(resolve: (record: ArrayBuffer | null) => void): void {
    this.pickBusy = true;
    this.pickReadback.mapAsync(GPUMapMode.READ).then(() => {
      const record = this.pickReadback.getMappedRange().slice(0);
      this.pickReadback.unmap();
      this.pickBusy = false;
      resolve(record);
      // A pick that arrived while this one was read back
      if (this.pickPending && this.isSliceMode) this.pickSlices();
      else if (this.pickPending) this.markDirty();
    }, () => {
      this.pickBusy = false;
      resolve(null);
    });
  }

  private updateSliceUniforms(vp: Float32Array): void {
    const o = SLICE_UNIFORMS.offsets;
    const d = this.sliceUniformScratch;
    const dv = this.sliceUniformView;
    d.set(vp, o.mvp / 4);
    d.set(this.config.normalizedSize, o.normalizedSize / 4);
    d.set(this.config.dimensions, o.datasetSize / 4);
    d[o.windowCenter / 4] = this.windowCenter;
    d[o.windowWidth / 4] = this.windowWidth;
    d[o.floatMin / 4] = this.floatMin * this.texelScale + this.texelBias;
    d[o.floatMax / 4] = this.floatMax * this.texelScale + this.texelBias;
    d[o.slicePositions / 4] = this.sliceX;
    d[o.slicePositions / 4 + 1] = this.sliceY;
    d[o.slicePositions / 4 + 2] = this.sliceZ;
    dv.setUint32(o.sliceXEnabled, this.showSliceX ? 1 : 0, true);
    dv.setUint32(o.sliceYEnabled, this.showSliceY ? 1 : 0, true);
    dv.setUint32(o.sliceZEnabled, this.showSliceZ ? 1 : 0, true);
    dv.setUint32(o.numChannels, this.numChannels, true);
    dv.setUint32(o.lodDebug, this.volumeRenderMode === 'slice-lod' ? 1 : 0, true);
    d.set(this.channelColors, o.channelColors / 4);
    d.set(this.channelWindowCenter, o.channelWindowCenter / 4);
    d.set(this.channelWindowWidth, o.channelWindowWidth / 4);
    this.device.queue.writeBuffer(this.sliceUniformBuffer, 0, d as Float32Array<ArrayBuffer>);
  }

  render(colorView: GPUTextureView, view: ViewParams) {
    if (this.disposed) return;
    if (this.labels.version !== this.labelVersion) this.recreateVolumeBindGroups();
    mat4.multiply(view.proj, view.view, this.vpScratch);

    this.renderCompute(colorView, view, this.vpScratch);

    this.lastCameraPos.set(Array.from(view.position).slice(0, 3));
    this.lastOrthographic = isOrthographic(view.proj);
    this.hasRendered = true;
    if (this.isSliceMode && this.pickPending) this.pickSlices();
    this.frameIndex++;
  }

  private getRenderModeInt(): number {
    switch (this.volumeRenderMode) {
      case 'mip': return 1;
      case 'iso': return 2;
      case 'lod': return 3;
      default: return 0;  // dvr
    }
  }

  /** Get depth view for external renderers (debug wireframes, etc) */
  getDepthView(): GPUTextureView {
    return this.depthView;
  }

  /** Get view-projection matrix for external renderers */
  getViewProjMatrix(view: ViewParams): Float32Array {
    const out = new Float32Array(16);
    mat4.multiply(view.proj, view.view, out);
    return out;
  }

  private renderCompute(colorView: GPUTextureView, view: ViewParams, vp: Float32Array) {
    // Detect camera movement for temporal accumulation reset
    let vpChanged = true;
    if (this.prevVP) {
      vpChanged = false;
      for (let i = 0; i < 16; i++) {
        if (Math.abs(vp[i]! - this.prevVP[i]!) > 1e-6) { vpChanged = true; break; }
      }
    }
    if (!this.prevVP) this.prevVP = new Float32Array(16);
    this.prevVP.set(vp);
    if (vpChanged) {
      for (const set of this.scaleSets.values()) set.accumFrameCount = 0;
    }

    // Compute inverse view-projection for ray generation (writes into scratch buffer)
    mat4.inverse(vp, this.invVPScratch);

    // Update compute uniforms (offsets from COMPUTE_UNIFORMS — single source of truth)
    const o = COMPUTE_UNIFORMS.offsets;
    const d = this.computeUniformScratch;
    const dv = this.computeUniformView;
    d.set(this.invVPScratch, o.inverseViewProj / 4);
    d.set(view.position, o.cameraPos / 4);
    d[o.useIndirection / 4] = this.useIndirection ? 1.0 : 0.0;
    d.set(this.config.dimensions, o.datasetSize / 4);
    dv.setInt32(o.renderMode, this.getRenderModeInt(), true);
    d.set(this.config.normalizedSize, o.normalizedSize / 4);
    d[o.isoValue / 4] = this.isoValue;
    d[o.screenSize / 4] = this.active.width;
    d[o.screenSize / 4 + 1] = this.active.height;
    dv.setUint32(o.frameIndex, this.frameIndex, true);
    dv.setUint32(o.jitter, this.jitterMode, true);
    d[o.windowCenter / 4] = this.windowCenter;
    d[o.windowWidth / 4] = this.windowWidth;
    d[o.floatMin / 4] = this.floatMin * this.texelScale + this.texelBias;
    d[o.floatMax / 4] = this.floatMax * this.texelScale + this.texelBias;
    d.set(this.clipMin, o.clipMin / 4);
    d[o.densityScale / 4] = this.densityScale;
    d.set(this.clipMax, o.clipMax / 4);
    dv.setUint32(o.numChannels, this.numChannels, true);
    d.set(this.channelColors, o.channelColors / 4);
    d.set(this.channelWindowCenter, o.channelWindowCenter / 4);
    d.set(this.channelWindowWidth, o.channelWindowWidth / 4);
    d[o.shading / 4] = this.shading;
    d[o.gradientOpacity / 4] = this.gradientOpacity;
    dv.setUint32(o.orthographic, isOrthographic(view.proj) ? 1 : 0, true);
    // A pending pick rides along with this frame's ray march (output pixels → render-scale pixels)
    const pick = !this.isSliceMode && !this.pickBusy && this.pickBindGroup ? this.pickPending : null;
    d[o.pickPixel / 4] = pick ? Math.floor(pick.x * this.active.width / this.screenWidth) : -1;
    d[o.pickPixel / 4 + 1] = pick ? Math.floor(pick.y * this.active.height / this.screenHeight) : -1;
    this.device.queue.writeBuffer(this.computeUniformBuffer, 0, d as Float32Array<ArrayBuffer>);

    const encoder = this.device.createCommandEncoder();
    let readRayVisits = false;
    const workgroupsX = Math.ceil(this.active.width / 8);
    const workgroupsY = Math.ceil(this.active.height / 8);

    if (!this.isSliceMode) {
      if (pick) encoder.clearBuffer(this.labels.pick);
      // Normal volume compute path
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(this.computePipeline);
      computePass.setBindGroup(0, this.active.computeBindGroup);
      computePass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
      computePass.end();
      if (pick) this.encodePick(encoder);

      // Temporal accumulation pass
      if (this.enableTAA) {
        const weight = 1.0 / (this.active.accumFrameCount + 1);
        this.accumScratch[0] = this.active.width;
        this.accumScratch[1] = this.active.height;
        this.accumScratch[2] = weight;
        this.device.queue.writeBuffer(this.accumUniformBuffer, 0, this.accumScratch as Float32Array<ArrayBuffer>);

        const accumPass = encoder.beginComputePass();
        accumPass.setPipeline(this.accumPipeline);
        accumPass.setBindGroup(0, this.active.accumBindGroups[this.active.accumIndex]);
        accumPass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
        accumPass.end();
      }

      // Advance accumulation state (cap at 64 — diminishing returns beyond that)
      if (this.enableTAA) {
        this.active.accumIndex = 1 - this.active.accumIndex as 0 | 1;
        if (this.active.accumFrameCount < 64) {
          this.active.accumFrameCount++;
        }
      }

      // A TAA-off parameter change may render only once. Likewise the final TAA frame
      // may leave a partial batch, so don't depend on another draw to deliver its visits.
      if (this.rayReadback !== null && this.useIndirection) {
        this.rayFramesPending++;
        if (this.rayFramesPending >= RAY_READBACK_INTERVAL || this.isConverged) {
          readRayVisits = this.copyRayVisits(encoder);
        }
      }
    }

    // update uniforms for overlay pass
    if (this.showWireframe) {
      this.device.queue.writeBuffer(this.wireframeUniformBuffer, 0, vp as Float32Array<ArrayBuffer>);
    }
    if (this.isSliceMode) {
      this.updateSliceUniforms(vp);
    }

    // Single merged pass: blit volume (if any) then draw overlays.
    // Always clears — avoids a tile flush+reload on TBDR GPUs.
    // Depth is never read back, so discard saves a full-screen write.
    const overlayPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        clearValue: [0.05, 0.05, 0.05, 1],
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });

    // Blit volume compute result as first draw (depthCompare: 'always', no depth write)
    if (!this.isSliceMode) {
      // select blit source: TAA accumulation result or direct compute output
      const blitBG = this.enableTAA
        ? this.active.blitBindGroups[1 - this.active.accumIndex as 0 | 1]!
        : this.active.directBlitBindGroup;
      overlayPass.setPipeline(this.blitPipeline);
      overlayPass.setBindGroup(0, blitBG);
      overlayPass.draw(3);
    }

    // Draw slice planes
    if (this.isSliceMode && this.sliceBindGroup) {
      overlayPass.setPipeline(this.slicePipeline);
      overlayPass.setBindGroup(0, this.sliceBindGroup);
      overlayPass.draw(6, 3); // 6 vertices × 3 instances (X, Y, Z planes)
    }

    // Draw wireframe
    if (this.showWireframe) {
      overlayPass.setPipeline(this.wireframePipeline);
      overlayPass.setBindGroup(0, this.wireframeBindGroup);
      overlayPass.setVertexBuffer(0, this.vertexBuffer);
      overlayPass.setIndexBuffer(this.wireframeIndexBuffer, 'uint16');
      overlayPass.drawIndexed(this.wireframeIndexCount);
    }

    // Draw axis
    if (this.showAxis) {
      this.device.queue.writeBuffer(this.axisUniformBuffer, 0, vp as Float32Array<ArrayBuffer>);
      overlayPass.setPipeline(this.axisPipeline);
      overlayPass.setBindGroup(0, this.axisBindGroup);
      overlayPass.setVertexBuffer(0, this.axisVertexBuffer);
      overlayPass.draw(6);
    }

    overlayPass.end();

    this.device.queue.submit([encoder.finish()]);
    if (readRayVisits) this.readRayVisits();
    if (pick) {
      this.pickPending = null;
      this.readPick(pick.resolve);
    }
  }

  /** Copy collected visits only when the staging buffer is available. */
  private copyRayVisits(encoder: GPUCommandEncoder): boolean {
    if (!this.rayReadback || this.rayReadbackBusy || this.rayFramesPending === 0) return false;
    const bytes = this.rayReadback.size;
    encoder.copyBufferToBuffer(this.rayVisitedBuffer, 4, this.rayReadback, 0, bytes);
    encoder.clearBuffer(this.rayVisitedBuffer, 4, bytes);
    this.rayReadbackFrames = this.rayFramesPending;
    this.rayFramesPending = 0;
    return true;
  }

  /** Map the staging copy without stalling the frame; the next copy waits until it is unmapped. */
  private readRayVisits(): void {
    const buffer = this.rayReadback!;
    this.rayReadbackBusy = true;
    buffer.mapAsync(GPUMapMode.READ).then(() => {
      const bits = new Uint32Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      this.rayReadbackBusy = false;
      if (this.disposed) return;
      this.onRayVisibility?.(bits, this.rayReadbackFrames);

      // Rendering can finish while mapAsync is pending. Drain the last batch with
      // a copy-only submission: no extra raymarch, TAA reset or redraw loop needed.
      if (!this.disposed && this.marchesRays && this.isConverged && this.rayFramesPending > 0) {
        const encoder = this.device.createCommandEncoder();
        if (this.copyRayVisits(encoder)) {
          this.device.queue.submit([encoder.finish()]);
          this.readRayVisits();
        }
      }
    }, () => { this.rayReadbackBusy = false; }); // destroyed while mapping (dispose)
  }

  /** Whether rays are marched (and cells marked) in the current mode; slice planes sample the atlas directly. */
  get marchesRays(): boolean {
    return !this.isSliceMode && this.useIndirection;
  }
}
