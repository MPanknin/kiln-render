/**
 * StreamingManager - Resident set manager for brick streaming. Selects visible
 * bricks by frustum/LOD, queues priority loads, and cancels stale requests.
 */

import { mat4 } from 'wgpu-matrix';
import { Camera, extractFrustumPlanes, isAABBInFrustum } from '../core/camera.js';
import type { VolumeResources } from '../core/volume-resources.js';
import type { DataProvider, VolumeMetadata, BrickLoadResult } from '../data/data-provider.js';
import { AtlasSlot } from './atlas-allocator.js';
import { BrickCache } from './brick-cache.js';
import { PHYSICAL_BRICK_SIZE } from '../core/config.js';
import type { DatasetConfig } from '../core/config.js';
import { writeToCanvas } from '../core/volume.js';
import { float16BitsToFloat32 } from '../utils/float16.js';
import type { PipelineTimings } from '../data/data-provider.js';
import { RollingAvg } from '../data/network-tracker.js';

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
  cancelledCount: number;
  atlasUsage: number;
  atlasCapacity: number;
  // Network stats
  totalBytesDownloaded: number;
  bytesPerSecond: number;
  requestCount: number;
  // Timing
  timeToFirstRender: number | null; // ms, null if not yet loaded
  // Evictions since last stats reset
  evictedCount: number;
  // Allocation refusals under atlas pressure
  allocationsRefused: number;
  // Per-stage pipeline timings (rolling avg over last ~32 bricks)
  pipelineTimings: PipelineTimings;
  // Brick lifecycle counters (cumulative)
  bricksDispatched: number;
  bricksCommitted: number;
  bricksCancelled: number;
  bricksDiscarded: number; // fetched but no longer desired (stale-on-arrival)
  // End-to-end latency: dispatch → committed (rolling avg ms)
  avgBrickLatencyMs: number;
}

export class StreamingManager {
  private resources: VolumeResources;
  private onResetAccumulation: () => void;
  private dataProvider: DataProvider;
  private metadata: VolumeMetadata;
  private device: GPUDevice;
  private config: DatasetConfig;

  // Track loaded bricks: key -> { slot, slotIndex }
  private loadedBricks = new Map<string, LoadedBrickInfo>();

  // Track pinned bricks (never evicted, always loaded first)
  private pinnedBricks = new Set<string>();

  // Track empty bricks (so we don't re-check them)
  private emptyBricks = new Set<string>();

  // CPU-side cache of decompressed brick data (avoids re-download after GPU eviction)
  private brickCache: BrickCache;

  baseLodLoaded = false;

  // Timing for first render
  private loadStartTime: number = 0;
  timeToFirstRender: number | null = null;

  // Current desired set (keys) - updated each computeDesiredSet
  private desiredKeys = new Set<string>();

  // Priority queue for pending loads (sorted by distance, closest first)
  private loadQueue: BrickRequest[] = [];

  // Currently in-flight requests with AbortControllers
  private inFlightRequests = new Map<string, AbortController>();

  // Cancellation grace period — tracks when each in-flight request first left
  // the desired set. Only abort after CANCEL_GRACE_MS, so requests that briefly
  // leave the desired set (LOD oscillation during gestures) survive and warm
  // the worker chunk cache instead of wasting bandwidth on aborted fetches.
  private inFlightStaleTime = new Map<string, number>();
  private readonly CANCEL_GRACE_MS = 200;

  // Max concurrent requests
  private maxConcurrentRequests = 12;

  // Callback for when base LOD is loaded with brick data
  private onBaseLodLoaded: ((brickData: (Uint8Array | Uint16Array)[]) => void) | null = null;

  // Callback for when base LOD derives float/channel ranges
  private onRangesDerived: ((opts: {
    dataRange?: [number, number];
    channelRanges?: Array<{ min: number; max: number }>;
  }) => void) | null = null;

  // Bricks remaining in the base-LOD load. Included in pendingCount so the
  // UI spinner is visible from the first frame — previously the base load
  // bypassed loadQueue/inFlightRequests entirely and pending read 0 for the
  // whole initial download.
  private baseLodPending = 0;

  // Frame counter for LRU
  private frameCount = 0;

  // Debounced accumulation reset (wait for streaming to settle)
  private resetAccumulationTimer: number | null = null;

  // GPU upload timing (writeTexture, measured on main thread for all providers)
  private uploadAvg = new RollingAvg();

  // Brick lifecycle telemetry
  private bricksDispatched = 0;
  private bricksCommitted = 0;
  private bricksCancelled = 0;
  private bricksDiscarded = 0;
  private brickLatencyAvg = new RollingAvg();
  private dispatchTimestamps = new Map<string, number>();

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

  // Suspends load-queue draining when atlas is full; retries on next computeDesiredSet.
  private allocationStalled = false;

  // cached zero-filled bricks per bit depth, used to clear stale slot
  // contents when a channel's fetch failed
  // reused slots may contain a previous brick's data 
  // without this a failed channel would show ghosts.
  private zeroBricks = new Map<number, Uint8Array | Uint16Array>();

  // Stats from last update
  private lastStats: StreamingStats = {
    desiredCount: 0,
    loadedCount: 0,
    pendingCount: 0,
    cancelledCount: 0,
    atlasUsage: 0,
    atlasCapacity: 512,
    totalBytesDownloaded: 0,
    bytesPerSecond: 0,
    requestCount: 0,
    timeToFirstRender: null,
    evictedCount: 0,
    allocationsRefused: 0,
    pipelineTimings: { avgQueueMs: 0, avgFetchMs: 0, avgAssemblyMs: 0, avgUploadMs: 0, sampleCount: 0 },
    bricksDispatched: 0,
    bricksCommitted: 0,
    bricksCancelled: 0,
    bricksDiscarded: 0,
    avgBrickLatencyMs: 0,
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
    resources: VolumeResources,
    dataProvider: DataProvider,
    metadata: VolumeMetadata,
    device: GPUDevice,
    config: DatasetConfig,
    onResetAccumulation: () => void,
    pageLoadStartTime?: number
  ) {
    this.resources = resources;
    this.onResetAccumulation = onResetAccumulation;
    this.dataProvider = dataProvider;
    this.metadata = metadata;
    this.device = device;
    this.config = config;

    // Scale concurrent requests and cache budget for multichannel
    const numChannels = resources.numChannels;
    this.maxConcurrentRequests = numChannels > 1 ? 12 : 8;
    this.brickCache = new BrickCache(numChannels * 256 * 1024 * 1024);

    // Use page load start time if provided for true time-to-first-render
    this.loadStartTime = pageLoadStartTime ?? performance.now();

    // Load coarsest LOD immediately as base layer
    this.loadBaseLod();
  }

  /** Set callback to be invoked when base LOD is loaded with brick data */
  setBaseLodLoadedCallback(callback: (brickData: (Uint8Array | Uint16Array)[]) => void): void {
    this.onBaseLodLoaded = callback;
  }

  /** Set callback for when base LOD derives float/channel ranges */
  setRangesDerivedCallback(callback: (opts: {
    dataRange?: [number, number];
    channelRanges?: Array<{ min: number; max: number }>;
  }) => void): void {
    this.onRangesDerived = callback;
  }

  /** Lazily create (and cache) a zero-filled physical brick for a bit depth */
  private getZeroBrick(bitDepth: number): Uint8Array | Uint16Array {
    let brick = this.zeroBricks.get(bitDepth);
    if (!brick) {
      const voxels = PHYSICAL_BRICK_SIZE * PHYSICAL_BRICK_SIZE * PHYSICAL_BRICK_SIZE;
      brick = bitDepth === 16 ? new Uint16Array(voxels) : new Uint8Array(voxels);
      this.zeroBricks.set(bitDepth, brick);
    }
    return brick;
  }

  /**
   * Derive a percentile-clipped (p0.1 / p99.9) float data range from base-LOD
   * bricks using a 65536-entry float16 histogram (no per-voxel Math.pow).
   */
  private computeFloatPercentileRange(
    bricks: Uint16Array[],
    rawMin: number,
    rawMax: number,
  ): [number, number] {
    const range = rawMax - rawMin;
    if (!(range > 0) || bricks.length === 0) return [rawMin, rawMax];

    // Decode LUT: every possible float16 bit pattern → float32
    const lut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) lut[i] = float16BitsToFloat32(i);

    const BINS = 65536;
    const histogram = new Uint32Array(BINS);
    const invRange = (BINS - 1) / range;
    let total = 0;

    for (const brick of bricks) {
      for (let i = 0; i < brick.length; i++) {
        const v = lut[brick[i]!]!;
        if (!isFinite(v)) continue;
        let bin = ((v - rawMin) * invRange) | 0;
        if (bin < 0) bin = 0;
        else if (bin >= BINS) bin = BINS - 1;
        histogram[bin] = (histogram[bin] ?? 0) + 1;
        total++;
      }
    }
    if (total === 0) return [rawMin, rawMax];

    const loTarget = total * 0.001;
    const hiTarget = total * 0.999;
    let lo = rawMin;
    let hi = rawMax;
    let count = 0;
    let loFound = false;
    for (let b = 0; b < BINS; b++) {
      count += histogram[b]!;
      if (!loFound && count > loTarget) {
        lo = rawMin + (b / BINS) * range;
        loFound = true;
      }
      if (count >= hiTarget) {
        hi = rawMin + ((b + 1) / BINS) * range;
        break;
      }
    }
    return lo < hi ? [lo, hi] : [rawMin, rawMax];
  }

  /** Load and pin the coarsest LOD level with bounded concurrency. */
  private async loadBaseLod(): Promise<void> {
    const t0 = performance.now();
    const maxLod = Math.max(...this.metadata.levels.map(l => l.lod));
    const level = this.metadata.levels.find(l => l.lod === maxLod);
    if (!level) return;

    const [gridX, gridY, gridZ] = level.brickGrid;
    const numChannels = this.resources.numChannels;

    // Build flat list of all brick coords
    const bricks: { bx: number; by: number; bz: number; key: string }[] = [];
    for (let bz = 0; bz < gridZ; bz++) {
      for (let by = 0; by < gridY; by++) {
        for (let bx = 0; bx < gridX; bx++) {
          bricks.push({ bx, by, bz, key: `lod${maxLod}:${bz}/${by}/${bx}` });
        }
      }
    }

    this.baseLodPending = bricks.length;

    // Center-out ordering: the volume's central content appears first instead
    // of a bottom-up z-slab wipe. Cheap and dramatically better perceived load.
    const ccx = (gridX - 1) / 2, ccy = (gridY - 1) / 2, ccz = (gridZ - 1) / 2;
    bricks.sort((a, b) => {
      const da = (a.bx - ccx) ** 2 + (a.by - ccy) ** 2 + (a.bz - ccz) ** 2;
      const db = (b.bx - ccx) ** 2 + (b.by - ccy) ** 2 + (b.bz - ccz) ** 2;
      return da - db;
    });

    const concurrency = Math.min(bricks.length, this.maxConcurrentRequests);
    console.log(`[Kiln] loadBaseLod: ${bricks.length} bricks × ${numChannels} channels (concurrency: ${concurrency})`);

    // Process bricks with bounded concurrency — avoids firing all N×channels network
    // requests simultaneously, which saturates the browser's HTTP connection pool.
    // Uses an async worker-pool pattern: spawn `concurrency` runners that each pull
    // from the shared queue until empty.
    const allBrickData: (Uint8Array | Uint16Array)[] = [];
    let firstBrickMs: number | null = null;
    let sumIsEmptyMs = 0, sumFetchMs = 0, sumUploadMs = 0, brickCount = 0;

    // Range accumulators — derive float data range and per-channel
    // min/max incrementally from BrickLoadResult stats during base LOD loading.
    const isFloat = this.metadata.isFloat ?? false;
    const needsFloatRange = isFloat && !this.metadata.window; // no OMERO → provisional
    const needsChannelRanges = numChannels > 1 && !this.metadata.channelWindows;
    let floatRangeMin = Infinity, floatRangeMax = -Infinity;
    const channelMins = needsChannelRanges ? new Array(numChannels).fill(Infinity) as number[] : [];
    const channelMaxs = needsChannelRanges ? new Array(numChannels).fill(-Infinity) as number[] : [];

    const queue = [...bricks];

    const processBrick = async ({ bx, by, bz, key }: typeof bricks[0]) => {
      try {
      const tIsEmpty = performance.now();
      const isEmpty = await this.dataProvider.isBrickEmpty(maxLod, bx, by, bz, this.config.emptyBrickThreshold);
      sumIsEmptyMs += performance.now() - tIsEmpty;

      if (isEmpty) {
        this.emptyBricks.add(key);
        this.resources.indirection.setEmpty(bx, by, bz, maxLod);
        return;
      }

      // Load all channels in parallel — ch0 is mandatory, others degrade gracefully
      const tFetch = performance.now();
      const channelResults = await Promise.all(
        Array.from({ length: numChannels }, (_, ch) =>
          this.dataProvider.loadBrick(maxLod, bx, by, bz, ch)
        )
      );
      sumFetchMs += performance.now() - tFetch;

      if (!channelResults[0]) return; // ch0 mandatory; skip brick entirely if it failed

      // Accumulate per-channel stats for range derivation
      for (let ch = 0; ch < numChannels; ch++) {
        const r = channelResults[ch];
        if (!r) continue;
        if (needsFloatRange && r.rawMin !== undefined && r.rawMax !== undefined) {
          if (r.rawMin < floatRangeMin) floatRangeMin = r.rawMin;
          if (r.rawMax > floatRangeMax) floatRangeMax = r.rawMax;
        }
        if (needsChannelRanges) {
          // For non-float: stats are in native [0, 255] or [0, 65535] space.
          // For float: use raw min/max (stats are normalized to provisional range).
          const chMin = isFloat ? (r.rawMin ?? r.min) : r.min;
          const chMax = isFloat ? (r.rawMax ?? r.max) : r.max;
          if (chMin < channelMins[ch]!) channelMins[ch] = chMin;
          if (chMax > channelMaxs[ch]!) channelMaxs[ch] = chMax;
        }
      }

      const result = this.resources.allocator.allocate(this.frameCount);
      if (!result) {
        console.warn('[Kiln] loadBaseLod: atlas allocation failed');
        return;
      }

      const offset: [number, number, number] = [
        result.slot.x * PHYSICAL_BRICK_SIZE,
        result.slot.y * PHYSICAL_BRICK_SIZE,
        result.slot.z * PHYSICAL_BRICK_SIZE,
      ];
      const tUpload = performance.now();
      for (let ch = 0; ch < numChannels; ch++) {
        // Zero-fill failed channels. The "fresh from free list" assumption is
        // only true on cold load — after clear() the allocator recycles slots
        // without re-zeroing texture memory, so skipping would show the
        // previous dataset's data in that channel.
        const data = channelResults[ch]?.data ?? this.getZeroBrick(this.resources.canvases[ch]!.bitDepth);
        writeToCanvas(
          this.device,
          this.resources.canvases[ch]!,
          data,
          [PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE],
          offset
        );
      }
      const uploadMs = performance.now() - tUpload;
      sumUploadMs += uploadMs;
      this.uploadAvg.add(uploadMs);

      this.resources.indirection.setBrick(bx, by, bz, result.slot.x, result.slot.y, result.slot.z, maxLod);
      this.resources.allocator.setMetadata(result.slotIndex, { lod: maxLod, bx, by, bz, key });
      this.resources.allocator.pin(result.slotIndex);

      this.loadedBricks.set(key, { slot: result.slot, slotIndex: result.slotIndex });
      this.pinnedBricks.add(key);
      allBrickData.push(channelResults[0].data);
      brickCount++;

      if (firstBrickMs === null) {
        firstBrickMs = performance.now() - this.loadStartTime;
      }

      // arriving base bricks must trigger a re-render — otherwise the
      // viewer converges on a near-empty scene and freezes while the base LOD
      // silently streams in. The 100 ms debounce coalesces the burst.
      this.scheduleAccumulationReset();
      } finally {
        this.baseLodPending = Math.max(0, this.baseLodPending - 1);
      }
    };

    // Spawn `concurrency` runners that drain the shared queue
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        let brick;
        while ((brick = queue.shift()) !== undefined) {
          await processBrick(brick);
        }
      })
    );

    // Retry any bricks that failed (ch0 network error)
    const failed = bricks.filter(b => !this.loadedBricks.has(b.key) && !this.emptyBricks.has(b.key));
    if (failed.length > 0) {
      console.warn(`[Kiln] loadBaseLod: ${failed.length} bricks failed, retrying sequentially`);
      for (const brick of failed) {
        await processBrick(brick);
      }
    }

    // Any base bricks that still failed after retry must not leave cells at w=0
    // (unloaded → shader treats as invalid → permanent black hole). Mark them as
    // empty so the shader cleanly skips them instead of rendering a broken hole.
    const stillFailed = bricks.filter(b => !this.loadedBricks.has(b.key) && !this.emptyBricks.has(b.key));
    if (stillFailed.length > 0) {
      console.error(`[Kiln] loadBaseLod: ${stillFailed.length} bricks permanently failed — marking empty to prevent holes`);
      for (const { bx, by, bz, key } of stillFailed) {
        this.emptyBricks.add(key);
        this.resources.indirection.setEmpty(bx, by, bz, maxLod);
      }
    }

    const totalMs = performance.now() - t0;
    const firstBrickMsValue = firstBrickMs as number | null;
    const firstBrickStr = firstBrickMsValue !== null ? firstBrickMsValue.toFixed(0) : 'n/a';
    this.baseLodPending = 0;
    this.baseLodLoaded = true;
    this.timeToFirstRender = firstBrickMsValue ?? totalMs;

    // guarantee the completed base LOD is displayed even if the camera
    // never moves again (the debounced per-brick resets may have already
    // fired before the last bricks arrived). Direct call, not debounced.
    this.onResetAccumulation();

    console.log(
      `[Kiln] loadBaseLod done: ${brickCount}/${bricks.length} bricks loaded in ${totalMs.toFixed(0)}ms` +
      ` | first brick: ${firstBrickStr}ms` +
      ` | avg isEmpty: ${(sumIsEmptyMs / bricks.length).toFixed(1)}ms` +
      ` | avg fetch: ${brickCount > 0 ? (sumFetchMs / brickCount).toFixed(1) : 'n/a'}ms` +
      ` | avg upload: ${brickCount > 0 ? (sumUploadMs / brickCount).toFixed(1) : 'n/a'}ms`
    );

    // Finalize derived ranges and push to renderer + workers
    const derivedRanges: {
      dataRange?: [number, number];
      channelRanges?: Array<{ min: number; max: number }>;
    } = {};

    if (needsFloatRange && isFinite(floatRangeMin) && isFinite(floatRangeMax) && floatRangeMin < floatRangeMax) {
      // Percentile-clip (p0.1 / p99.9) using the in-memory base bricks —
      // absolute per-brick extremes let one hot voxel compress the whole
      // contrast range. (Falls back to raw extremes if no brick data.)
      const clipped = allBrickData.length > 0
        ? this.computeFloatPercentileRange(allBrickData as Uint16Array[], floatRangeMin, floatRangeMax)
        : ([floatRangeMin, floatRangeMax] as [number, number]);
      derivedRanges.dataRange = clipped;
      this.metadata.dataRange = clipped;
      // Update workers so future brick stats use the real range
      this.dataProvider.setFloatRange?.(clipped[0], clipped[1]);
      console.log(`[Kiln] derived float range: [${clipped[0]}, ${clipped[1]}] (raw extremes: [${floatRangeMin}, ${floatRangeMax}])`);
    }

    if (needsChannelRanges && channelMins.some(v => isFinite(v))) {
      // Window space must match shader expectations: float windows use
      // raw-space dataRange, integer windows use effective atlas bit depth.
      const effectiveBitDepth = this.resources.canvases[0]!.bitDepth;
      const dtypeMax = effectiveBitDepth === 16 ? 65535 : 255;
      const winMin = isFloat ? (this.metadata.dataRange?.[0] ?? 0) : 0;
      const winMax = isFloat ? (this.metadata.dataRange?.[1] ?? 1) : dtypeMax;
      const ranges: Array<{ min: number; max: number }> = [];
      for (let ch = 0; ch < numChannels; ch++) {
        const cMin = isFinite(channelMins[ch]!) ? channelMins[ch]! : 0;
        const cMax = isFinite(channelMaxs[ch]!) ? channelMaxs[ch]! : (isFinite(channelMins[ch]!) ? channelMins[ch]! + 1 : 1);
        ranges.push({ min: cMin, max: cMax });
      }
      derivedRanges.channelRanges = ranges;
      this.metadata.channelWindows = ranges.map(r => ({ start: r.min, end: r.max, min: winMin, max: winMax }));
      console.log('[Kiln] derived per-channel ranges:', ranges.map((r, i) => `ch${i}: [${r.min}, ${r.max}]`).join(', '));
    }

    if ((derivedRanges.dataRange || derivedRanges.channelRanges) && this.onRangesDerived) {
      this.onRangesDerived(derivedRanges);
    }

    if (allBrickData.length > 0 && this.onBaseLodLoaded) {
      this.onBaseLodLoaded(allBrickData);
    }
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

    // Recompute every frame while moving, immediately on rest, and
    // periodically as a fallback when still.
    const regularUpdate = cameraMoved
      ? true
      : (this.frameCount - this.lastUpdateFrame) >= this.updateInterval;
    const cameraJustStopped = this.cameraStillFrames === this.cameraStillThreshold;

    // Don't start streaming finer LODs until base LOD is fully loaded.
    // loadBaseLod runs independently; fine bricks requested before it finishes
    // have no parent in loadedBricks, so eviction calls clearBrick without a
    // fallback and permanently holes the indirection table.
    if (!this.baseLodLoaded) {
      return false;
    }

    if (regularUpdate || cameraJustStopped) {
      this.lastUpdateFrame = this.frameCount;
      this.computeDesiredSet(camera, canvas);
    }

    // Gate new dispatches during interaction — keep recomputing the desired
    // set (so cancellation stays fresh) but don't start new loads that will
    // likely be stale in 100ms. Stream full detail when the camera settles.
    if (!camera.isInteracting()) {
      this.processLoadQueue();
    }

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
    this.inFlightStaleTime.clear();
    this.dispatchTimestamps.clear();

    // reset the allocator wholesale instead of freeing slot-by-slot.
    // The old per-slot free loop left every pinned base-LOD slot in the
    // allocator's pinned set; after reload those indices were permanently
    // unevictable. reset() clears used, pinned, metadata, and the free list.
    this.resources.allocator.reset();
    this.loadedBricks.clear();
    this.pinnedBricks.clear();
    this.emptyBricks.clear();
    this.brickCache.clear();
    this.desiredKeys.clear();
    this.loadQueue = [];
    this.allocationStalled = false;
    this.baseLodPending = 0;
    this.baseLodLoaded = false;
    this.resources.indirection.clearAll();

    // Reload base LOD
    this.loadBaseLod();
  }

  /**
   * Get current stats
   */
  getStats(): StreamingStats {
    const networkStats = this.dataProvider.getNetworkStats();
    const providerTimings = this.dataProvider.getPipelineTimings?.() ?? {
      avgQueueMs: 0, avgFetchMs: 0, avgAssemblyMs: 0, avgUploadMs: 0, sampleCount: 0,
    };
    return {
      ...this.lastStats,
      pendingCount: this.lastStats.pendingCount + this.baseLodPending,
      totalBytesDownloaded: networkStats.totalBytesDownloaded,
      bytesPerSecond: networkStats.recentBytesPerSecond,
      requestCount: networkStats.requestCount,
      timeToFirstRender: this.timeToFirstRender,
      pipelineTimings: {
        avgQueueMs: providerTimings.avgQueueMs,
        avgFetchMs: providerTimings.avgFetchMs,
        avgAssemblyMs: providerTimings.avgAssemblyMs,
        avgUploadMs: this.uploadAvg.value,
        sampleCount: Math.max(providerTimings.sampleCount, this.uploadAvg.count),
        chunkCacheHitRatio: providerTimings.chunkCacheHitRatio,
      },
      bricksDispatched: this.bricksDispatched,
      bricksCommitted: this.bricksCommitted,
      bricksCancelled: this.bricksCancelled,
      bricksDiscarded: this.bricksDiscarded,
      avgBrickLatencyMs: this.brickLatencyAvg.value,
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

    // a fresh desired set is the retry point for refused allocations.
    this.allocationStalled = false;

    // Get frustum planes
    const aspect = canvas.width / canvas.height;
    const viewMatrix = camera.getViewMatrix();
    const projMatrix = camera.getProjectionMatrix(aspect);
    const viewProj = mat4.multiply(projMatrix, viewMatrix);
    const frustum = extractFrustumPlanes(viewProj);

    // projectionFactor targets full canvas resolution — LOD selection pre-loads
    // fine bricks during interaction; dispatch gating prevents wasted loads.
    this.projectionFactor = canvas.height / (2 * Math.tan(this.cameraFovRad / 2));

    // Get LOD range from metadata
    const maxLod = Math.max(...this.metadata.levels.map(l => l.lod));

    // Desired bricks from traversal
    const desiredBricks: BrickRequest[] = [];

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

      // SSE hysteresis: keep splitting while children exist and error > 70%
      // of maxPixelError, preventing LOD oscillation during gestures.
      let shouldSplit: boolean;
      if (projectedError > this.maxPixelError) {
        shouldSplit = lod > 0;
      } else if (lod > 0 && projectedError > this.maxPixelError * 0.7) {
        // In hysteresis band — only keep splitting if children are already resident
        shouldSplit = this.hasResidentChildren(bx, by, bz, lod);
      } else {
        shouldSplit = false;
      }

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

    // Cancel in-flight requests no longer desired, with a grace period
    // to avoid fetch thrash from LOD oscillation near the SSE threshold.
    let cancelledCount = 0;
    const now = performance.now();
    for (const [key, controller] of this.inFlightRequests.entries()) {
      if (this.desiredKeys.has(key)) {
        // Still desired — clear any stale timestamp
        this.inFlightStaleTime.delete(key);
      } else {
        const staleTime = this.inFlightStaleTime.get(key);
        if (staleTime === undefined) {
          // First frame this request left the desired set — start grace period
          this.inFlightStaleTime.set(key, now);
        } else if (now - staleTime > this.CANCEL_GRACE_MS) {
          // Grace period expired — this request is genuinely stale, abort it
          controller.abort();
          this.inFlightRequests.delete(key);
          this.inFlightStaleTime.delete(key);
          this.bricksCancelled++;
          cancelledCount++;
        }
      }
    }

    // Touch all desired bricks that are already loaded
    let loadedCount = 0;
    for (const brick of desiredBricks) {
      const entry = this.loadedBricks.get(brick.key);
      if (entry) {
        this.resources.allocator.touch(entry.slotIndex, this.frameCount);
        loadedCount++;
      }
    }

    // Always touch pinned bricks to keep them at the front of LRU
    for (const key of this.pinnedBricks) {
      const entry = this.loadedBricks.get(key);
      if (entry) {
        this.resources.allocator.touch(entry.slotIndex, this.frameCount);
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
      cancelledCount,
      atlasUsage: this.resources.allocator.usedCount,
      atlasCapacity: this.resources.allocator.totalSlots,
      // Network stats placeholders - actual values come from getStats()
      totalBytesDownloaded: 0,
      bytesPerSecond: 0,
      requestCount: 0,
      timeToFirstRender: null, // Actual value comes from getStats()
      evictedCount: this.lastStats.evictedCount,
      allocationsRefused: this.lastStats.allocationsRefused,
      pipelineTimings: { avgQueueMs: 0, avgFetchMs: 0, avgAssemblyMs: 0, avgUploadMs: 0, sampleCount: 0 },
      bricksDispatched: 0, // live values from getStats()
      bricksCommitted: 0,
      bricksCancelled: 0,
      bricksDiscarded: 0,
      avgBrickLatencyMs: 0,
    };
  }

  // Helper method reference (assigned in computeDesiredSet)
  private addDesiredBrick: (bricks: BrickRequest[], bx: number, by: number, bz: number, lod: number, dist: number) => void = () => {};

  /**
   * Process pending load requests (non-blocking)
   */
  private processLoadQueue(): void {
    // an allocation was refused since the last desired-set
    // recompute — don't burn network/worker time on bricks that can't get a
    // slot. computeDesiredSet clears the flag (retry point).
    if (this.allocationStalled) return;

    // Start new requests up to max concurrent
    while (
      this.inFlightRequests.size < this.maxConcurrentRequests &&
      this.loadQueue.length > 0
    ) {
      // pre-dispatch check: if the atlas is full and nothing is
      // evictable, stop dispatching *before* paying the fetch cost.
      if (!this.resources.allocator.hasEvictableSlot(this.frameCount)) {
        this.allocationStalled = true;
        break;
      }

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
      this.dispatchTimestamps.set(request.key, performance.now());
      this.bricksDispatched++;

      this.loadBrick(request, controller.signal).finally(() => {
        // Guard against a stale .finally() from an aborted request deleting a newer
        // controller that was registered for the same key in the same sync block.
        if (this.inFlightRequests.get(request.key) === controller) {
          this.inFlightRequests.delete(request.key);
        }
        this.dispatchTimestamps.delete(request.key);
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
    const isEmpty = await this.dataProvider.isBrickEmpty(lod, bx, by, bz, this.config.emptyBrickThreshold);
    if (signal.aborted) return;

    if (isEmpty) {
      this.emptyBricks.add(key);
      this.resources.indirection.setEmpty(bx, by, bz, lod);
      return;
    }

    // Try CPU cache first, fall back to network — load all channels in parallel.
    // Capped to renderer.numChannels (≤ 4) so we never write to a non-existent atlas.
    // Caching deferred until after emptiness check (empty bricks shouldn't evict useful cache entries).
    const numChannels = this.resources.numChannels;
    const fromCache: boolean[] = new Array(numChannels).fill(false);
    const channelResults: (BrickLoadResult | null)[] = await Promise.all(
      Array.from({ length: numChannels }, async (_, ch) => {
        const cacheKey = `ch${ch}:${key}`;
        const cached = this.brickCache.get(cacheKey);
        if (cached) {
          fromCache[ch] = true;
          // Cached data has no stats — use 1 for max so it's never treated as empty
          return { data: cached, min: 0, max: 1, avg: 0 } as BrickLoadResult;
        }
        return this.dataProvider.loadBrick(lod, bx, by, bz, ch, signal);
      })
    );
    if (signal.aborted) return;

    // ch0 mandatory; other channels degrade gracefully (retry re-fetches missing ones).
    if (!channelResults[0]) return;

    // Emptiness check via inline stats. Skipped for cache-served bricks
    // (sentinel stats would false-positive; cached bricks are already proven non-empty).
    if (!fromCache.some(v => v)) {
      const threshold = this.config.emptyBrickThreshold ?? 1;
      const maxAcrossChannels = Math.max(...channelResults.map(r => r?.max ?? 0));
      if (maxAcrossChannels < threshold) {
        this.emptyBricks.add(key);
        this.resources.indirection.setEmpty(bx, by, bz, lod);
        return;
      }
    }

    // brick is known non-empty — now it's worth caching. (Done before the
    // desired-set check: a brick fetched but no longer desired is still likely
    // to be desired again soon.)
    for (let ch = 0; ch < numChannels; ch++) {
      const r = channelResults[ch];
      if (r && !fromCache[ch]) {
        this.brickCache.put(`ch${ch}:${key}`, r.data);
      }
    }

    // Camera may have moved while the fetch was in flight — skip if no longer desired
    if (!this.desiredKeys.has(key)) {
      this.bricksDiscarded++;
      return;
    }

    // Allocate one slot (shared atlas position across all channels)
    const result = this.resources.allocator.allocate(this.frameCount);
    if (!result) {
      // silent backpressure — the brick stays desired and retries after
      // the next computeDesiredSet; the shader keeps rendering the coarser
      // parent via indirection, so a refusal costs nothing visually.
      this.allocationStalled = true;
      this.lastStats.allocationsRefused++;
      return;
    }

    // Handle eviction
    if (result.evicted) {
      this.lastStats.evictedCount++;
      const evictedKey = result.evicted.key;
      const evictedEntry = this.loadedBricks.get(evictedKey);

      if (!evictedEntry || evictedEntry.slotIndex === result.slotIndex) {
        const fallback = this.findParentBrick(result.evicted.bx, result.evicted.by, result.evicted.bz, result.evicted.lod);

        if (fallback) {
          this.resources.indirection.clearBrick(
            result.evicted.bx,
            result.evicted.by,
            result.evicted.bz,
            result.evicted.lod,
            [fallback.slot.x, fallback.slot.y, fallback.slot.z],
            fallback.lod
          );
        } else if (this.hasEmptyAncestor(result.evicted.bx, result.evicted.by, result.evicted.bz, result.evicted.lod)) {
          // Ancestor is known-empty — restore empty marker (w=255) so the
          // shader skips this region instead of treating w=0 as unloaded.
          this.resources.indirection.setEmpty(
            result.evicted.bx,
            result.evicted.by,
            result.evicted.bz,
            result.evicted.lod
          );
        } else {
          // No parent found - clear completely (shouldn't happen if base LOD is loaded)
          this.resources.indirection.clearBrick(
            result.evicted.bx,
            result.evicted.by,
            result.evicted.bz,
            result.evicted.lod
          );
        }
        this.loadedBricks.delete(evictedKey);
      }

    }

    // Upload each channel to its atlas at the same slot coordinates (timed for pipeline telemetry).
    // failed channels are zero-filled — the slot may be a reused
    // (evicted) slot still holding a previous brick's data for that channel.
    const offset: [number, number, number] = [
      result.slot.x * PHYSICAL_BRICK_SIZE,
      result.slot.y * PHYSICAL_BRICK_SIZE,
      result.slot.z * PHYSICAL_BRICK_SIZE,
    ];
    const tUpload = performance.now();
    for (let ch = 0; ch < numChannels; ch++) {
      const data = channelResults[ch]?.data ?? this.getZeroBrick(this.resources.canvases[ch]!.bitDepth);
      writeToCanvas(
        this.device,
        this.resources.canvases[ch]!,
        data,
        [PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE],
        offset
      );
    }
    this.uploadAvg.add(performance.now() - tUpload);

    // Update indirection
    this.resources.indirection.setBrick(bx, by, bz, result.slot.x, result.slot.y, result.slot.z, lod);

    // Set metadata for future eviction
    this.resources.allocator.setMetadata(result.slotIndex, { lod, bx, by, bz, key });

    // Track
    this.loadedBricks.set(key, { slot: result.slot, slotIndex: result.slotIndex });
    this.bricksCommitted++;

    // Record end-to-end latency (dispatch → committed)
    const dispatchTime = this.dispatchTimestamps.get(key);
    if (dispatchTime !== undefined) {
      this.brickLatencyAvg.add(performance.now() - dispatchTime);
    }

    // Schedule accumulation reset to prevent constant flickering during streaming bursts
    this.scheduleAccumulationReset();
  }

  private scheduleAccumulationReset(): void {
    if (this.resetAccumulationTimer !== null) {
      clearTimeout(this.resetAccumulationTimer);
    }
    this.resetAccumulationTimer = setTimeout(() => {
      this.onResetAccumulation();
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

    const normalizedSize = this.config.normalizedSize;
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
    const normalizedSize = this.config.normalizedSize;
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

  /** Check if any child brick (one LOD finer) is loaded or in-flight (SSE hysteresis). */
  private hasResidentChildren(bx: number, by: number, bz: number, lod: number): boolean {
    const finerLod = lod - 1;
    if (finerLod < 0) return false;
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const childKey = `lod${finerLod}:${bz * 2 + dz}/${by * 2 + dy}/${bx * 2 + dx}`;
          if (this.loadedBricks.has(childKey) || this.inFlightRequests.has(childKey)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** Check if any ancestor brick is known-empty (for eviction fallback). */
  private hasEmptyAncestor(bx: number, by: number, bz: number, lod: number): boolean {
    const maxLod = Math.max(...this.metadata.levels.map(l => l.lod));
    for (let parentLod = lod + 1; parentLod <= maxLod; parentLod++) {
      const scale = 1 << (parentLod - lod);
      const parentKey = `lod${parentLod}:${Math.floor(bz / scale)}/${Math.floor(by / scale)}/${Math.floor(bx / scale)}`;
      if (this.emptyBricks.has(parentKey)) return true;
    }
    return false;
  }
}
