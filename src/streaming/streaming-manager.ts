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

import { Camera, extractFrustumPlanes, isAABBInFrustum, multiplyMatrices } from '../core/camera.js';
import { Renderer } from '../core/renderer.js';
import type { DataProvider, VolumeMetadata } from '../data/data-provider.js';
import { AtlasSlot } from './atlas-allocator.js';
import { BrickCache } from './brick-cache.js';
import { PHYSICAL_BRICK_SIZE, getNormalizedSize } from '../core/config.js';
import { writeToCanvas } from '../core/volume.js';

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
  // Network stats
  totalBytesDownloaded: number;
  bytesPerSecond: number;
  requestCount: number;
  // Timing
  timeToFirstRender: number | null; // ms, null if not yet loaded
}

export class StreamingManager {
  private renderer: Renderer;
  private dataProvider: DataProvider;
  private metadata: VolumeMetadata;
  private device: GPUDevice;

  // Track loaded bricks: key -> { slot, slotIndex }
  private loadedBricks = new Map<string, LoadedBrickInfo>();

  // Track pinned bricks (never evicted, always loaded first)
  private pinnedBricks = new Set<string>();

  // Track empty bricks (so we don't re-check them)
  private emptyBricks = new Set<string>();

  // CPU-side cache of decompressed brick data (avoids re-download after GPU eviction)
  private brickCache = new BrickCache();

  // Whether base LOD has been loaded
  private _baseLodLoaded = false;

  // Timing for first render
  private loadStartTime: number = 0;
  private _timeToFirstRender: number | null = null;

  /** Check if base LOD is loaded */
  get baseLodLoaded(): boolean {
    return this._baseLodLoaded;
  }

  /** Get time to first render in ms (null if not yet loaded) */
  get timeToFirstRender(): number | null {
    return this._timeToFirstRender;
  }

  // Current desired set (keys) - updated each computeDesiredSet
  private desiredKeys = new Set<string>();

  // Priority queue for pending loads (sorted by distance, closest first)
  private loadQueue: BrickRequest[] = [];

  // Currently in-flight requests with AbortControllers
  private inFlightRequests = new Map<string, AbortController>();

  // Max concurrent requests
  private maxConcurrentRequests = 8;

  // Frame counter for LRU
  private frameCount = 0;

  // Debounced accumulation reset (wait for streaming to settle)
  private resetAccumulationTimer: number | null = null;

  // Screen-Space Error (SSE) threshold in pixels
  // Split to finer LOD when projected voxel error exceeds this value
  // Lower = higher quality, more bricks loaded
  // Higher = lower quality, fewer bricks loaded
  public maxPixelError = 8.0;

  // Camera FOV in radians (must match camera.getProjectionMatrix)
  private readonly cameraFovRad = Math.PI / 4; // 45 degrees

  // Precomputed projection factor (updated each frame)
  private projectionFactor = 0;

  // Max bricks to request at once (prevents runaway loading)
  private maxDesiredBricks = 256;

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
    totalBytesDownloaded: 0,
    bytesPerSecond: 0,
    requestCount: 0,
    timeToFirstRender: null,
  };

  // Throttle updates (don't recompute every frame)
  private lastUpdateFrame = -1;
  private updateInterval = 10; // frames between full updates

  // Camera movement detection
  private lastCameraPos: [number, number, number] = [0, 0, 0];
  private cameraStillFrames = 0;
  private cameraMovementThreshold = 0.001; // Min movement to consider "moving"
  private cameraStillThreshold = 5; // Frames of stillness before re-prioritizing

  constructor(
    renderer: Renderer,
    dataProvider: DataProvider,
    metadata: VolumeMetadata,
    device: GPUDevice,
    pageLoadStartTime?: number
  ) {
    this.renderer = renderer;
    this.dataProvider = dataProvider;
    this.metadata = metadata;
    this.device = device;

    // Use page load start time if provided for true time-to-first-render
    this.loadStartTime = pageLoadStartTime ?? performance.now();

    // Load coarsest LOD immediately as base layer
    this.loadBaseLod();
  }

  /**
   * Load and pin the coarsest LOD level (ensures no holes)
   */
  private async loadBaseLod(): Promise<void> {
    const maxLod = Math.max(...this.metadata.levels.map(l => l.lod));
    const level = this.metadata.levels.find(l => l.lod === maxLod);
    if (!level) return;

    const [gridX, gridY, gridZ] = level.brickGrid;

    for (let bz = 0; bz < gridZ; bz++) {
      for (let by = 0; by < gridY; by++) {
        for (let bx = 0; bx < gridX; bx++) {
          const key = `lod${maxLod}:${bz}/${by}/${bx}`;

          // Check if empty
          const isEmpty = await this.dataProvider.isBrickEmpty(maxLod, bx, by, bz);
          if (isEmpty) {
            this.emptyBricks.add(key);
            this.renderer.indirection.setEmpty(bx, by, bz, maxLod);
            continue;
          }

          // Load brick data
          const data = await this.dataProvider.loadBrick(maxLod, bx, by, bz);
          if (!data) continue;

          // Allocate slot
          const result = this.renderer.allocator.allocate(this.frameCount);
          if (!result) {
            console.warn('Failed to allocate slot for base LOD brick');
            continue;
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
          this.renderer.indirection.setBrick(bx, by, bz, result.slot.x, result.slot.y, result.slot.z, maxLod);

          // Set metadata and pin the slot (base LOD is never evicted)
          this.renderer.allocator.setMetadata(result.slotIndex, { lod: maxLod, bx, by, bz, key });
          this.renderer.allocator.pin(result.slotIndex);

          // Track as loaded AND pinned
          this.loadedBricks.set(key, { slot: result.slot, slotIndex: result.slotIndex });
          this.pinnedBricks.add(key);
        }
      }
    }

    this._baseLodLoaded = true;
    this._timeToFirstRender = performance.now() - this.loadStartTime;
  }

  /**
   * Main update loop - call every frame
   * Returns true if any work was done
   */
  update(camera: Camera, canvas: HTMLCanvasElement): boolean {
    this.frameCount++;

    const cameraPos: [number, number, number] = [
      camera.position[0]!,
      camera.position[1]!,
      camera.position[2]!,
    ];

    // Detect camera movement
    const cameraMoved = this.hasCameraMoved(cameraPos);

    if (cameraMoved) {
      this.cameraStillFrames = 0;
      this.lastCameraPos = cameraPos;
    } else {
      this.cameraStillFrames++;
    }

    // Decide when to recompute:
    // 1. Regular interval (every N frames while moving)
    // 2. Immediately when camera comes to rest (after stillness threshold)
    const regularUpdate = (this.frameCount - this.lastUpdateFrame) >= this.updateInterval;
    const cameraJustStopped = this.cameraStillFrames === this.cameraStillThreshold;

    if (regularUpdate || cameraJustStopped) {
      this.lastUpdateFrame = this.frameCount;
      this.computeDesiredSet(camera, canvas);
    }

    // Always process some pending loads (non-blocking)
    this.processLoadQueue();

    return this.inFlightRequests.size > 0 || this.loadQueue.length > 0;
  }

  /**
   * Check if camera has moved significantly
   */
  private hasCameraMoved(currentPos: [number, number, number]): boolean {
    const dx = currentPos[0] - this.lastCameraPos[0];
    const dy = currentPos[1] - this.lastCameraPos[1];
    const dz = currentPos[2] - this.lastCameraPos[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return dist > this.cameraMovementThreshold;
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
    this.pinnedBricks.clear();
    this.emptyBricks.clear();
    this.brickCache.clear();
    this.desiredKeys.clear();
    this.loadQueue = [];
    this._baseLodLoaded = false;
    this.renderer.indirection.clearAll();

    // Reload base LOD
    this.loadBaseLod();
  }

  /**
   * Get current stats
   */
  getStats(): StreamingStats {
    // Get live network stats from DataProvider
    const networkStats = this.dataProvider.getNetworkStats();
    return {
      ...this.lastStats,
      totalBytesDownloaded: networkStats.totalBytesDownloaded,
      bytesPerSecond: networkStats.recentBytesPerSecond,
      requestCount: networkStats.requestCount,
      timeToFirstRender: this._timeToFirstRender,
    };
  }

  /**
   * Compute the desired set of bricks based on camera position and frustum
   * Uses Screen-Space Error (SSE) for LOD selection
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

    // Compute projection factor for SSE calculation
    // projectionFactor = screenHeight / (2 * tan(fov/2))
    this.projectionFactor = canvas.height / (2 * Math.tan(this.cameraFovRad / 2));

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

      const [gridX, gridY, gridZ] = level.brickGrid;

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

      // Calculate Screen-Space Error (SSE)
      // At this LOD, each voxel represents 2^lod original voxels
      // The error is the projected size of one voxel at this LOD
      const voxelWorldSize = this.getVoxelWorldSize(lod);
      const projectedError = (voxelWorldSize / Math.max(dist, 0.001)) * this.projectionFactor;

      // Decision: load this LOD or split to finer?
      const shouldSplit = lod > 0 && projectedError > this.maxPixelError;

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
        const [finerGridX, finerGridY, finerGridZ] = finerLevel.brickGrid;
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
      const [gridX, gridY, gridZ] = rootLevel.brickGrid;
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

    // Always touch pinned bricks to keep them at the front of LRU
    for (const key of this.pinnedBricks) {
      const entry = this.loadedBricks.get(key);
      if (entry) {
        this.renderer.allocator.touch(entry.slotIndex, this.frameCount);
      }
    }

    // Find missing bricks and add to load queue
    const missingBricks = desiredBricks.filter(
      b => !this.loadedBricks.has(b.key) && !this.inFlightRequests.has(b.key)
    );

    // Sort by distance (closest first)
    missingBricks.sort((a, b) => a.distance - b.distance);

    // Limit queue size to prevent runaway loading
    // Only queue the closest N bricks
    this.loadQueue = missingBricks.slice(0, this.maxDesiredBricks);

    // Update stats (network stats and timing are fetched live in getStats())
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
      // Network stats placeholders - actual values come from getStats()
      totalBytesDownloaded: 0,
      bytesPerSecond: 0,
      requestCount: 0,
      timeToFirstRender: null, // Actual value comes from getStats()
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
    const isEmpty = await this.dataProvider.isBrickEmpty(lod, bx, by, bz);
    if (signal.aborted) return;

    if (isEmpty) {
      this.emptyBricks.add(key);
      this.renderer.indirection.setEmpty(bx, by, bz, lod);
      return;
    }

    // Try CPU cache first, fall back to network
    let data = this.brickCache.get(key) ?? null;
    if (!data) {
      data = await this.dataProvider.loadBrick(lod, bx, by, bz);
      if (signal.aborted) return;
      if (!data) return;
      this.brickCache.put(key, data);
    }

    // CRITICAL: Check if still desired before uploading to GPU
    if (!this.desiredKeys.has(key)) {
      // Brick is no longer needed - camera moved (data stays in CPU cache)
      return;
    }

    // Allocate slot (will evict LRU if full, but never pinned slots)
    const result = this.renderer.allocator.allocate(this.frameCount);
    if (!result) {
      console.warn('StreamingManager: allocation failed (all slots pinned?)');
      return;
    }

    // Handle eviction - allocator already skips pinned slots
    if (result.evicted) {
      // Find parent brick to fall back to
      const fallback = this.findParentBrick(result.evicted.bx, result.evicted.by, result.evicted.bz, result.evicted.lod);

      if (fallback) {
        this.renderer.indirection.clearBrick(
          result.evicted.bx,
          result.evicted.by,
          result.evicted.bz,
          result.evicted.lod,
          [fallback.slot.x, fallback.slot.y, fallback.slot.z],
          fallback.lod
        );
      } else {
        // No parent found - clear completely (shouldn't happen if base LOD is loaded)
        this.renderer.indirection.clearBrick(
          result.evicted.bx,
          result.evicted.by,
          result.evicted.bz,
          result.evicted.lod
        );
      }

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

    // Schedule accumulation reset to prevent constant flickering during streaming bursts
    this.scheduleAccumulationReset();
  }

  private scheduleAccumulationReset(): void {
    if (this.resetAccumulationTimer !== null) {
      clearTimeout(this.resetAccumulationTimer);
    }
    this.resetAccumulationTimer = setTimeout(() => {
      this.renderer.resetAccumulation();
      this.resetAccumulationTimer = null;
    }, 100) as unknown as number;
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
    const [gridX, gridY, gridZ] = level.brickGrid;
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

  /**
   * Get the world-space size of one voxel at a given LOD level
   * At LOD N, each voxel represents 2^N original voxels
   */
  private getVoxelWorldSize(lod: number): number {
    const normalizedSize = getNormalizedSize();
    const dims = this.metadata.dimensions;

    // Base voxel size in normalized space (LOD 0)
    // Use the largest dimension for consistent error metric
    const maxDim = Math.max(dims[0], dims[1], dims[2]);
    const baseVoxelSize = Math.max(normalizedSize[0], normalizedSize[1], normalizedSize[2]) / maxDim;

    // At LOD N, each voxel represents 2^N original voxels
    return baseVoxelSize * (1 << lod);
  }

  /**
   * Find the parent (coarser LOD) brick that covers the same region
   * Used to restore fallback data when evicting a finer LOD brick
   */
  private findParentBrick(
    bx: number,
    by: number,
    bz: number,
    lod: number
  ): { slot: AtlasSlot; lod: number } | null {
    const maxLod = Math.max(...this.metadata.levels.map(l => l.lod));

    // Walk up the LOD hierarchy to find a loaded parent
    for (let parentLod = lod + 1; parentLod <= maxLod; parentLod++) {
      // Parent coordinates are halved for each LOD level up
      const scale = 1 << (parentLod - lod);
      const parentBx = Math.floor(bx / scale);
      const parentBy = Math.floor(by / scale);
      const parentBz = Math.floor(bz / scale);

      const parentKey = `lod${parentLod}:${parentBz}/${parentBy}/${parentBx}`;
      const parentEntry = this.loadedBricks.get(parentKey);

      if (parentEntry) {
        return { slot: parentEntry.slot, lod: parentLod };
      }
    }

    return null;
  }
}
