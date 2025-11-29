/**
 * Indirection Table for Virtual Volume Texturing
 *
 * Maps virtual brick coordinates to atlas positions.
 *
 * Virtual volume is divided into bricks (BRICK_SIZE³ bricks, forming a GRID_SIZE³ grid)
 * Each entry in the indirection table tells the shader where to find that brick in the atlas.
 */

import { GRID_SIZE, DATASET_GRID } from './config.js';

export interface BrickLocation {
  // Virtual position (which brick in the logical volume)
  virtualX: number;
  virtualY: number;
  virtualZ: number;
  // Atlas position (where the brick data is stored in the atlas texture)
  atlasX: number;
  atlasY: number;
  atlasZ: number;
  // Is this brick loaded?
  loaded: boolean;
}

export class IndirectionTable {
  private device: GPUDevice;

  // CPU-side data: for each virtual brick, store atlas offset
  // Format: [offsetX, offsetY, offsetZ, loaded] as bytes (scaled by brick size)
  private data: Uint8Array;

  // GPU texture: 3D texture where each texel is the atlas offset for that brick
  texture: GPUTexture;

  // Dataset grid dimensions for indexing
  private gridX = DATASET_GRID[0];
  private gridY = DATASET_GRID[1];
  private gridZ = DATASET_GRID[2];

  constructor(device: GPUDevice) {
    this.device = device;

    // Dataset grid, 4 bytes per entry (RGBA)
    this.data = new Uint8Array(this.gridX * this.gridY * this.gridZ * 4);

    // Create 3D texture for indirection (dataset grid size, RGBA8)
    this.texture = device.createTexture({
      size: [this.gridX, this.gridY, this.gridZ],
      format: 'rgba8unorm',
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Initialize all entries as not loaded (loaded = 0)
    this.updateFullGPU();
  }

  /**
   * Register a brick mapping: virtual position -> atlas position
   * Positions are in brick units (0-GRID_SIZE-1), not voxels
   */
  setBrick(
    virtualX: number, virtualY: number, virtualZ: number,
    atlasX: number, atlasY: number, atlasZ: number
  ) {
    const idx = (virtualX + virtualY * this.gridX + virtualZ * this.gridX * this.gridY) * 4;

    // Store atlas position as brick units scaled to 0-255
    // Scale factor: 256 / GRID_SIZE to map atlas brick coords to [0,1] range
    const scale = 256 / GRID_SIZE;
    this.data[idx + 0] = atlasX * scale;
    this.data[idx + 1] = atlasY * scale;
    this.data[idx + 2] = atlasZ * scale;
    this.data[idx + 3] = 255;  // loaded = true

    this.updateBrickGPU(virtualX, virtualY, virtualZ);
  }

  /**
   * Clear a brick (mark as not loaded)
   */
  clearBrick(virtualX: number, virtualY: number, virtualZ: number) {
    const idx = (virtualX + virtualY * this.gridX + virtualZ * this.gridX * this.gridY) * 4;
    this.data[idx + 0] = 0;
    this.data[idx + 1] = 0;
    this.data[idx + 2] = 0;
    this.data[idx + 3] = 0;  // loaded = false

    this.updateBrickGPU(virtualX, virtualY, virtualZ);
  }

  /**
   * Clear all mappings
   */
  clearAll() {
    this.data.fill(0);
    this.updateFullGPU();
  }

  /**
   * Update a single brick entry on the GPU (partial update)
   */
  private updateBrickGPU(x: number, y: number, z: number) {
    const idx = (x + y * this.gridX + z * this.gridX * this.gridY) * 4;

    // Write just this single texel to the GPU
    this.device.queue.writeTexture(
      { texture: this.texture, origin: [x, y, z] },
      this.data.subarray(idx, idx + 4),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1, 1]
    );
  }

  /**
   * Update the full indirection texture on the GPU
   */
  private updateFullGPU() {
    this.device.queue.writeTexture(
      { texture: this.texture },
      this.data,
      { bytesPerRow: this.gridX * 4, rowsPerImage: this.gridY },
      [this.gridX, this.gridY, this.gridZ]
    );
  }
}
