/**
 * Volume Renderer using proxy box geometry
 */

import { mat4 } from 'wgpu-matrix';
import { Camera } from './camera.js';
import { createBox, createAxis } from '../utils/geometry.js';
import { TransferFunction } from './transfer-function.js';
import { VolumeResources } from './volume-resources.js';
import { wireframeShader, axisShader, computeShader, blitShader, accumulateShader, slicePlanesShader } from '../shaders/index.js';
import { COMPUTE_UNIFORMS, SLICE_UNIFORMS } from '../shaders/uniform-layout.js';
import type { DatasetConfig } from './config.js';

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
  private computeUniformBuffer: GPUBuffer;

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

  constructor(device: GPUDevice, format: GPUTextureFormat, resources: VolumeResources, config: DatasetConfig) {
    this.device = device;
    this.config = config;
    this.resources = resources;

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

    // Compute pipeline
    const computeModule = device.createShaderModule({ code: computeShader });
    this.computePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: computeModule, entryPoint: 'main' },
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
      ],
    });

    // rebuild bind groups for all pre-allocated scale sets
    for (const set of this.scaleSets.values()) {
      this.rebuildScaleSetBindGroups(set);
    }
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

    // rebuild all pre-allocated scale sets at new screen size
    const scales = [...this.scaleSets.keys()];
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
    dv.setUint32(o.lodDebug, this.volumeRenderMode === 'slice-lod' ? 1 : 0, true);
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
      for (const set of this.scaleSets.values()) set.accumFrameCount = 0;
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
    d[o.screenSize / 4] = this.active.width;
    d[o.screenSize / 4 + 1] = this.active.height;
    dv.setUint32(o.frameIndex, this.frameIndex, true);
    dv.setUint32(o.jitter, (this.enableJitter && this.enableTAA) ? 1 : 0, true);
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
    const workgroupsX = Math.ceil(this.active.width / 8);
    const workgroupsY = Math.ceil(this.active.height / 8);

    if (!this.isSliceMode) {
      // Normal volume compute path
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(this.computePipeline);
      computePass.setBindGroup(0, this.active.computeBindGroup);
      computePass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
      computePass.end();

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
  }
}
