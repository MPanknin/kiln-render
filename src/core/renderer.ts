/**
 * Volume Renderer using proxy box geometry
 */

import { mat4 } from 'wgpu-matrix';
import { Camera } from './camera.js';
import { VolumeCanvas, createVolumeCanvas } from './volume.js';
import { createBox, createAxis } from '../utils/geometry.js';
import { TransferFunction } from './transfer-function.js';
import { IndirectionTable } from './indirection.js';
import { AtlasAllocator } from '../streaming/atlas-allocator.js';
import { wireframeShader, axisShader, computeShader, blitShader, accumulateShader, slicePlanesShader } from '../shaders/index.js';
import { COMPUTE_UNIFORMS, SLICE_UNIFORMS } from '../shaders/uniform-layout.js';
import type { DatasetConfig } from './config.js';
import type { BitDepth } from '../data/data-provider.js';

// Volume render mode (shader-side)
export type VolumeRenderMode = 'dvr' | 'mip' | 'iso' | 'lod' | 'slice';

export class Renderer {
  private device: GPUDevice;

  // Number of channels (1–4)
  readonly numChannels: number;

  // Atlas textures — one per channel
  canvases: VolumeCanvas[];

  // Channel 0 alias for single-channel callers
  get canvas(): VolumeCanvas { return this.canvases[0]!; }

  // Dummy 1×1×1 texture bound to unused channel slots
  private dummyTexture: GPUTexture;

  // Indirection table for virtual texturing
  indirection: IndirectionTable;

  // Atlas slot allocator
  allocator: AtlasAllocator;

  // Debug: toggle indirection on/off
  useIndirection = true;

  // Show wireframe box
  showWireframe = false;

  // Density scale for DVR compositing (1.0 = default)
  densityScale = 1.0;

  // Show axis helper
  showAxis = false;

  // Jitter: randomize ray start position per frame to dither brick seams
  enableJitter = true;

  // TAA: accumulate jittered frames for temporal anti-aliasing
  enableTAA = true;

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
  private blitPipeline: GPURenderPipeline;
  private computeBindGroup: GPUBindGroup;
  private blitBindGroup: GPUBindGroup; // active blit bind group (set per-frame from blitBindGroups)
  private blitBindGroups: [GPUBindGroup, GPUBindGroup] = null!; // one per accum texture
  private directBlitBindGroup: GPUBindGroup; // blit directly from compute output (no TAA)
  private computeUniformBuffer: GPUBuffer;
  private computeOutputTexture: GPUTexture;
  private computeOutputView: GPUTextureView;

  // Temporal accumulation
  private accumPipeline: GPUComputePipeline;
  private accumUniformBuffer: GPUBuffer;
  private accumTextures: [GPUTexture, GPUTexture] = null!;
  private accumViews: [GPUTextureView, GPUTextureView] = null!;
  private accumBindGroups: [GPUBindGroup, GPUBindGroup] = null!;
  private accumIndex = 0; // ping-pong index: write to accumTextures[accumIndex], read from other
  private accumFrameCount = 0;
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

  // Compute texture size (may be lower than screen when renderScale < 1)
  private computeWidth = 1;
  private computeHeight = 1;

  // Frame counter for temporal jitter
  private frameIndex = 0;

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

  constructor(device: GPUDevice, format: GPUTextureFormat, bitDepth: BitDepth, textureFormat: GPUTextureFormat, config: DatasetConfig, numChannels = 1) {
    this.device = device;
    this.config = config;
    this.numChannels = Math.min(Math.max(1, numChannels), 4);

    // Create atlas textures — one per channel
    this.canvases = Array.from({ length: this.numChannels }, () =>
      createVolumeCanvas(device, bitDepth, textureFormat)
    );

    // Dummy texture for unused channel bindings (always bound, never sampled when numChannels < 4)
    this.dummyTexture = device.createTexture({
      size: [1, 1, 1],
      format: textureFormat,
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Create indirection table for virtual texturing
    this.indirection = new IndirectionTable(device, config);

    // Create atlas allocator
    this.allocator = new AtlasAllocator();

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

    const sliceModule = device.createShaderModule({ code: slicePlanesShader });
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

    // Output texture (will be resized)
    this.computeOutputTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.computeOutputView = this.computeOutputTexture.createView();

    // Compute pipeline
    const computeModule = device.createShaderModule({ code: computeShader });
    this.computePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: computeModule, entryPoint: 'main' },
    });

    // Compute bind group will be created when TF is set
    this.computeBindGroup = null!;

    // Blit pipeline (fullscreen quad to display compute output)
    const blitModule = device.createShaderModule({ code: blitShader });
    this.blitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blitModule, entryPoint: 'vs' },
      fragment: { module: blitModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.blitBindGroup = device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.computeOutputView },
        { binding: 1, resource: this.blitSampler },
      ],
    });

    this.directBlitBindGroup = this.blitBindGroup; // will be recreated with compute textures

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

    // Accumulation textures (ping-pong, will be resized)
    const dummyTex = () => device.createTexture({
      size: [1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.accumTextures = [dummyTex(), dummyTex()];
    this.accumViews = [this.accumTextures[0].createView(), this.accumTextures[1].createView()];
    this.accumBindGroups = [null!, null!];
  }

  /** Callback invoked when the scene needs a re-render (parameter change, brick arrival, etc.) */
  onDirty?: () => void;

  /** Signal that the scene changed and needs a re-render (without resetting accumulation) */
  markDirty(): void {
    this.onDirty?.();
  }

  /** Reset temporal accumulation (call when rendering parameters change) */
  resetAccumulation(): void {
    this.accumFrameCount = 0;
    this.onDirty?.();
  }

  /** Whether the image is stable (no further rendering will change the output) */
  get isConverged(): boolean {
    // TAA off: every frame is identical (no jitter), converged after 1 frame
    // TAA on: converged once accumulation reaches the 64-frame cap
    return !this.enableTAA || this.accumFrameCount >= 64;
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

  /** View for atlas channel ch (dummy if ch >= numChannels) */
  private atlasView(ch: number): GPUTextureView {
    return ch < this.numChannels
      ? this.canvases[ch]!.texture.createView()
      : this.dummyTexture.createView();
  }

  private recreateVolumeBindGroups(): void {
    if (!this.tfTexture) return;

    this.sliceBindGroup = this.device.createBindGroup({
      layout: this.slicePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.sliceUniformBuffer } },
        { binding: 1, resource: this.volumeSampler },
        { binding: 2, resource: this.atlasView(0) },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 6, resource: this.indirection.texture.createView() },
        { binding: 8, resource: this.atlasView(1) },
        { binding: 9, resource: this.atlasView(2) },
        { binding: 10, resource: this.atlasView(3) },
      ],
    });

    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: this.volumeSampler },
        { binding: 2, resource: this.atlasView(0) },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 6, resource: this.indirection.texture.createView() },
        { binding: 7, resource: this.computeOutputView },
        { binding: 8, resource: this.atlasView(1) },
        { binding: 9, resource: this.atlasView(2) },
        { binding: 10, resource: this.atlasView(3) },
      ],
    });
  }

  resize(width: number, height: number) {
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

    // Resize compute output texture (scaled resolution)
    this.resizeComputeTexture();
  }

  /** Recreate compute output texture at current renderScale. Call after changing renderScale. */
  resizeComputeTexture(): void {
    this.computeWidth = Math.max(1, Math.round(this.screenWidth * this.renderScale));
    this.computeHeight = Math.max(1, Math.round(this.screenHeight * this.renderScale));

    this.computeOutputTexture.destroy();
    this.computeOutputTexture = this.device.createTexture({
      size: [this.computeWidth, this.computeHeight],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.computeOutputView = this.computeOutputTexture.createView();

    // Resize accumulation textures
    for (const tex of this.accumTextures) tex.destroy();
    const size: [number, number] = [this.computeWidth, this.computeHeight];
    const accumUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.accumTextures = [
      this.device.createTexture({ size, format: 'rgba16float', usage: accumUsage }),
      this.device.createTexture({ size, format: 'rgba16float', usage: accumUsage }),
    ];
    this.accumViews = [this.accumTextures[0].createView(), this.accumTextures[1].createView()];
    this.accumFrameCount = 0;
    this.accumIndex = 0;

    this.recreateComputeBindGroups();
  }

  private recreateComputeBindGroups() {
    if (!this.tfTexture) return;

    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: this.volumeSampler },
        { binding: 2, resource: this.atlasView(0) },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 6, resource: this.indirection.texture.createView() },
        { binding: 7, resource: this.computeOutputView },
        { binding: 8, resource: this.atlasView(1) },
        { binding: 9, resource: this.atlasView(2) },
        { binding: 10, resource: this.atlasView(3) },
      ],
    });

    // Accumulation bind groups: two configurations for ping-pong
    // Config 0: read history from accumTextures[1], write to accumTextures[0]
    // Config 1: read history from accumTextures[0], write to accumTextures[1]
    const accumLayout = this.accumPipeline.getBindGroupLayout(0);
    this.accumBindGroups = [
      this.device.createBindGroup({
        layout: accumLayout,
        entries: [
          { binding: 0, resource: { buffer: this.accumUniformBuffer } },
          { binding: 1, resource: this.computeOutputView },
          { binding: 2, resource: this.accumViews[1] },
          { binding: 3, resource: this.accumViews[0] },
        ],
      }),
      this.device.createBindGroup({
        layout: accumLayout,
        entries: [
          { binding: 0, resource: { buffer: this.accumUniformBuffer } },
          { binding: 1, resource: this.computeOutputView },
          { binding: 2, resource: this.accumViews[0] },
          { binding: 3, resource: this.accumViews[1] },
        ],
      }),
    ] as [GPUBindGroup, GPUBindGroup];

    // Direct blit bind group: always points to compute output (no TAA)
    const blitLayout = this.blitPipeline.getBindGroupLayout(0);
    this.directBlitBindGroup = this.device.createBindGroup({
      layout: blitLayout,
      entries: [
        { binding: 0, resource: this.computeOutputView },
        { binding: 1, resource: this.blitSampler },
      ],
    });

    // Blit bind groups: one per accumulation texture
    this.blitBindGroups = [
      this.device.createBindGroup({
        layout: blitLayout,
        entries: [
          { binding: 0, resource: this.accumViews[0]! },
          { binding: 1, resource: this.blitSampler },
        ],
      }),
      this.device.createBindGroup({
        layout: blitLayout,
        entries: [
          { binding: 0, resource: this.accumViews[1]! },
          { binding: 1, resource: this.blitSampler },
        ],
      }),
    ];
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
    d[o.floatMin / 4] = this.floatMin;
    d[o.floatMax / 4] = this.floatMax;
    d[o.slicePositions / 4] = this.sliceX;
    d[o.slicePositions / 4 + 1] = this.sliceY;
    d[o.slicePositions / 4 + 2] = this.sliceZ;
    dv.setUint32(o.sliceXEnabled, this.showSliceX ? 1 : 0, true);
    dv.setUint32(o.sliceYEnabled, this.showSliceY ? 1 : 0, true);
    dv.setUint32(o.sliceZEnabled, this.showSliceZ ? 1 : 0, true);
    dv.setUint32(o.numChannels, this.numChannels, true);
    d.set(this.channelColors, o.channelColors / 4);
    d.set(this.channelWindowCenter, o.channelWindowCenter / 4);
    d.set(this.channelWindowWidth, o.channelWindowWidth / 4);
    this.device.queue.writeBuffer(this.sliceUniformBuffer, 0, d as Float32Array<ArrayBuffer>);
  }

  render(colorView: GPUTextureView, camera: Camera) {
    const aspect = this.depthTexture.width / this.depthTexture.height;
    const view = camera.getViewMatrix();
    const proj = camera.getProjectionMatrix(aspect);
    mat4.multiply(proj, view, this.vpScratch);

    this.renderCompute(colorView, camera, this.vpScratch);

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
  getViewProjMatrix(camera: Camera): Float32Array {
    const aspect = this.depthTexture.width / this.depthTexture.height;
    const view = camera.getViewMatrix();
    const proj = camera.getProjectionMatrix(aspect);
    const out = new Float32Array(16);
    mat4.multiply(proj, view, out);
    return out;
  }

  private renderCompute(colorView: GPUTextureView, camera: Camera, vp: Float32Array) {
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
      this.accumFrameCount = 0;
    }

    // Compute inverse view-projection for ray generation (writes into scratch buffer)
    mat4.inverse(vp, this.invVPScratch);

    // Update compute uniforms (offsets from COMPUTE_UNIFORMS — single source of truth)
    const o = COMPUTE_UNIFORMS.offsets;
    const d = this.computeUniformScratch;
    const dv = this.computeUniformView;
    d.set(this.invVPScratch, o.inverseViewProj / 4);
    d.set(camera.position, o.cameraPos / 4);
    d[o.useIndirection / 4] = this.useIndirection ? 1.0 : 0.0;
    d.set(this.config.dimensions, o.datasetSize / 4);
    dv.setInt32(o.renderMode, this.getRenderModeInt(), true);
    d.set(this.config.normalizedSize, o.normalizedSize / 4);
    d[o.isoValue / 4] = this.isoValue;
    d[o.screenSize / 4] = this.computeWidth;
    d[o.screenSize / 4 + 1] = this.computeHeight;
    dv.setUint32(o.frameIndex, this.frameIndex, true);
    dv.setUint32(o.jitter, this.enableJitter ? 1 : 0, true);
    d[o.windowCenter / 4] = this.windowCenter;
    d[o.windowWidth / 4] = this.windowWidth;
    d[o.floatMin / 4] = this.floatMin;
    d[o.floatMax / 4] = this.floatMax;
    d.set(this.clipMin, o.clipMin / 4);
    d[o.densityScale / 4] = this.densityScale;
    d.set(this.clipMax, o.clipMax / 4);
    dv.setUint32(o.numChannels, this.numChannels, true);
    d.set(this.channelColors, o.channelColors / 4);
    d.set(this.channelWindowCenter, o.channelWindowCenter / 4);
    d.set(this.channelWindowWidth, o.channelWindowWidth / 4);
    this.device.queue.writeBuffer(this.computeUniformBuffer, 0, d as Float32Array<ArrayBuffer>);

    const encoder = this.device.createCommandEncoder();
    const workgroupsX = Math.ceil(this.computeWidth / 8);
    const workgroupsY = Math.ceil(this.computeHeight / 8);

    if (this.volumeRenderMode !== 'slice') {
      // Normal volume compute path
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(this.computePipeline);
      computePass.setBindGroup(0, this.computeBindGroup);
      computePass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
      computePass.end();

      // Temporal accumulation pass
      if (this.enableTAA) {
        const weight = 1.0 / (this.accumFrameCount + 1);
        this.accumScratch[0] = this.computeWidth;
        this.accumScratch[1] = this.computeHeight;
        this.accumScratch[2] = weight;
        this.device.queue.writeBuffer(this.accumUniformBuffer, 0, this.accumScratch as Float32Array<ArrayBuffer>);

        const accumPass = encoder.beginComputePass();
        accumPass.setPipeline(this.accumPipeline);
        accumPass.setBindGroup(0, this.accumBindGroups[this.accumIndex]);
        accumPass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
        accumPass.end();
      }

      // Blit result to screen
      this.blitBindGroup = this.enableTAA ? this.blitBindGroups[this.accumIndex]! : this.directBlitBindGroup;
      const blitPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: colorView,
          clearValue: [0.05, 0.05, 0.05, 1],
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      blitPass.setPipeline(this.blitPipeline);
      blitPass.setBindGroup(0, this.blitBindGroup);
      blitPass.draw(3);
      blitPass.end();

      // Advance accumulation state (cap at 64 — diminishing returns beyond that)
      if (this.enableTAA) {
        this.accumIndex = 1 - this.accumIndex as 0 | 1;
        if (this.accumFrameCount < 64) {
          this.accumFrameCount++;
        }
      }
    }

    // Update uniforms for overlay pass
    this.device.queue.writeBuffer(this.wireframeUniformBuffer, 0, vp as Float32Array<ArrayBuffer>);
    if (this.volumeRenderMode === 'slice') {
      this.updateSliceUniforms(vp);
    }

    // In slice mode the overlay pass clears to background; otherwise it loads the blitted volume
    const overlayPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        clearValue: [0.05, 0.05, 0.05, 1],
        loadOp: this.volumeRenderMode === 'slice' ? 'clear' : 'load',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // Draw slice planes
    if (this.volumeRenderMode === 'slice' && this.sliceBindGroup) {
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
  }
}
