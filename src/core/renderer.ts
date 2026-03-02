/**
 * Volume Renderer using proxy box geometry
 */

import { Camera } from './camera.js';
import { VolumeCanvas, createVolumeCanvas, writeToCanvas } from './volume.js';
import { createBox, createAxis } from '../utils/geometry.js';
import { TransferFunction } from './transfer-function.js';
import { IndirectionTable } from './indirection.js';
import { AtlasAllocator, AtlasSlot } from '../streaming/atlas-allocator.js';
import { volumeShader, wireframeShader, axisShader, computeShader, blitShader, accumulateShader } from '../shaders/index.js';
import { getDatasetSize, getNormalizedSize } from './config.js';
import type { BitDepth } from '../data/data-provider.js';

export type RenderMode = 'fragment' | 'compute';

// Volume render mode (shader-side)
export type VolumeRenderMode = 'dvr' | 'mip' | 'iso' | 'lod';

export class Renderer {
  private device: GPUDevice;

  // Volume canvas (atlas texture)
  canvas: VolumeCanvas;

  // Indirection table for virtual texturing
  indirection: IndirectionTable;

  // Atlas slot allocator
  allocator: AtlasAllocator;

  // Debug: toggle indirection on/off
  useIndirection = true;

  // Show wireframe box
  showWireframe = false;

  // Show axis helper
  showAxis = false;

  // Rendering mode: 'fragment' (proxy box) or 'compute' (compute shader)
  renderMode: RenderMode = 'compute';

  // Volume render mode: dvr, mip, or iso
  volumeRenderMode: VolumeRenderMode = 'dvr';

  // ISO surface threshold (0-1)
  isoValue = 0.2;

  // Windowing/Leveling for 16-bit data (0-1 normalized range)
  // windowCenter: center of the display window (default 0.5 = middle of range)
  // windowWidth: width of the display window (default 1.0 = full range)
  windowCenter = 0.5;
  windowWidth = 1.0;

  // Axis-aligned clipping planes (0-1 normalized range)
  clipMin = new Float32Array([0, 0, 0]);
  clipMax = new Float32Array([1, 1, 1]);

  // Render scale for compute shader (0.25–1.0, lower = faster but blurrier)
  renderScale = 0.5;

  // Fragment-based pipelines
  private volumePipeline: GPURenderPipeline;
  private wireframePipeline: GPURenderPipeline;
  private axisPipeline: GPURenderPipeline;

  // Compute-based pipeline
  private computePipeline: GPUComputePipeline;
  private blitPipeline: GPURenderPipeline;
  private computeBindGroup: GPUBindGroup;
  private blitBindGroup: GPUBindGroup; // active blit bind group (set per-frame from blitBindGroups)
  private blitBindGroups: [GPUBindGroup, GPUBindGroup] = null!; // one per accum texture
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

  // Fragment bind groups
  private volumeBindGroup: GPUBindGroup;
  private wireframeBindGroup: GPUBindGroup;
  private axisBindGroup: GPUBindGroup;

  // Buffers
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;
  private wireframeIndexBuffer: GPUBuffer;
  private uniformBuffer: GPUBuffer;
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
  private indexCount: number;
  private wireframeIndexCount: number;

  // Screen size (full resolution)
  private screenWidth = 1;
  private screenHeight = 1;

  // Compute texture size (may be lower than screen when renderScale < 1)
  private computeWidth = 1;
  private computeHeight = 1;

  // Frame counter for temporal jitter
  private frameIndex = 0;

  // Pre-allocated scratch buffers (avoid per-frame GC pressure)
  private readonly vpScratch = new Float32Array(16);
  private readonly invVPScratch = new Float32Array(16);
  private readonly fragUniformScratch = new Float32Array(60);
  private readonly fragUniformView = new DataView(this.fragUniformScratch.buffer);
  private readonly computeUniformScratch = new Float32Array(48);
  private readonly computeUniformView = new DataView(this.computeUniformScratch.buffer);
  private readonly accumScratch = new Float32Array(4);
  private static readonly IDENTITY_MAT4 = new Float32Array([
    1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1,
  ]);

  constructor(device: GPUDevice, format: GPUTextureFormat, bitDepth: BitDepth, textureFormat: GPUTextureFormat) {
    this.device = device;

    // Create volume canvas (empty) with specified bit depth and format
    this.canvas = createVolumeCanvas(device, bitDepth, textureFormat);

    // Create indirection table for virtual texturing
    this.indirection = new IndirectionTable(device);

    // Create atlas allocator
    this.allocator = new AtlasAllocator();

    // Create geometry (normalized proxy based on dataset aspect ratio)
    const box = createBox();

    this.vertexBuffer = device.createBuffer({
      size: box.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, box.vertices as Float32Array<ArrayBuffer>);

    this.indexBuffer = device.createBuffer({
      size: box.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, box.indices as Uint16Array<ArrayBuffer>);
    this.indexCount = box.indices.length;

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

    // Create uniform buffers
    // Volume: mat4 mvp (64) + mat4 inverseModel (64) + vec3 cameraPos (12) + useIndirection (4)
    //       + vec3 datasetSize (12) + renderMode (4) + vec3 normalizedSize (12) + isoValue (4)
    //       + frameIndex (4) + pad (4) + windowCenter (4) + windowWidth (4) + pad2 vec2 (8)
    //       + clipMin vec3 (12) + pad3 (4) + clipMax vec3 (12) + pad4 (4) = 240 bytes
    this.uniformBuffer = device.createBuffer({
      size: 240,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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

    // Volume pipeline
    const volumeModule = device.createShaderModule({ code: volumeShader });
    this.volumePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: volumeModule, entryPoint: 'vs', buffers: [vertexLayout] },
      fragment: {
        module: volumeModule,
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

    // Wireframe and axis bind groups (don't depend on TF)
    this.wireframeBindGroup = device.createBindGroup({
      layout: this.wireframePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.wireframeUniformBuffer } }],
    });

    this.axisBindGroup = device.createBindGroup({
      layout: this.axisPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.axisUniformBuffer } }],
    });

    // Volume bind group will be created when TF is set
    this.volumeBindGroup = null!;

    // ===== Compute shader pipeline =====

    // Compute uniform buffer: mat4 inverseViewProj (64) + vec3 cameraPos (12) + useIndirection (4)
    //                       + vec3 datasetSize (12) + renderMode (4) + vec3 normalizedSize (12) + isoValue (4)
    //                       + vec2 screenSize (8) + frameIndex (4) + pad3 (4) + windowCenter (4) + windowWidth (4)
    //                       + pad4 vec2 (8) + clipMin vec3 (12) + pad5 (4) + clipMax vec3 (12) + pad6 (4) = 192 bytes
    this.computeUniformBuffer = device.createBuffer({
      size: 192,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Output texture (will be resized)
    this.computeOutputTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
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
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.accumTextures = [dummyTex(), dummyTex()];
    this.accumViews = [this.accumTextures[0].createView(), this.accumTextures[1].createView()];
    this.accumBindGroups = [null!, null!];
  }

  /**
   * Load a brick into the atlas at the next available slot
   * @param virtualX, virtualY, virtualZ - Virtual brick position in the dataset grid
   * @param data - Brick voxel data (BRICK_SIZE³)
   * @param lod - LOD level (0 = full res, 1 = 2x downsample, 2 = 4x, 3 = 8x)
   * Returns the atlas slot used, or null if atlas is full
   */
  loadBrick(
    virtualX: number, virtualY: number, virtualZ: number,
    data: Uint8Array,
    lod: number = 0
  ): AtlasSlot | null {
    const result = this.allocator.allocate();
    if (!result) {
      console.warn('Atlas full, cannot load brick');
      return null;
    }

    const slot = result.slot;

    // Write brick data to atlas
    const offset: [number, number, number] = [
      slot.x * 66, // Use PHYSICAL_BRICK_SIZE
      slot.y * 66,
      slot.z * 66
    ];
    writeToCanvas(this.device, this.canvas, data, [66, 66, 66], offset);

    // Set up indirection mapping with LOD level
    this.indirection.setBrick(virtualX, virtualY, virtualZ, slot.x, slot.y, slot.z, lod);

    return slot;
  }

  /**
   * Unload a brick from the atlas
   * @param lod - LOD level of the brick being unloaded
   * @param fallbackAtlas - Optional atlas position to fall back to (parent brick)
   * @param fallbackLod - Optional LOD of fallback brick
   */
  unloadBrick(
    virtualX: number, virtualY: number, virtualZ: number,
    slot: AtlasSlot,
    lod: number = 0,
    fallbackAtlas?: [number, number, number],
    fallbackLod?: number
  ): void {
    this.indirection.clearBrick(virtualX, virtualY, virtualZ, lod, fallbackAtlas, fallbackLod);
    this.allocator.free(slot);
  }

  /**
   * Clear all bricks from atlas
   */
  clearAllBricks(): void {
    this.indirection.clearAll();
    this.allocator.reset();
  }

  /** Reset temporal accumulation (call when rendering parameters change) */
  resetAccumulation(): void {
    this.accumFrameCount = 0;
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

    this.volumeBindGroup = this.device.createBindGroup({
      layout: this.volumePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.volumeSampler },
        { binding: 2, resource: this.canvas.texture.createView() },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 6, resource: this.indirection.texture.createView() },
      ],
    });

    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: this.volumeSampler },
        { binding: 2, resource: this.canvas.texture.createView() },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 6, resource: this.indirection.texture.createView() },
        { binding: 7, resource: this.computeOutputView },
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
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.computeOutputView = this.computeOutputTexture.createView();

    // Resize accumulation textures
    for (const tex of this.accumTextures) tex.destroy();
    const size: [number, number] = [this.computeWidth, this.computeHeight];
    const accumUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.accumTextures = [
      this.device.createTexture({ size, format: 'rgba8unorm', usage: accumUsage }),
      this.device.createTexture({ size, format: 'rgba8unorm', usage: accumUsage }),
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
        { binding: 2, resource: this.canvas.texture.createView() },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 6, resource: this.indirection.texture.createView() },
        { binding: 7, resource: this.computeOutputView },
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

    // Blit bind groups: one per accumulation texture
    const blitLayout = this.blitPipeline.getBindGroupLayout(0);
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

  render(colorView: GPUTextureView, camera: Camera) {
    const aspect = this.depthTexture.width / this.depthTexture.height;
    const view = camera.getViewMatrix();
    const proj = camera.getProjectionMatrix(aspect);
    multiplyMatrices(proj, view, this.vpScratch);

    if (this.renderMode === 'compute') {
      this.renderCompute(colorView, camera, this.vpScratch);
    } else {
      this.renderFragment(colorView, camera, this.vpScratch);
    }

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

  private renderFragment(colorView: GPUTextureView, camera: Camera, vp: Float32Array) {
    // Update volume uniforms (reuse pre-allocated scratch buffer)
    // Layout: mat4 mvp (64) + mat4 inverseModel (64) + vec3 cameraPos (12) + useIndirection (4)
    //       + vec3 datasetSize (12) + renderMode (4) + vec3 normalizedSize (12) + isoValue (4)
    //       + frameIndex (4) + pad (4) + windowCenter (4) + windowWidth (4) = 208 bytes
    const d = this.fragUniformScratch;
    const dv = this.fragUniformView;
    d.set(vp, 0);                              // 0-15: mvp (model is identity)
    d.set(Renderer.IDENTITY_MAT4, 16);         // 16-31: inverseModel
    d.set(camera.position, 32);                // 32-34: cameraPos
    d[35] = this.useIndirection ? 1.0 : 0.0;  // 35: useIndirection
    d.set(getDatasetSize(), 36);               // 36-38: datasetSize
    dv.setInt32(39 * 4, this.getRenderModeInt(), true);  // 39: renderMode (i32)
    d.set(getNormalizedSize(), 40);            // 40-42: normalizedSize
    d[43] = this.isoValue;                     // 43: isoValue
    dv.setUint32(44 * 4, this.frameIndex, true);  // 44: frameIndex (u32)
    // 45: _pad1
    d[46] = this.windowCenter;                 // 46: windowCenter
    d[47] = this.windowWidth;                  // 47: windowWidth
    // 48-49: _pad2 (vec2f for alignment)
    d.set(this.clipMin, 50);                   // 50-52: clipMin
    // 53: _pad3
    d.set(this.clipMax, 54);                   // 54-56: clipMax (actually only uses 54-55, implicit padding after)
    this.device.queue.writeBuffer(this.uniformBuffer, 0, d as Float32Array<ArrayBuffer>);

    // Update wireframe uniforms
    this.device.queue.writeBuffer(this.wireframeUniformBuffer, 0, vp as Float32Array<ArrayBuffer>);

    // Render
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
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
        depthStoreOp: 'store',
      },
    });

    // Draw volume
    pass.setPipeline(this.volumePipeline);
    pass.setBindGroup(0, this.volumeBindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
    pass.drawIndexed(this.indexCount);

    // Draw wireframe
    if (this.showWireframe) {
      pass.setPipeline(this.wireframePipeline);
      pass.setBindGroup(0, this.wireframeBindGroup);
      pass.setVertexBuffer(0, this.vertexBuffer);
      pass.setIndexBuffer(this.wireframeIndexBuffer, 'uint16');
      pass.drawIndexed(this.wireframeIndexCount);
    }

    // Draw axis
    if (this.showAxis) {
      this.device.queue.writeBuffer(this.axisUniformBuffer, 0, vp as Float32Array<ArrayBuffer>);
      pass.setPipeline(this.axisPipeline);
      pass.setBindGroup(0, this.axisBindGroup);
      pass.setVertexBuffer(0, this.axisVertexBuffer);
      pass.draw(6); // 6 vertices (2 per axis)
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
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
    multiplyMatrices(proj, view, out);
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
    invertMatrix(vp, this.invVPScratch);

    // Update compute uniforms (reuse pre-allocated scratch buffer)
    // Layout: mat4 inverseViewProj (64) + vec3 cameraPos (12) + useIndirection (4)
    //       + vec3 datasetSize (12) + renderMode (4) + vec3 normalizedSize (12) + isoValue (4)
    //       + vec2 screenSize (8) + frameIndex (4) + pad (4) + windowCenter (4) + windowWidth (4) = 136 bytes = 34 floats
    const d = this.computeUniformScratch;
    const dv = this.computeUniformView;
    d.set(this.invVPScratch, 0);               // 0-15: inverseViewProj
    d.set(camera.position, 16);                // 16-18: cameraPos
    d[19] = this.useIndirection ? 1.0 : 0.0;  // 19: useIndirection
    d.set(getDatasetSize(), 20);               // 20-22: datasetSize
    dv.setInt32(23 * 4, this.getRenderModeInt(), true);  // 23: renderMode (i32)
    d.set(getNormalizedSize(), 24);            // 24-26: normalizedSize
    d[27] = this.isoValue;                     // 27: isoValue
    d[28] = this.computeWidth;                 // 28: screenSize.x
    d[29] = this.computeHeight;                // 29: screenSize.y
    dv.setUint32(30 * 4, this.frameIndex, true);  // 30: frameIndex (u32)
    // 31: _pad3
    d[32] = this.windowCenter;                 // 32: windowCenter
    d[33] = this.windowWidth;                  // 33: windowWidth
    // 34-35: _pad4 (vec2f for alignment)
    d.set(this.clipMin, 36);                   // 36-38: clipMin
    // 39: _pad5
    d.set(this.clipMax, 40);                   // 40-42: clipMax
    // 43: _pad6
    this.device.queue.writeBuffer(this.computeUniformBuffer, 0, d as Float32Array<ArrayBuffer>);

    const encoder = this.device.createCommandEncoder();

    // Dispatch compute shader
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);
    // Workgroup size is 8x8, dispatch over compute texture (may be < screen)
    const workgroupsX = Math.ceil(this.computeWidth / 8);
    const workgroupsY = Math.ceil(this.computeHeight / 8);
    computePass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
    computePass.end();

    // Temporal accumulation pass
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

    // Blit accumulated result to screen (read from texture we just wrote)
    this.blitBindGroup = this.blitBindGroups[this.accumIndex]!;
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
    blitPass.draw(3); // Fullscreen triangle

    blitPass.end();

    // Advance accumulation state (cap at 64 — diminishing returns beyond that)
    this.accumIndex = 1 - this.accumIndex as 0 | 1;
    if (this.accumFrameCount < 64) {
      this.accumFrameCount++;
    }

    // Update wireframe uniforms for overlay pass
    this.device.queue.writeBuffer(this.wireframeUniformBuffer, 0, vp as Float32Array<ArrayBuffer>);

    // Separate pass for wireframe and axis with depth
    const overlayPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        loadOp: 'load',  // Keep the blitted volume
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

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

function multiplyMatrices(a: Float32Array, b: Float32Array, out: Float32Array): void {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] =
        a[i]! * b[j * 4]! +
        a[i + 4]! * b[j * 4 + 1]! +
        a[i + 8]! * b[j * 4 + 2]! +
        a[i + 12]! * b[j * 4 + 3]!;
    }
  }
}

function invertMatrix(m: Float32Array, out: Float32Array): void {
  // Use explicit indexing to avoid TS strict mode issues
  const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m3 = m[3]!;
  const m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m7 = m[7]!;
  const m8 = m[8]!, m9 = m[9]!, m10 = m[10]!, m11 = m[11]!;
  const m12 = m[12]!, m13 = m[13]!, m14 = m[14]!, m15 = m[15]!;

  const inv0 = m5 * m10 * m15 - m5 * m11 * m14 - m9 * m6 * m15 +
               m9 * m7 * m14 + m13 * m6 * m11 - m13 * m7 * m10;
  const inv4 = -m4 * m10 * m15 + m4 * m11 * m14 + m8 * m6 * m15 -
               m8 * m7 * m14 - m12 * m6 * m11 + m12 * m7 * m10;
  const inv8 = m4 * m9 * m15 - m4 * m11 * m13 - m8 * m5 * m15 +
               m8 * m7 * m13 + m12 * m5 * m11 - m12 * m7 * m9;
  const inv12 = -m4 * m9 * m14 + m4 * m10 * m13 + m8 * m5 * m14 -
                m8 * m6 * m13 - m12 * m5 * m10 + m12 * m6 * m9;

  const inv1 = -m1 * m10 * m15 + m1 * m11 * m14 + m9 * m2 * m15 -
               m9 * m3 * m14 - m13 * m2 * m11 + m13 * m3 * m10;
  const inv5 = m0 * m10 * m15 - m0 * m11 * m14 - m8 * m2 * m15 +
               m8 * m3 * m14 + m12 * m2 * m11 - m12 * m3 * m10;
  const inv9 = -m0 * m9 * m15 + m0 * m11 * m13 + m8 * m1 * m15 -
               m8 * m3 * m13 - m12 * m1 * m11 + m12 * m3 * m9;
  const inv13 = m0 * m9 * m14 - m0 * m10 * m13 - m8 * m1 * m14 +
                m8 * m2 * m13 + m12 * m1 * m10 - m12 * m2 * m9;

  const inv2 = m1 * m6 * m15 - m1 * m7 * m14 - m5 * m2 * m15 +
               m5 * m3 * m14 + m13 * m2 * m7 - m13 * m3 * m6;
  const inv6 = -m0 * m6 * m15 + m0 * m7 * m14 + m4 * m2 * m15 -
               m4 * m3 * m14 - m12 * m2 * m7 + m12 * m3 * m6;
  const inv10 = m0 * m5 * m15 - m0 * m7 * m13 - m4 * m1 * m15 +
                m4 * m3 * m13 + m12 * m1 * m7 - m12 * m3 * m5;
  const inv14 = -m0 * m5 * m14 + m0 * m6 * m13 + m4 * m1 * m14 -
                m4 * m2 * m13 - m12 * m1 * m6 + m12 * m2 * m5;

  const inv3 = -m1 * m6 * m11 + m1 * m7 * m10 + m5 * m2 * m11 -
               m5 * m3 * m10 - m9 * m2 * m7 + m9 * m3 * m6;
  const inv7 = m0 * m6 * m11 - m0 * m7 * m10 - m4 * m2 * m11 +
               m4 * m3 * m10 + m8 * m2 * m7 - m8 * m3 * m6;
  const inv11 = -m0 * m5 * m11 + m0 * m7 * m9 + m4 * m1 * m11 -
                m4 * m3 * m9 - m8 * m1 * m7 + m8 * m3 * m5;
  const inv15 = m0 * m5 * m10 - m0 * m6 * m9 - m4 * m1 * m10 +
                m4 * m2 * m9 + m8 * m1 * m6 - m8 * m2 * m5;

  let det = m0 * inv0 + m1 * inv4 + m2 * inv8 + m3 * inv12;
  if (det === 0) {
    out.fill(0);
    return;
  }

  det = 1.0 / det;
  out[0] = inv0 * det;  out[1] = inv1 * det;  out[2] = inv2 * det;  out[3] = inv3 * det;
  out[4] = inv4 * det;  out[5] = inv5 * det;  out[6] = inv6 * det;  out[7] = inv7 * det;
  out[8] = inv8 * det;  out[9] = inv9 * det;  out[10] = inv10 * det; out[11] = inv11 * det;
  out[12] = inv12 * det; out[13] = inv13 * det; out[14] = inv14 * det; out[15] = inv15 * det;
}
