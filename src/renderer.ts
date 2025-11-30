/**
 * Volume Renderer using proxy box geometry
 */

import { Camera } from './camera.js';
import { VolumeCanvas, createVolumeCanvas, writeToCanvas } from './volume.js';
import { createBox, createAxis } from './geometry.js';
import { createTransferFunction } from './transfer-function.js';
import { IndirectionTable } from './indirection.js';
import { AtlasAllocator, AtlasSlot } from './atlas-allocator.js';
import { volumeShader, wireframeShader, axisShader } from './shaders.js';
import { BRICK_SIZE, DATASET_SIZE, NORMALIZED_SIZE } from './config.js';

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

  // Pipelines
  private volumePipeline: GPURenderPipeline;
  private wireframePipeline: GPURenderPipeline;
  private axisPipeline: GPURenderPipeline;

  // Bind groups
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

  // Counts
  private indexCount: number;
  private wireframeIndexCount: number;

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
    const tfTexture = createTransferFunction(device);

    // Create samplers
    const volumeSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    const tfSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
    });

    // Indirection sampler (nearest for discrete brick lookups)
    const indirectionSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
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
        { binding: 1, resource: volumeSampler },
        { binding: 2, resource: this.canvas.texture.createView() },
        { binding: 3, resource: tfSampler },
        { binding: 4, resource: tfTexture.createView() },
        { binding: 5, resource: indirectionSampler },
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
    this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();
  }

  render(colorView: GPUTextureView, camera: Camera) {
    const aspect = this.depthTexture.width / this.depthTexture.height;
    const view = camera.getViewMatrix();
    const proj = camera.getProjectionMatrix(aspect);
    const mvp = multiplyMatrices(proj, view);

    // Identity model matrix, so inverse is also identity
    const inverseModel = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);

    // Update volume uniforms
    const uniformData = new Float32Array(44);  // 176 bytes / 4
    uniformData.set(mvp, 0);                   // 0-15: mvp
    uniformData.set(inverseModel, 16);         // 16-31: inverseModel
    uniformData.set(camera.position, 32);      // 32-34: cameraPos
    uniformData[35] = this.useIndirection ? 1.0 : 0.0;  // 35: useIndirection
    uniformData.set(DATASET_SIZE, 36);         // 36-38: datasetSize
    // 39: padding
    uniformData.set(NORMALIZED_SIZE, 40);      // 40-42: normalizedSize
    // 43: padding
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    // Update wireframe uniforms
    this.device.queue.writeBuffer(this.wireframeUniformBuffer, 0, mvp);

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
    const vp = multiplyMatrices(proj, view);
    this.device.queue.writeBuffer(this.axisUniformBuffer, 0, vp);
    pass.setPipeline(this.axisPipeline);
    pass.setBindGroup(0, this.axisBindGroup);
    pass.setVertexBuffer(0, this.axisVertexBuffer);
    pass.draw(6); // 6 vertices (2 per axis)

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}

function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
  const result = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      result[j * 4 + i] =
        a[i] * b[j * 4] +
        a[i + 4] * b[j * 4 + 1] +
        a[i + 8] * b[j * 4 + 2] +
        a[i + 12] * b[j * 4 + 3];
    }
  }
  return result;
}
