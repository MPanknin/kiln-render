/**
 * Indirection Table for Virtual Volume Texturing
 *
 * Maps virtual brick coordinates to atlas positions.
 *
 * Virtual volume is divided into bricks (e.g., 64³ bricks in a 512³ volume = 8x8x8 brick grid)
 * Each entry in the indirection table tells the shader where to find that brick in the atlas.
 */

export const BRICK_SIZE = 64;  // Each brick is 64³
export const GRID_SIZE = 8;    // 512 / 64 = 8 bricks per dimension
export const ATLAS_SIZE = 512;

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

  constructor(device: GPUDevice) {
    this.device = device;

    // 8x8x8 grid, 4 bytes per entry (RGBA)
    this.data = new Uint8Array(GRID_SIZE * GRID_SIZE * GRID_SIZE * 4);

    // Create 3D texture for indirection (8x8x8, RGBA8)
    this.texture = device.createTexture({
      size: [GRID_SIZE, GRID_SIZE, GRID_SIZE],
      format: 'rgba8unorm',
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Initialize all entries as not loaded (loaded = 0)
    this.updateFullGPU();
  }

  /**
   * Register a brick mapping: virtual position -> atlas position
   * Positions are in brick units (0-7), not voxels
   */
  setBrick(
    virtualX: number, virtualY: number, virtualZ: number,
    atlasX: number, atlasY: number, atlasZ: number
  ) {
    const idx = (virtualX + virtualY * GRID_SIZE + virtualZ * GRID_SIZE * GRID_SIZE) * 4;

    // Store atlas position as brick units (0-7) scaled to 0-255
    // Shader will convert back: atlasCoord = indirection.xyz * (BRICK_SIZE / ATLAS_SIZE)
    this.data[idx + 0] = atlasX * 32;  // 0-7 -> 0,32,64,96,128,160,192,224
    this.data[idx + 1] = atlasY * 32;
    this.data[idx + 2] = atlasZ * 32;
    this.data[idx + 3] = 255;  // loaded = true

    this.updateBrickGPU(virtualX, virtualY, virtualZ);

    console.log(`Indirection: virtual[${virtualX},${virtualY},${virtualZ}] -> atlas[${atlasX},${atlasY},${atlasZ}]`);
  }

  /**
   * Clear a brick (mark as not loaded)
   */
  clearBrick(virtualX: number, virtualY: number, virtualZ: number) {
    const idx = (virtualX + virtualY * GRID_SIZE + virtualZ * GRID_SIZE * GRID_SIZE) * 4;
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
    const idx = (x + y * GRID_SIZE + z * GRID_SIZE * GRID_SIZE) * 4;

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
      { bytesPerRow: GRID_SIZE * 4, rowsPerImage: GRID_SIZE },
      [GRID_SIZE, GRID_SIZE, GRID_SIZE]
    );
  }
}
