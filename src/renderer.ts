/**
 * Volume Renderer using proxy box geometry
 */

import { Camera } from './camera.js';
import { VolumeCanvas, createVolumeCanvas, writeToCanvas } from './volume.js';
import { createBox, createAxis } from './geometry.js';
import { createTransferFunction } from './transfer-function.js';
import { IndirectionTable } from './indirection.js';
import { AtlasAllocator, AtlasSlot } from './atlas-allocator.js';
import { volumeShader, wireframeShader, axisShader, computeShader, blitShader } from './shaders.js';
import { BRICK_SIZE, DATASET_SIZE, NORMALIZED_SIZE } from './config.js';

export type RenderMode = 'fragment' | 'compute';

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

  // Rendering mode: 'fragment' (proxy box) or 'compute' (compute shader)
  renderMode: RenderMode = 'compute';

  // Fragment-based pipelines
  private volumePipeline: GPURenderPipeline;
  private wireframePipeline: GPURenderPipeline;
  private axisPipeline: GPURenderPipeline;

  // Compute-based pipeline
  private computePipeline: GPUComputePipeline;
  private blitPipeline: GPURenderPipeline;
  private computeBindGroup: GPUBindGroup;
  private blitBindGroup: GPUBindGroup;
  private computeUniformBuffer: GPUBuffer;
  private computeOutputTexture: GPUTexture;
  private computeOutputView: GPUTextureView;

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
  private indirectionSampler: GPUSampler;
  private blitSampler: GPUSampler;
  private tfTexture: GPUTexture;

  // Counts
  private indexCount: number;
  private wireframeIndexCount: number;

  // Screen size for compute shader
  private screenWidth = 1;
  private screenHeight = 1;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;

    // Create volume canvas (empty)
    this.canvas = createVolumeCanvas(device);

    // Create indirection table for virtual texturing
    this.indirection = new IndirectionTable(device);

    // Create atlas allocator
    this.allocator = new AtlasAllocator();

    // Create geometry (normalized proxy based on dataset aspect ratio)
    const box = createBox(NORMALIZED_SIZE);

    this.vertexBuffer = device.createBuffer({
      size: box.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, box.vertices);

    this.indexBuffer = device.createBuffer({
      size: box.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, box.indices);
    this.indexCount = box.indices.length;

    this.wireframeIndexBuffer = device.createBuffer({
      size: box.wireframeIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.wireframeIndexBuffer, 0, box.wireframeIndices);
    this.wireframeIndexCount = box.wireframeIndices.length;

    // Create axis geometry (slightly larger than normalized proxy for visibility)
    const axis = createAxis(0.6);
    this.axisVertexBuffer = device.createBuffer({
      size: axis.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.axisVertexBuffer, 0, axis.vertices);

    // Create uniform buffers
    // Volume: mat4 mvp (64) + mat4 inverseModel (64) + vec3 cameraPos (12) + useIndirection (4)
    //       + vec3 datasetSize (12) + pad (4) + vec3 normalizedSize (12) + pad (4) = 176
    this.uniformBuffer = device.createBuffer({
      size: 176,
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

    // Create transfer function
    this.tfTexture = createTransferFunction(device);

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

    // Indirection sampler (nearest for discrete brick lookups)
    this.indirectionSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
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

    // Create bind groups
    this.volumeBindGroup = device.createBindGroup({
      layout: this.volumePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.volumeSampler },
        { binding: 2, resource: this.canvas.texture.createView() },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 5, resource: this.indirectionSampler },
        { binding: 6, resource: this.indirection.texture.createView() },
      ],
    });

    this.wireframeBindGroup = device.createBindGroup({
      layout: this.wireframePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.wireframeUniformBuffer } }],
    });

    this.axisBindGroup = device.createBindGroup({
      layout: this.axisPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.axisUniformBuffer } }],
    });

    // ===== Compute shader pipeline =====

    // Compute uniform buffer: mat4 inverseViewProj (64) + vec3 cameraPos (12) + useIndirection (4)
    //                       + vec3 datasetSize (12) + pad (4) + vec3 normalizedSize (12) + pad (4)
    //                       + vec2 screenSize (8) + pad (8) = 128
    this.computeUniformBuffer = device.createBuffer({
      size: 128,
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

    // Compute bind group (will be recreated on resize)
    this.computeBindGroup = device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: this.volumeSampler },
        { binding: 2, resource: this.canvas.texture.createView() },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 5, resource: this.indirectionSampler },
        { binding: 6, resource: this.indirection.texture.createView() },
        { binding: 7, resource: this.computeOutputView },
      ],
    });

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
    const slot = this.allocator.allocate();
    if (!slot) {
      console.warn('Atlas full, cannot load brick');
      return null;
    }

    // Write brick data to atlas
    const offset: [number, number, number] = [
      slot.x * BRICK_SIZE,
      slot.y * BRICK_SIZE,
      slot.z * BRICK_SIZE
    ];
    writeToCanvas(this.device, this.canvas, data, [BRICK_SIZE, BRICK_SIZE, BRICK_SIZE], offset);

    // Set up indirection mapping with LOD level
    this.indirection.setBrick(virtualX, virtualY, virtualZ, slot.x, slot.y, slot.z, lod);

    return slot;
  }

  /**
   * Unload a brick from the atlas
   */
  unloadBrick(virtualX: number, virtualY: number, virtualZ: number, slot: AtlasSlot): void {
    this.indirection.clearBrick(virtualX, virtualY, virtualZ);
    this.allocator.free(slot);
  }

  /**
   * Clear all bricks from atlas
   */
  clearAllBricks(): void {
    this.indirection.clearAll();
    this.allocator.reset();
  }

  resize(width: number, height: number) {
    this.screenWidth = width;
    this.screenHeight = height;

    // Resize depth texture
    this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();

    // Resize compute output texture
    this.computeOutputTexture.destroy();
    this.computeOutputTexture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.computeOutputView = this.computeOutputTexture.createView();

    // Recreate compute bind group with new output texture
    this.recreateComputeBindGroups();
  }

  private recreateComputeBindGroups() {
    this.computeBindGroup = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: this.volumeSampler },
        { binding: 2, resource: this.canvas.texture.createView() },
        { binding: 3, resource: this.tfSampler },
        { binding: 4, resource: this.tfTexture.createView() },
        { binding: 5, resource: this.indirectionSampler },
        { binding: 6, resource: this.indirection.texture.createView() },
        { binding: 7, resource: this.computeOutputView },
      ],
    });

    this.blitBindGroup = this.device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.computeOutputView },
        { binding: 1, resource: this.blitSampler },
      ],
    });
  }

  render(colorView: GPUTextureView, camera: Camera) {
    const aspect = this.depthTexture.width / this.depthTexture.height;
    const view = camera.getViewMatrix();
    const proj = camera.getProjectionMatrix(aspect);
    const vp = multiplyMatrices(proj, view);

    if (this.renderMode === 'compute') {
      this.renderCompute(colorView, camera, vp);
    } else {
      this.renderFragment(colorView, camera, vp);
    }
  }

  private renderFragment(colorView: GPUTextureView, camera: Camera, vp: Float32Array) {
    // Identity model matrix, so inverse is also identity
    const inverseModel = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);

    // Update volume uniforms
    const uniformData = new Float32Array(44);  // 176 bytes / 4
    uniformData.set(vp, 0);                    // 0-15: mvp (model is identity)
    uniformData.set(inverseModel, 16);         // 16-31: inverseModel
    uniformData.set(camera.position, 32);      // 32-34: cameraPos
    uniformData[35] = this.useIndirection ? 1.0 : 0.0;  // 35: useIndirection
    uniformData.set(DATASET_SIZE, 36);         // 36-38: datasetSize
    // 39: padding
    uniformData.set(NORMALIZED_SIZE, 40);      // 40-42: normalizedSize
    // 43: padding
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    // Update wireframe uniforms
    this.device.queue.writeBuffer(this.wireframeUniformBuffer, 0, vp);

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
    pass.setPipeline(this.wireframePipeline);
    pass.setBindGroup(0, this.wireframeBindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.wireframeIndexBuffer, 'uint16');
    pass.drawIndexed(this.wireframeIndexCount);

    // Draw axis
    this.device.queue.writeBuffer(this.axisUniformBuffer, 0, vp);
    pass.setPipeline(this.axisPipeline);
    pass.setBindGroup(0, this.axisBindGroup);
    pass.setVertexBuffer(0, this.axisVertexBuffer);
    pass.draw(6); // 6 vertices (2 per axis)

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private renderCompute(colorView: GPUTextureView, camera: Camera, vp: Float32Array) {
    // Compute inverse view-projection for ray generation
    const inverseViewProj = invertMatrix(vp);

    // Update compute uniforms
    // Layout: mat4 inverseViewProj (64) + vec3 cameraPos (12) + useIndirection (4)
    //       + vec3 datasetSize (12) + pad (4) + vec3 normalizedSize (12) + pad (4)
    //       + vec2 screenSize (8) + pad (8) = 128 bytes = 32 floats
    const computeUniformData = new Float32Array(32);
    computeUniformData.set(inverseViewProj, 0);           // 0-15: inverseViewProj
    computeUniformData.set(camera.position, 16);          // 16-18: cameraPos
    computeUniformData[19] = this.useIndirection ? 1.0 : 0.0;  // 19: useIndirection
    computeUniformData.set(DATASET_SIZE, 20);             // 20-22: datasetSize
    // 23: padding
    computeUniformData.set(NORMALIZED_SIZE, 24);          // 24-26: normalizedSize
    // 27: padding
    computeUniformData[28] = this.screenWidth;            // 28: screenSize.x
    computeUniformData[29] = this.screenHeight;           // 29: screenSize.y
    // 30-31: padding
    this.device.queue.writeBuffer(this.computeUniformBuffer, 0, computeUniformData);

    const encoder = this.device.createCommandEncoder();

    // Dispatch compute shader
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);
    // Workgroup size is 8x8, so dispatch ceil(width/8) x ceil(height/8)
    const workgroupsX = Math.ceil(this.screenWidth / 8);
    const workgroupsY = Math.ceil(this.screenHeight / 8);
    computePass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
    computePass.end();

    // Blit compute output to screen
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

    // Update wireframe uniforms for overlay pass
    this.device.queue.writeBuffer(this.wireframeUniformBuffer, 0, vp);

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
    overlayPass.setPipeline(this.wireframePipeline);
    overlayPass.setBindGroup(0, this.wireframeBindGroup);
    overlayPass.setVertexBuffer(0, this.vertexBuffer);
    overlayPass.setIndexBuffer(this.wireframeIndexBuffer, 'uint16');
    overlayPass.drawIndexed(this.wireframeIndexCount);

    // Draw axis
    this.device.queue.writeBuffer(this.axisUniformBuffer, 0, vp);
    overlayPass.setPipeline(this.axisPipeline);
    overlayPass.setBindGroup(0, this.axisBindGroup);
    overlayPass.setVertexBuffer(0, this.axisVertexBuffer);
    overlayPass.draw(6);

    overlayPass.end();

    this.device.queue.submit([encoder.finish()]);
  }
}

function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
  const result = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      result[j * 4 + i] =
        a[i]! * b[j * 4]! +
        a[i + 4]! * b[j * 4 + 1]! +
        a[i + 8]! * b[j * 4 + 2]! +
        a[i + 12]! * b[j * 4 + 3]!;
    }
  }
  return result;
}

function invertMatrix(m: Float32Array): Float32Array {
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
    return new Float32Array(16); // Return zero matrix if singular
  }

  det = 1.0 / det;
  return new Float32Array([
    inv0 * det, inv1 * det, inv2 * det, inv3 * det,
    inv4 * det, inv5 * det, inv6 * det, inv7 * det,
    inv8 * det, inv9 * det, inv10 * det, inv11 * det,
    inv12 * det, inv13 * det, inv14 * det, inv15 * det,
  ]);
}
