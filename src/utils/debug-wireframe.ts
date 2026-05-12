/**
 * Debug Wireframe Renderer
 *
 * Draws wireframe boxes around octree cells to visualize LOD structure.
 * Each LOD level gets a different color.
 */

import type { DatasetConfig } from '../core/config.js';

// LOD colors (from finest to coarsest)
const LOD_COLORS: [number, number, number, number][] = [
  [1.0, 0.0, 0.0, 1.0],  // LOD 0: Red
  [1.0, 0.5, 0.0, 1.0],  // LOD 1: Orange
  [1.0, 1.0, 0.0, 1.0],  // LOD 2: Yellow
  [0.0, 1.0, 0.0, 1.0],  // LOD 3: Green
  [0.0, 1.0, 1.0, 1.0],  // LOD 4: Cyan
  [0.0, 0.0, 1.0, 1.0],  // LOD 5: Blue
  [0.5, 0.0, 0.5, 1.0],  // LOD 6: Purple
  [1.0, 0.0, 0.5, 1.0],  // LOD 7: Magenta
  [0.5, 0.5, 0.5, 1.0],  // LOD 8: Gray
  [0.3, 0.3, 0.3, 1.0],  // LOD 9: Dark Gray
  [0.8, 0.4, 0.2, 1.0],  // LOD 10: Brown
];

interface WireframeBox {
  center: [number, number, number];
  size: [number, number, number];
  color: [number, number, number, number];
}

const WIREFRAME_SHADER = /* wgsl */`
struct Uniforms {
  viewProj: mat4x4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) color: vec4f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = uniforms.viewProj * vec4f(input.position, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return input.color;
}
`;

// 12 edges of a cube, each edge is 2 vertices
const CUBE_EDGES = [
  // Bottom face
  [0, 1], [1, 2], [2, 3], [3, 0],
  // Top face
  [4, 5], [5, 6], [6, 7], [7, 4],
  // Vertical edges
  [0, 4], [1, 5], [2, 6], [3, 7],
];

// 8 vertices of a unit cube centered at origin
const CUBE_VERTICES = [
  [-0.5, -0.5, -0.5],
  [+0.5, -0.5, -0.5],
  [+0.5, +0.5, -0.5],
  [-0.5, +0.5, -0.5],
  [-0.5, -0.5, +0.5],
  [+0.5, -0.5, +0.5],
  [+0.5, +0.5, +0.5],
  [-0.5, +0.5, +0.5],
];

export class DebugWireframe {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private uniformBindGroup: GPUBindGroup;
  private vertexBuffer: GPUBuffer | null = null;
  private vertexCount: number = 0;
  private maxVertices: number = 100000;  // Max vertices we can store

  private config: DatasetConfig;

  enabled: boolean = true;

  constructor(device: GPUDevice, format: GPUTextureFormat, config: DatasetConfig) {
    this.device = device;
    this.config = config;

    // Create shader module
    const shaderModule = device.createShaderModule({
      code: WIREFRAME_SHADER,
    });

    // Create uniform buffer for view-projection matrix
    this.uniformBuffer = device.createBuffer({
      size: 64,  // mat4x4f
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group layout and bind group
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      }],
    });

    this.uniformBindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{
        binding: 0,
        resource: { buffer: this.uniformBuffer },
      }],
    });

    // Create pipeline
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 28,  // 3 floats position + 4 floats color
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
            { shaderLocation: 1, offset: 12, format: 'float32x4' },  // color
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: {
        topology: 'line-list',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,  // Don't write to depth
        depthCompare: 'less',
      },
    });
  }

  /**
   * Update wireframe boxes from streaming manager state
   */
  updateFromStreamingManager(
    streamingManager: { getActiveLeaves(): Array<{ node: { lod: number; bx: number; by: number; bz: number } }> },
    maxLod: number
  ): void {
    const boxes: WireframeBox[] = [];
    const normalizedSize = this.config.normalizedSize;

    for (const rb of streamingManager.getActiveLeaves()) {
      const node = rb.node;
      const bricksPerAxis = Math.pow(2, maxLod - node.lod);

      const brickSize: [number, number, number] = [
        normalizedSize[0] / bricksPerAxis,
        normalizedSize[1] / bricksPerAxis,
        normalizedSize[2] / bricksPerAxis,
      ];

      const center: [number, number, number] = [
        -normalizedSize[0] * 0.5 + (node.bx + 0.5) * brickSize[0],
        -normalizedSize[1] * 0.5 + (node.by + 0.5) * brickSize[1],
        -normalizedSize[2] * 0.5 + (node.bz + 0.5) * brickSize[2],
      ];

      const color = LOD_COLORS[node.lod] || LOD_COLORS[LOD_COLORS.length - 1]!;

      boxes.push({ center, size: brickSize, color });
    }

    this.setBoxes(boxes);
  }

  /**
   * Set boxes to render
   */
  setBoxes(boxes: WireframeBox[]): void {
    // Each box has 12 edges, each edge has 2 vertices
    const verticesPerBox = 12 * 2;
    const floatsPerVertex = 7;  // xyz + rgba
    const totalVertices = boxes.length * verticesPerBox;

    if (totalVertices > this.maxVertices) {
      console.warn(`DebugWireframe: too many vertices (${totalVertices} > ${this.maxVertices})`);
    }

    const vertexData = new Float32Array(Math.min(totalVertices, this.maxVertices) * floatsPerVertex);
    let offset = 0;

    for (const box of boxes) {
      if (offset >= this.maxVertices * floatsPerVertex) break;

      for (const edge of CUBE_EDGES) {
        const v0 = CUBE_VERTICES[edge[0]!]!;
        const v1 = CUBE_VERTICES[edge[1]!]!;

        // Transform unit cube vertex to box space
        // Vertex 0
        vertexData[offset++] = box.center[0] + v0[0]! * box.size[0];
        vertexData[offset++] = box.center[1] + v0[1]! * box.size[1];
        vertexData[offset++] = box.center[2] + v0[2]! * box.size[2];
        vertexData[offset++] = box.color[0];
        vertexData[offset++] = box.color[1];
        vertexData[offset++] = box.color[2];
        vertexData[offset++] = box.color[3];

        // Vertex 1
        vertexData[offset++] = box.center[0] + v1[0]! * box.size[0];
        vertexData[offset++] = box.center[1] + v1[1]! * box.size[1];
        vertexData[offset++] = box.center[2] + v1[2]! * box.size[2];
        vertexData[offset++] = box.color[0];
        vertexData[offset++] = box.color[1];
        vertexData[offset++] = box.color[2];
        vertexData[offset++] = box.color[3];
      }
    }

    this.vertexCount = offset / floatsPerVertex;

    // Create or update vertex buffer
    const bufferSize = vertexData.byteLength;
    if (!this.vertexBuffer || this.vertexBuffer.size < bufferSize) {
      if (this.vertexBuffer) {
        this.vertexBuffer.destroy();
      }
      this.vertexBuffer = this.device.createBuffer({
        size: Math.max(bufferSize, 1024),  // Minimum size
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    if (bufferSize > 0) {
      this.device.queue.writeBuffer(this.vertexBuffer, 0, vertexData);
    }
  }

  /**
   * Render wireframes
   */
  render(
    encoder: GPUCommandEncoder,
    colorView: GPUTextureView,
    depthView: GPUTextureView,
    viewProjMatrix: Float32Array
  ): void {
    if (!this.enabled || !this.vertexBuffer || this.vertexCount === 0) {
      return;
    }

    // Update uniform buffer
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProjMatrix as Float32Array<ArrayBuffer>);

    // Create render pass
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorView,
        loadOp: 'load',  // Don't clear - render on top
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.uniformBindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(this.vertexCount);
    pass.end();
  }
}
