/**
 * Indirection Table for Virtual Volume Texturing
 *
 * Maps virtual brick coordinates to atlas positions.
 *
 * Virtual volume is divided into bricks (BRICK_SIZE³ bricks, forming a GRID_SIZE³ grid)
 * Each entry in the indirection table tells the shader where to find that brick in the atlas.
 */

import { getDatasetGrid } from './config.js';

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
  private gridX: number;
  private gridY: number;
  private gridZ: number;

  constructor(device: GPUDevice) {
    this.device = device;

    // Get current dataset grid dimensions
    const datasetGrid = getDatasetGrid();
    this.gridX = datasetGrid[0];
    this.gridY = datasetGrid[1];
    this.gridZ = datasetGrid[2];

    // Dataset grid, 4 bytes per entry (RGBA)
    this.data = new Uint8Array(this.gridX * this.gridY * this.gridZ * 4);

    // Create 3D texture for indirection (dataset grid size, RGBA8 unsigned int)
    // Using rgba8uint for exact integer slot indices (no precision loss)
    this.texture = device.createTexture({
      size: [this.gridX, this.gridY, this.gridZ],
      format: 'rgba8uint',
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Initialize all entries as not loaded (loaded = 0)
    this.updateFullGPU();
  }

  /**
   * Register a brick mapping: virtual position -> atlas position
   *
   * For LOD 0, this sets a single cell in the indirection table.
   * For coarser LODs, this fills multiple cells (2^lod)³ to cover the
   * equivalent region in the finest LOD grid.
   *
   * @param virtualX/Y/Z - Virtual brick position at this LOD level
   * @param atlasX/Y/Z - Atlas slot position
   * @param lod - LOD level (0 = full res, 1 = 2x downsample, 2 = 4x, 3 = 8x)
   */
  setBrick(
    virtualX: number, virtualY: number, virtualZ: number,
    atlasX: number, atlasY: number, atlasZ: number,
    lod: number = 0
  ) {
    // How many LOD 0 cells does this brick cover?
    const scale = 1 << lod; // 2^lod: 1, 2, 4, 8 for LOD 0, 1, 2, 3

    // Base position in LOD 0 grid
    const baseX = virtualX * scale;
    const baseY = virtualY * scale;
    const baseZ = virtualZ * scale;

    // Fill all covered cells
    for (let dz = 0; dz < scale; dz++) {
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = baseX + dx;
          const y = baseY + dy;
          const z = baseZ + dz;

          // Bounds check
          if (x >= this.gridX || y >= this.gridY || z >= this.gridZ) continue;

          const idx = (x + y * this.gridX + z * this.gridX * this.gridY) * 4;

          // Only overwrite if this LOD is finer (lower number) or equal
          // LOD stored as lod+1, so higher value = coarser
          const existingLod = this.data[idx + 3];
          if (existingLod > 0 && existingLod <= lod + 1) {
            // A finer or equal LOD brick already occupies this cell, skip
            continue;
          }

          // Store raw atlas slot indices
          this.data[idx + 0] = atlasX;
          this.data[idx + 1] = atlasY;
          this.data[idx + 2] = atlasZ;
          // Store LOD level + 1 (0 = not loaded, 1-4 = lod 0-3)
          this.data[idx + 3] = lod + 1;
        }
      }
    }

    // Update the GPU region
    this.updateRegionGPU(baseX, baseY, baseZ, scale);
  }

  /**
   * Mark a brick region as empty (known to have no data)
   *
   * Unlike clearBrick (which reverts to unloaded), this marks cells as
   * "loaded but empty" so coarser LOD data doesn't show through.
   * Uses a special marker: LOD 255 means "empty brick, don't render".
   *
   * @param virtualX/Y/Z - Virtual brick position at this LOD level
   * @param lod - LOD level of the empty brick
   */
  setEmpty(
    virtualX: number, virtualY: number, virtualZ: number,
    lod: number = 0
  ) {
    const scale = 1 << lod;
    const baseX = virtualX * scale;
    const baseY = virtualY * scale;
    const baseZ = virtualZ * scale;

    for (let dz = 0; dz < scale; dz++) {
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = baseX + dx;
          const y = baseY + dy;
          const z = baseZ + dz;

          if (x >= this.gridX || y >= this.gridY || z >= this.gridZ) continue;

          const idx = (x + y * this.gridX + z * this.gridX * this.gridY) * 4;

          // Only overwrite if this LOD is finer or equal (same logic as setBrick)
          const existingLod = this.data[idx + 3];
          if (existingLod > 0 && existingLod < 255 && existingLod <= lod + 1) {
            continue;
          }

          // Mark as empty: atlas coords don't matter, LOD = 255 means empty
          this.data[idx + 0] = 0;
          this.data[idx + 1] = 0;
          this.data[idx + 2] = 0;
          this.data[idx + 3] = 255; // Special marker for "empty"
        }
      }
    }

    this.updateRegionGPU(baseX, baseY, baseZ, scale);
  }

  /**
   * Clear a brick region (mark as not loaded)
   *
   * For LOD 0, clears a single cell.
   * For coarser LODs, clears all cells that were covered by this brick,
   * but only if they still point to this LOD (don't clear finer LOD data).
   *
   * @param virtualX/Y/Z - Virtual brick position at this LOD level
   * @param lod - LOD level of the brick being cleared
   * @param fallbackAtlas - Optional: atlas position to fall back to (e.g., parent brick)
   * @param fallbackLod - Optional: LOD of fallback brick
   */
  clearBrick(
    virtualX: number, virtualY: number, virtualZ: number,
    lod: number = 0,
    fallbackAtlas?: [number, number, number],
    fallbackLod?: number
  ) {
    const scale = 1 << lod;
    const baseX = virtualX * scale;
    const baseY = virtualY * scale;
    const baseZ = virtualZ * scale;

    for (let dz = 0; dz < scale; dz++) {
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = baseX + dx;
          const y = baseY + dy;
          const z = baseZ + dz;

          if (x >= this.gridX || y >= this.gridY || z >= this.gridZ) continue;

          const idx = (x + y * this.gridX + z * this.gridX * this.gridY) * 4;

          // Only clear if this cell is at the LOD we're clearing
          // Don't clear finer LOD data that may have been loaded since
          const existingLod = this.data[idx + 3];
          if (existingLod !== lod + 1) continue;

          if (fallbackAtlas && fallbackLod !== undefined) {
            // Fall back to parent brick
            this.data[idx + 0] = fallbackAtlas[0];
            this.data[idx + 1] = fallbackAtlas[1];
            this.data[idx + 2] = fallbackAtlas[2];
            this.data[idx + 3] = fallbackLod + 1;
          } else {
            // Clear completely
            this.data[idx + 0] = 0;
            this.data[idx + 1] = 0;
            this.data[idx + 2] = 0;
            this.data[idx + 3] = 0;
          }
        }
      }
    }

    this.updateRegionGPU(baseX, baseY, baseZ, scale);
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
    this.updateRegionGPU(x, y, z, 1);
  }

  /**
   * Update a region of the indirection texture on the GPU
   * Used for multi-cell updates when setting/clearing coarse LOD bricks
   */
  private updateRegionGPU(baseX: number, baseY: number, baseZ: number, size: number) {
    // Clamp region to grid bounds
    const endX = Math.min(baseX + size, this.gridX);
    const endY = Math.min(baseY + size, this.gridY);
    const endZ = Math.min(baseZ + size, this.gridZ);
    const actualSizeX = endX - baseX;
    const actualSizeY = endY - baseY;
    const actualSizeZ = endZ - baseZ;

    if (actualSizeX <= 0 || actualSizeY <= 0 || actualSizeZ <= 0) return;

    // For small regions, write directly
    // For larger regions, extract the subregion into a contiguous buffer
    if (size === 1) {
      const idx = (baseX + baseY * this.gridX + baseZ * this.gridX * this.gridY) * 4;
      this.device.queue.writeTexture(
        { texture: this.texture, origin: [baseX, baseY, baseZ] },
        this.data.subarray(idx, idx + 4),
        { bytesPerRow: 4, rowsPerImage: 1 },
        [1, 1, 1]
      );
    } else {
      // Extract contiguous subregion
      const regionData = new Uint8Array(actualSizeX * actualSizeY * actualSizeZ * 4);
      let writeIdx = 0;

      for (let z = baseZ; z < endZ; z++) {
        for (let y = baseY; y < endY; y++) {
          const rowStart = (baseX + y * this.gridX + z * this.gridX * this.gridY) * 4;
          for (let x = 0; x < actualSizeX; x++) {
            regionData[writeIdx++] = this.data[rowStart + x * 4 + 0]!;
            regionData[writeIdx++] = this.data[rowStart + x * 4 + 1]!;
            regionData[writeIdx++] = this.data[rowStart + x * 4 + 2]!;
            regionData[writeIdx++] = this.data[rowStart + x * 4 + 3]!;
          }
        }
      }

      this.device.queue.writeTexture(
        { texture: this.texture, origin: [baseX, baseY, baseZ] },
        regionData,
        { bytesPerRow: actualSizeX * 4, rowsPerImage: actualSizeY },
        [actualSizeX, actualSizeY, actualSizeZ]
      );
    }
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
