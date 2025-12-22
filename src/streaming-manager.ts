/**
 * StreamingManager - Resident Set Manager for brick streaming
 *
 * Decides which bricks should be in VRAM based on camera position and frustum.
 * Handles:
 * - Visibility testing (frustum culling)
 * - LOD selection (distance-based coarse-to-fine)
 * - Desired set calculation
 * - Priority queue for async loading
 * - Touch loop for LRU management
 * - Request cancellation for stale bricks
 */

import { Camera, extractFrustumPlanes, isAABBInFrustum, multiplyMatrices } from './camera.js';
import { Renderer } from './renderer.js';
import { BrickLoader, BrickMetadata } from './brick-loader.js';
import { AtlasSlot } from './atlas-allocator.js';
import { PHYSICAL_BRICK_SIZE, getNormalizedSize } from './config.js';
import { writeToCanvas } from './volume.js';

export interface BrickRequest {
  lod: number;
  bx: number;
  by: number;
  bz: number;
  distance: number;
  key: string;
}

export interface LoadedBrickInfo {
  slot: AtlasSlot;
  slotIndex: number;
}

export interface StreamingStats {
  desiredCount: number;
  loadedCount: number;
  pendingCount: number;
  culledCount: number;
  emptyCount: number;
  evictedCount: number;
  cancelledCount: number;
  atlasUsage: number;
  atlasCapacity: number;
}

export class StreamingManager {
  private renderer: Renderer;
  private brickLoader: BrickLoader;
  private metadata: BrickMetadata;
  private device: GPUDevice;

  // Track loaded bricks: key -> { slot, slotIndex }
  private loadedBricks = new Map<string, LoadedBrickInfo>();

  // Track empty bricks (so we don't re-check them)
  private emptyBricks = new Set<string>();

  // Current desired set (keys) - updated each computeDesiredSet
  private desiredKeys = new Set<string>();

  // Priority queue for pending loads (sorted by distance, closest first)
  private loadQueue: BrickRequest[] = [];

  // Currently in-flight requests with AbortControllers
  private inFlightRequests = new Map<string, AbortController>();

  // Max concurrent requests
  private maxConcurrentRequests = 4;

  // Frame counter for LRU
  private frameCount = 0;

  // LOD thresholds (distance to split from LOD N to LOD N-1)
  public lodThresholds = [0.3, 0.5, 0.8, 1.2, 2.0];

  // Stats from last update
  private lastStats: StreamingStats = {
    desiredCount: 0,
    loadedCount: 0,
    pendingCount: 0,
    culledCount: 0,
    emptyCount: 0,
    evictedCount: 0,
    cancelledCount: 0,
    atlasUsage: 0,
    atlasCapacity: 512,
  };

  // Throttle updates (don't recompute every frame)
  private lastUpdateFrame = -1;
  private updateInterval = 10; // frames between full updates

  constructor(
    renderer: Renderer,
    brickLoader: BrickLoader,
    metadata: BrickMetadata,
    device: GPUDevice
  ) {
    this.renderer = renderer;
    this.brickLoader = brickLoader;
    this.metadata = metadata;
    this.device = device;
  }

  /**
   * Main update loop - call every frame
   * Returns true if any work was done
   */
  update(camera: Camera, canvas: HTMLCanvasElement): boolean {
    this.frameCount++;

    // Throttle full traversal (expensive)
    const shouldRecompute = (this.frameCount - this.lastUpdateFrame) >= this.updateInterval;

    if (shouldRecompute) {
      this.lastUpdateFrame = this.frameCount;
      this.computeDesiredSet(camera, canvas);
    }

    // Always process some pending loads (non-blocking)
    this.processLoadQueue();

    return this.inFlightRequests.size > 0 || this.loadQueue.length > 0;
  }

  /**
   * Force immediate recomputation of desired set
   */
  forceUpdate(camera: Camera, canvas: HTMLCanvasElement): void {
    this.lastUpdateFrame = this.frameCount;
    this.computeDesiredSet(camera, canvas);
  }

  /**
   * Clear all state
   */
  clear(): void {
    // Cancel all in-flight requests
    for (const controller of this.inFlightRequests.values()) {
      controller.abort();
    }
    this.inFlightRequests.clear();

    // Free all atlas slots
    for (const entry of this.loadedBricks.values()) {
      this.renderer.allocator.free(entry.slot);
    }
    this.loadedBricks.clear();
    this.emptyBricks.clear();
    this.desiredKeys.clear();
    this.loadQueue = [];
    this.renderer.indirection.clearAll();
    console.log('StreamingManager: cleared all bricks');
  }

  /**
   * Get current stats
   */
  getStats(): StreamingStats {
    return { ...this.lastStats };
  }

  /**
   * Compute the desired set of bricks based on camera position and frustum
   */
  private computeDesiredSet(camera: Camera, canvas: HTMLCanvasElement): void {
    const cameraPos: [number, number, number] = [
      camera.position[0]!,
      camera.position[1]!,
      camera.position[2]!,
    ];

    // Get frustum planes
    const aspect = canvas.width / canvas.height;
    const viewMatrix = camera.getViewMatrix();
    const projMatrix = camera.getProjectionMatrix(aspect);
    const viewProj = multiplyMatrices(projMatrix, viewMatrix);
    const frustum = extractFrustumPlanes(viewProj);

    // Get LOD range from metadata
    const maxLod = Math.max(...this.metadata.levels.map(l => l.lod));

    // Desired bricks from traversal
    const desiredBricks: BrickRequest[] = [];
    let culledCount = 0;
    let emptyCount = 0;

    // Recursive traversal function
    const traverse = (bx: number, by: number, bz: number, lod: number): void => {
      const level = this.metadata.levels.find(l => l.lod === lod);
      if (!level) return;

      const [gridX, gridY, gridZ] = level.bricks as [number, number, number];

      // Bounds check - handles non-power-of-two grids
      if (bx < 0 || bx >= gridX || by < 0 || by >= gridY || bz < 0 || bz >= gridZ) return;

      // Get brick AABB
      const aabb = this.getBrickAABB(bx, by, bz, lod);

      // Frustum culling
      if (!isAABBInFrustum(aabb.min, aabb.max, frustum)) {
        culledCount++;
        return;
      }

      // Distance check
      const center = this.getAABBCenter(aabb);
      const dist = this.distance(cameraPos, center);

      // Decision: load this LOD or split to finer?
      const shouldSplit = lod > 0 && dist < this.lodThresholds[lod - 1]!;

      if (shouldSplit) {
        // Check if finer LOD exists
        const finerLevel = this.metadata.levels.find(l => l.lod === lod - 1);
        if (!finerLevel) {
          // No finer LOD available, use current
          this.addDesiredBrick(desiredBricks, bx, by, bz, lod, dist);
          return;
        }

        // Compute child coordinates for non-power-of-two grids
        // The relationship is: parent brick covers a 2x2x2 region at finer LOD
        // But we need to check bounds at the finer level
        const [finerGridX, finerGridY, finerGridZ] = finerLevel.bricks as [number, number, number];
        const nextLod = lod - 1;

        for (let dz = 0; dz < 2; dz++) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const cx = bx * 2 + dx;
              const cy = by * 2 + dy;
              const cz = bz * 2 + dz;

              // Only traverse if within finer grid bounds
              if (cx < finerGridX && cy < finerGridY && cz < finerGridZ) {
                traverse(cx, cy, cz, nextLod);
              }
            }
          }
        }
      } else {
        this.addDesiredBrick(desiredBricks, bx, by, bz, lod, dist);
      }
    };

    // Helper to add a brick to desired set
    this.addDesiredBrick = (bricks: BrickRequest[], bx: number, by: number, bz: number, lod: number, dist: number) => {
      const key = `lod${lod}:${bz}/${by}/${bx}`;

      // Check if known empty
      if (this.emptyBricks.has(key)) {
        emptyCount++;
        return;
      }

      bricks.push({ lod, bx, by, bz, distance: dist, key });
    };

    // Start from coarsest LOD
    const rootLevel = this.metadata.levels.find(l => l.lod === maxLod);
    if (rootLevel) {
      const [gridX, gridY, gridZ] = rootLevel.bricks as [number, number, number];
      for (let bz = 0; bz < gridZ; bz++) {
        for (let by = 0; by < gridY; by++) {
          for (let bx = 0; bx < gridX; bx++) {
            traverse(bx, by, bz, maxLod);
          }
        }
      }
    }

    // Update desired keys set (used for stale check)
    this.desiredKeys.clear();
    for (const brick of desiredBricks) {
      this.desiredKeys.add(brick.key);
    }

    // Cancel in-flight requests that are no longer desired
    let cancelledCount = 0;
    for (const [key, controller] of this.inFlightRequests.entries()) {
      if (!this.desiredKeys.has(key)) {
        controller.abort();
        this.inFlightRequests.delete(key);
        cancelledCount++;
      }
    }

    // Touch all desired bricks that are already loaded
    let loadedCount = 0;
    for (const brick of desiredBricks) {
      const entry = this.loadedBricks.get(brick.key);
      if (entry) {
        this.renderer.allocator.touch(entry.slotIndex, this.frameCount);
        loadedCount++;
      }
    }

    // Find missing bricks and add to load queue
    const missingBricks = desiredBricks.filter(
      b => !this.loadedBricks.has(b.key) && !this.inFlightRequests.has(b.key)
    );

    // Sort by distance (closest first)
    missingBricks.sort((a, b) => a.distance - b.distance);

    // Replace load queue with new desired set
    this.loadQueue = missingBricks;

    // Update stats
    this.lastStats = {
      desiredCount: desiredBricks.length,
      loadedCount,
      pendingCount: this.loadQueue.length + this.inFlightRequests.size,
      culledCount,
      emptyCount,
      evictedCount: 0, // Reset, updated during loadBrick
      cancelledCount,
      atlasUsage: this.renderer.allocator.usedCount,
      atlasCapacity: this.renderer.allocator.totalSlots,
    };
  }

  // Helper method reference (assigned in computeDesiredSet)
  private addDesiredBrick: (bricks: BrickRequest[], bx: number, by: number, bz: number, lod: number, dist: number) => void = () => {};

  /**
   * Process pending load requests (non-blocking)
   */
  private processLoadQueue(): void {
    // Start new requests up to max concurrent
    while (
      this.inFlightRequests.size < this.maxConcurrentRequests &&
      this.loadQueue.length > 0
    ) {
      const request = this.loadQueue.shift()!;

      // Skip if already loaded (race condition check)
      if (this.loadedBricks.has(request.key)) continue;

      // Skip if already in flight
      if (this.inFlightRequests.has(request.key)) continue;

      // Skip if no longer desired
      if (!this.desiredKeys.has(request.key)) continue;

      // Create AbortController for this request
      const controller = new AbortController();
      this.inFlightRequests.set(request.key, controller);

      this.loadBrick(request, controller.signal).finally(() => {
        this.inFlightRequests.delete(request.key);
      });
    }
  }

  /**
   * Load a single brick with abort support
   */
  private async loadBrick(request: BrickRequest, signal: AbortSignal): Promise<void> {
    const { lod, bx, by, bz, key } = request;

    // Check if aborted before starting
    if (signal.aborted) return;

    // Check if empty
    const isEmpty = await this.brickLoader.isBrickEmpty(lod, bx, by, bz);
    if (signal.aborted) return;

    if (isEmpty) {
      this.emptyBricks.add(key);
      this.renderer.indirection.setEmpty(bx, by, bz, lod);
      return;
    }

    // Load brick data
    const data = await this.brickLoader.loadBrick(lod, bx, by, bz);
    if (signal.aborted) return;

    if (!data) return;

    // CRITICAL: Check if still desired before uploading to GPU
    if (!this.desiredKeys.has(key)) {
      // Brick is no longer needed - camera moved
      return;
    }

    // Allocate slot (will evict LRU if full)
    const result = this.renderer.allocator.allocate(this.frameCount);
    if (!result) {
      console.warn('StreamingManager: allocation failed');
      return;
    }

    // Handle eviction
    if (result.evicted) {
      this.renderer.indirection.clearBrick(
        result.evicted.bx,
        result.evicted.by,
        result.evicted.bz,
        result.evicted.lod
      );
      this.loadedBricks.delete(result.evicted.key);
      this.lastStats.evictedCount++;
    }

    // Upload to atlas
    const offset: [number, number, number] = [
      result.slot.x * PHYSICAL_BRICK_SIZE,
      result.slot.y * PHYSICAL_BRICK_SIZE,
      result.slot.z * PHYSICAL_BRICK_SIZE,
    ];
    writeToCanvas(
      this.device,
      this.renderer.canvas,
      data,
      [PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE],
      offset
    );

    // Update indirection
    this.renderer.indirection.setBrick(bx, by, bz, result.slot.x, result.slot.y, result.slot.z, lod);

    // Set metadata for future eviction
    this.renderer.allocator.setMetadata(result.slotIndex, { lod, bx, by, bz, key });

    // Track
    this.loadedBricks.set(key, { slot: result.slot, slotIndex: result.slotIndex });
  }

  // Helper functions

  private getBrickAABB(
    bx: number,
    by: number,
    bz: number,
    lod: number
  ): { min: [number, number, number]; max: [number, number, number] } {
    const level = this.metadata.levels.find(l => l.lod === lod);
    if (!level) return { min: [0, 0, 0], max: [0, 0, 0] };

    const normalizedSize = getNormalizedSize();
    const [gridX, gridY, gridZ] = level.bricks as [number, number, number];
    const brickSize: [number, number, number] = [
      normalizedSize[0] / gridX,
      normalizedSize[1] / gridY,
      normalizedSize[2] / gridZ,
    ];

    const min: [number, number, number] = [
      -normalizedSize[0] * 0.5 + bx * brickSize[0],
      -normalizedSize[1] * 0.5 + by * brickSize[1],
      -normalizedSize[2] * 0.5 + bz * brickSize[2],
    ];
    const max: [number, number, number] = [
      min[0] + brickSize[0],
      min[1] + brickSize[1],
      min[2] + brickSize[2],
    ];

    return { min, max };
  }

  private getAABBCenter(aabb: {
    min: [number, number, number];
    max: [number, number, number];
  }): [number, number, number] {
    return [
      (aabb.min[0] + aabb.max[0]) * 0.5,
      (aabb.min[1] + aabb.max[1]) * 0.5,
      (aabb.min[2] + aabb.max[2]) * 0.5,
    ];
  }

  private distance(a: [number, number, number], b: [number, number, number]): number {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
