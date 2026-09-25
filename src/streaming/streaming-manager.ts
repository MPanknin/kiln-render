/**
 * StreamingManager - Resident set manager for brick streaming. Selects visible
 * bricks by frustum/LOD, queues priority loads, and cancels stale requests.
 */

import { mat4 } from 'wgpu-matrix';
import { extractFrustumPlanes, isAABBInFrustum } from '../core/camera.js';
import type { ViewParams } from '../core/view.js';
import { isFlagEnabled } from '../core/feature-flags.js';

/** What the renderer will actually show; lets the desired set skip bricks that cannot contribute. */
export interface RenderDemand {
  mode: string;
  /** Clip box in normalised [0,1] volume coordinates. */
  clipMin: [number, number, number];
  clipMax: [number, number, number];
  /** Slice plane positions in [0,1] and their visibility (slice modes only). */
  slices: [number, number, number];
  showSlice: [boolean, boolean, boolean];
}
import type { VolumeResources } from '../core/volume-resources.js';
import type { DataProvider, VolumeMetadata, BrickLoadResult, LodLevel } from '../data/data-provider.js';
import { AtlasSlot } from './atlas-allocator.js';
import type { AllocationResult } from './atlas-allocator.js';
import { BrickCache } from './brick-cache.js';
import { LOGICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE } from '../core/config.js';
import type { DatasetConfig } from '../core/config.js';
import { writeToCanvas } from '../core/volume.js';
import { getFloat16ToFloat32Lut } from '../utils/float16.js';
import type { PipelineTimings } from '../data/data-provider.js';
import { RollingAvg } from '../data/network-tracker.js';
import { createBrickMilestones, stampBaseCoverage } from '../core/milestones.js';
import type { BrickMilestones } from '../core/milestones.js';

// Content commits coalesce for a quiet period, but a redraw is never delayed past the max wait
const RESET_QUIET_MS = 100;
const RESET_MAX_WAIT_MS = 250;
// Base-load window starts here and doubles per finished task, so the first
// bricks own the link; 2 keeps tiny two-brick base levels from serialising.
const BASE_RAMP_START = 2;

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
  bricksFailed: number; // channel 0 load failed; left unloaded (never marked empty) and retried
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

  /** Base-load milestones (performance.now() timestamps); reset by clear(). */
  readonly milestones: BrickMilestones = createBrickMilestones();

  // Current desired set (keys) - updated each computeDesiredSet
  private desiredKeys = new Set<string>();

  // Priority queue for pending loads (sorted by distance, closest first)
  private loadQueue: BrickRequest[] = [];

  // Currently in-flight requests with AbortControllers
  private inFlightRequests = new Map<string, AbortController>();

  // Generation boundary: bumped by loadBaseLod/clear/dispose so stale completions never mutate state
  private generation = 0;
  private baseLoadAbort: AbortController | null = null;
  private disposed = false;

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

  // Coalesced accumulation reset; see notifyContentChanged()
  private resetAccumulationTimer: number | null = null;
  private firstPendingResetAt: number | null = null;
  private contentVersionCounter = 0;

  // GPU upload timing (writeTexture, measured on main thread for all providers)
  private uploadAvg = new RollingAvg();

  // Brick lifecycle telemetry
  private bricksDispatched = 0;
  private bricksCommitted = 0;
  private bricksCancelled = 0;
  private bricksDiscarded = 0;
  private bricksFailed = 0;
  private brickLatencyAvg = new RollingAvg();
  private dispatchTimestamps = new Map<string, number>();

  // Screen-Space Error (SSE) threshold in pixels
  // Split to finer LOD when projected voxel error exceeds this value
  // Lower = higher quality, more bricks loaded
  // Higher = lower quality, fewer bricks loaded
  public maxPixelError = 8.0;

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

  // Per slot: channel bits ever written (fresh texture memory is zero, so an
  // unwritten channel region needs no zero-fill). Survives clear() like the texture.
  private dirtyChannels = new Map<number, number>();
  // Per slot: channel bits currently holding the resident brick's data.
  private slotChannels = new Map<number, number>();

  // Only channels the renderer displays are streamed; hidden ones are
  // fetched for resident bricks when they become visible (setVisibleChannels).
  private visibleMask = 0xf;
  private fillAbort: AbortController | null = null;

  // ?p30=1 slice-aware / ?p31=1 clip-aware demand; ?p32=1 refinement ramp-up.
  private readonly sliceDemand = isFlagEnabled('p30');
  private readonly clipDemand = isFlagEnabled('p31');
  private readonly refineRamp = isFlagEnabled('p32');
  private demand: RenderDemand | null = null;
  private refineWindow = 2;
  // Channels shown while the base was still loading; backfilled once it completes.
  private pendingVisibleBits = 0;
  private fillPending = 0;

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
    evictedCount: 0,
    allocationsRefused: 0,
    pipelineTimings: { avgQueueMs: 0, avgFetchMs: 0, avgAssemblyMs: 0, avgUploadMs: 0, sampleCount: 0 },
    bricksDispatched: 0,
    bricksCommitted: 0,
    bricksCancelled: 0,
    bricksDiscarded: 0,
    bricksFailed: 0,
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

  // Constant for the dataset — cached to avoid Math.max(...levels.map()) per call
  private readonly maxLod: number;
  // lod -> LodLevel, indexed — avoids a linear .find() per visited octree node
  private readonly levelsByLod: LodLevel[];

  constructor(
    resources: VolumeResources,
    dataProvider: DataProvider,
    metadata: VolumeMetadata,
    device: GPUDevice,
    config: DatasetConfig,
    onResetAccumulation: () => void,
    visibleChannels = 0xf,
  ) {
    this.resources = resources;
    this.onResetAccumulation = onResetAccumulation;
    this.visibleMask = visibleChannels;
    this.dataProvider = dataProvider;
    this.metadata = metadata;
    this.device = device;
    this.config = config;

    this.maxLod = metadata.maxLod;
    this.levelsByLod = [];
    for (const level of metadata.levels) this.levelsByLod[level.lod] = level;

    // Scale concurrent requests and cache budget for multichannel
    const numChannels = resources.numChannels;
    this.maxConcurrentRequests = numChannels > 1 ? 12 : 8;
    this.brickCache = new BrickCache(numChannels * 256 * 1024 * 1024);

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

  /** Current render demand (mode, clip box, slice planes); called by the engine each frame. */
  setRenderDemand(d: RenderDemand): void {
    this.demand = d;
  }

  /** False if the brick can contribute nothing to the current view (outside clip box / off every slice). */
  private demandAccepts(aabb: { min: [number, number, number]; max: [number, number, number] }, lod: number): boolean {
    const d = this.demand;
    if (!d) return true;
    const ns = this.config.normalizedSize;
    const dims = this.config.dimensions;
    const exp = this.config.levelExponent(lod);
    // One voxel of this level as a margin: sampling at a boundary reads the neighbour.
    const margin = (a: number) => (ns[a]! / dims[a]!) * (1 << exp[a]!);
    if (this.clipDemand) {
      for (let a = 0; a < 3; a++) {
        const lo = (d.clipMin[a]! - 0.5) * ns[a]! - margin(a);
        const hi = (d.clipMax[a]! - 0.5) * ns[a]! + margin(a);
        if (aabb.max[a]! < lo || aabb.min[a]! > hi) return false;
      }
    }
    if (this.sliceDemand && (d.mode === 'slice' || d.mode === 'slice-lod')) {
      for (let a = 0; a < 3; a++) {
        if (!d.showSlice[a]) continue;
        const p = (d.slices[a]! - 0.5) * ns[a]!;
        if (p >= aabb.min[a]! - margin(a) && p <= aabb.max[a]! + margin(a)) return true;
      }
      return false;
    }
    return true;
  }

  /** Channels to fetch for a brick: the visible ones (never empty). */
  private channelsToLoad(): number[] {
    const n = this.resources.numChannels;
    const all = Array.from({ length: n }, (_, i) => i);
    const vis = all.filter(ch => (this.visibleMask >> ch) & 1);
    return vis.length > 0 ? vis : [0];
  }

  /** Write one channel of a slot (null = zeros) and keep the per-slot channel bits in sync. */
  private writeSlotChannel(slotIndex: number, slot: AtlasSlot, ch: number, data: Uint8Array | Uint16Array | null): void {
    writeToCanvas(
      this.device,
      this.resources.canvases[ch]!,
      data ?? this.getZeroBrick(this.resources.canvases[ch]!.bitDepth),
      [PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE],
      [slot.x * PHYSICAL_BRICK_SIZE, slot.y * PHYSICAL_BRICK_SIZE, slot.z * PHYSICAL_BRICK_SIZE]
    );
    const bit = 1 << ch;
    this.dirtyChannels.set(slotIndex, (this.dirtyChannels.get(slotIndex) ?? 0) | bit);
    const have = this.slotChannels.get(slotIndex) ?? 0;
    this.slotChannels.set(slotIndex, data ? have | bit : have & ~bit);
  }

  /** Zero every channel region of a freshly (re)allocated slot that still holds older data. */
  private zeroStaleChannels(slotIndex: number, slot: AtlasSlot, except: number): void {
    const dirty = this.dirtyChannels.get(slotIndex) ?? 0;
    this.slotChannels.set(slotIndex, 0);
    for (let c = 0; c < this.resources.numChannels; c++) {
      if (c !== except && (dirty >> c) & 1) this.writeSlotChannel(slotIndex, slot, c, null);
    }
  }

  /** Renderer-visible channel bitmask. Newly visible channels are fetched for every resident
   *  brick that lacks them; hiding costs nothing. */
  setVisibleChannels(mask: number): void {
    if (this.disposed) return;
    const added = mask & ~this.visibleMask;
    this.visibleMask = mask;
    if (!added) return;
    if (this.baseLodLoaded) this.fillMissingChannels(added);
    else this.pendingVisibleBits |= added;
  }

  private fillMissingChannels(bits: number): void {
    const gen = this.generation;
    if (!this.fillAbort) this.fillAbort = new AbortController();
    const signal = this.fillAbort.signal;
    const work: { key: string; slotIndex: number; slot: AtlasSlot; ch: number }[] = [];
    for (const [key, entry] of this.loadedBricks) {
      const have = this.slotChannels.get(entry.slotIndex) ?? 0;
      for (let ch = 0; ch < this.resources.numChannels; ch++) {
        if (!((bits >> ch) & 1) || (have >> ch) & 1) continue;
        // Stale data from an earlier brick would show the moment alpha > 0: zero it now.
        if ((this.dirtyChannels.get(entry.slotIndex) ?? 0) >> ch & 1) this.writeSlotChannel(entry.slotIndex, entry.slot, ch, null);
        work.push({ key, slotIndex: entry.slotIndex, slot: entry.slot, ch });
      }
    }
    if (work.length === 0) return;
    this.notifyContentChanged();
    this.fillPending += work.length;

    const runOne = async ({ key, slotIndex, slot, ch }: typeof work[0]) => {
      const m = /^lod(\d+):(\d+)\/(\d+)\/(\d+)$/.exec(key);
      if (!m) return;
      const [lod, bz, by, bx] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      const cached = this.brickCache.get(`ch${ch}:${key}`);
      const r = cached ? { data: cached } : await this.dataProvider.loadBrick(lod, bx, by, bz, ch, signal);
      if (gen !== this.generation || !r) return;
      const cur = this.loadedBricks.get(key);
      if (!cur || cur.slotIndex !== slotIndex || !((this.visibleMask >> ch) & 1)) return; // evicted, replaced or hidden again
      if (!cached) this.brickCache.put(`ch${ch}:${key}`, r.data);
      this.writeSlotChannel(slotIndex, slot, ch, r.data);
      this.notifyContentChanged();
    };
    const queue = [...work];
    const concurrency = Math.min(queue.length, this.maxConcurrentRequests);
    void Promise.all(Array.from({ length: concurrency }, async () => {
      let item;
      while ((item = queue.shift()) !== undefined && gen === this.generation) {
        try { await runOne(item); } finally { this.fillPending--; }
      }
    }));
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

    const lut = getFloat16ToFloat32Lut();

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
    const maxLod = this.maxLod;
    const level = this.levelsByLod[maxLod];
    if (!level) return;

    const gen = ++this.generation;
    const stale = () => gen !== this.generation;
    this.baseLoadAbort?.abort();
    const abort = new AbortController();
    this.baseLoadAbort = abort;

    const [gridX, gridY, gridZ] = level.brickGrid;
    const numChannels = this.resources.numChannels;
    const loadChannels = this.channelsToLoad();

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

    // Cheapest bricks (fewest source chunks) first so the first image needs the
    // least bytes; centre-out breaks ties so central content appears first.
    const ccx = (gridX - 1) / 2, ccy = (gridY - 1) / 2, ccz = (gridZ - 1) / 2;
    const centerDist2 = (b: typeof bricks[0]) => (b.bx - ccx) ** 2 + (b.by - ccy) ** 2 + (b.bz - ccz) ** 2;
    const cost = new Map<string, number>();
    for (const b of bricks) cost.set(b.key, this.dataProvider.estimateBrickCost?.(maxLod, b.bx, b.by, b.bz) ?? 1);
    bricks.sort((a, b) => {
      const dc = (cost.get(a.key) ?? 1) - (cost.get(b.key) ?? 1);
      return dc !== 0 ? dc : centerDist2(a) - centerDist2(b);
    });

    const maxConcurrency = Math.min(bricks.length, this.maxConcurrentRequests);
    const maxWindow = maxConcurrency * loadChannels.length;
    let window = Math.min(maxWindow, BASE_RAMP_START);
    console.log(`[Kiln] loadBaseLod: ${bricks.length} bricks × ${loadChannels.length}/${numChannels} channels (window ${window}→${maxWindow})`);

    const allBrickData: (Uint8Array | Uint16Array)[] = [];
    const resolved = new Set<string>(); // bricks that reached resident or empty
    let sumIsEmptyMs = 0, sumFetchMs = 0, sumUploadMs = 0, brickCount = 0;

    // Range accumulators — derive float data range and per-channel
    // min/max incrementally from BrickLoadResult stats during base LOD loading.
    const isFloat = this.metadata.isFloat ?? false;
    const needsFloatRange = isFloat && !this.metadata.window; // no OMERO → provisional
    const needsChannelRanges = numChannels > 1 && !this.metadata.channelWindows;
    let floatRangeMin = Infinity, floatRangeMax = -Infinity;
    const channelMins = needsChannelRanges ? new Array(numChannels).fill(Infinity) as number[] : [];
    const channelMaxs = needsChannelRanges ? new Array(numChannels).fill(-Infinity) as number[] : [];

    const accumulateStats = (ch: number, r: BrickLoadResult) => {
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
    };

    // null data zero-fills a channel; a recycled slot may still hold an
    // older brick there.
    const uploadChannel = (slot: AllocationResult, ch: number, data: Uint8Array | Uint16Array | null) =>
      this.writeSlotChannel(slot.slotIndex, slot.slot, ch, data);

    // Point the indirection table at the slot and pin it; first commit stamps the milestone.
    const registerSlot = (slot: AllocationResult, bx: number, by: number, bz: number, key: string) => {
      this.resources.indirection.setBrick(bx, by, bz, slot.slot.x, slot.slot.y, slot.slot.z, maxLod);
      this.resources.allocator.setMetadata(slot.slotIndex, { lod: maxLod, bx, by, bz, key });
      this.resources.allocator.pin(slot.slotIndex);
      this.loadedBricks.set(key, { slot: slot.slot, slotIndex: slot.slotIndex });
      this.pinnedBricks.add(key);
      brickCount++;
      if (this.milestones.firstAtlasCommit === null) {
        this.milestones.firstAtlasCommit = performance.now();
        // First visible content: present it now rather than after the
        // accumulation-reset debounce (~100 ms) that coalesces later commits.
        this.notifyContentChanged();
        this.flushAccumulationReset();
      }
    };

    // A brick has settled once every channel task finished (loaded, empty or failed).
    const settleBrick = (key: string) => {
      if (stale()) return;
      this.baseLodPending = Math.max(0, this.baseLodPending - 1);
      if (this.loadedBricks.has(key) || this.emptyBricks.has(key)) {
        resolved.add(key);
        stampBaseCoverage(this.milestones, resolved.size, bricks.length, performance.now());
      }
    };

    // One task per (brick, channel): the first channel to land allocates the
    // slot (zeroing stale channels) and shows the brick; later ones fill in.
    interface BrickState { slot: AllocationResult | null; settled: number; empty: boolean | null; allocFailed: boolean }
    const states = new Map<string, BrickState>();
    let ch0Settled = 0;
    const stateFor = (key: string) => {
      let st = states.get(key);
      if (!st) { st = { slot: null, settled: 0, empty: null, allocFailed: false }; states.set(key, st); }
      return st;
    };

    const processBrickChannel = async ({ bx, by, bz, key }: typeof bricks[0], ch: number) => {
      const st = stateFor(key);
      try {
      if (st.empty === null) {
        const tIsEmpty = performance.now();
        st.empty = await this.dataProvider.isBrickEmpty(maxLod, bx, by, bz, this.config.emptyBrickThreshold);
        sumIsEmptyMs += performance.now() - tIsEmpty;
        if (stale()) return;
        if (st.empty) {
          this.emptyBricks.add(key);
          this.resources.indirection.setEmpty(bx, by, bz, maxLod);
        }
      }
      if (st.empty || st.allocFailed) return;

      const tFetch = performance.now();
      const r = await this.dataProvider.loadBrick(maxLod, bx, by, bz, ch, abort.signal);
      sumFetchMs += performance.now() - tFetch;
      if (stale() || !r) return;
      if (this.milestones.firstBrickDecoded === null) this.milestones.firstBrickDecoded = performance.now();
      accumulateStats(ch, r);
      if (ch === 0) allBrickData.push(r.data);

      const tUpload = performance.now();
      if (!st.slot) {
        st.slot = this.resources.allocator.allocate(this.frameCount);
        if (!st.slot) {
          st.allocFailed = true;
          console.warn('[Kiln] loadBaseLod: atlas allocation failed');
          return;
        }
        this.zeroStaleChannels(st.slot.slotIndex, st.slot.slot, ch);
        uploadChannel(st.slot, ch, r.data);
        registerSlot(st.slot, bx, by, bz, key);
      } else {
        uploadChannel(st.slot, ch, r.data);
      }
      const uploadMs = performance.now() - tUpload;
      sumUploadMs += uploadMs;
      this.uploadAvg.add(uploadMs);
      this.notifyContentChanged();
      } finally {
        if (ch === loadChannels[0] && ++ch0Settled === bricks.length && this.milestones.baseChannel0Complete === null && !stale()) {
          this.milestones.baseChannel0Complete = performance.now();
        }
        if (++st.settled === loadChannels.length) settleBrick(key);
      }
    };

    // Channel-major: every brick's first visible channel, then the next, so a
    // complete one-channel image lands in 1/N of the time and the rest fill in.
    const tasks: (() => Promise<void>)[] =
      loadChannels.map(ch => bricks.map(b => () => processBrickChannel(b, ch))).flat();

    // Drain with a window that doubles per finished task up to maxWindow.
    await new Promise<void>(resolve => {
      let active = 0;
      const pump = () => {
        while (active < window && tasks.length > 0 && !stale()) {
          const task = tasks.shift()!;
          active++;
          task().finally(() => {
            active--;
            window = Math.min(maxWindow, window * 2);
            pump();
          });
        }
        if (active === 0) resolve();
      };
      pump();
    });
    if (stale()) return;

    // Retry any bricks that failed (network error on every channel)
    const failed = bricks.filter(b => !this.loadedBricks.has(b.key) && !this.emptyBricks.has(b.key));
    if (failed.length > 0) {
      console.warn(`[Kiln] loadBaseLod: ${failed.length} bricks failed, retrying sequentially`);
      for (const brick of failed) {
        const st = states.get(brick.key);
        if (st) st.settled = 0;
        for (const ch of loadChannels) await processBrickChannel(brick, ch);
      }
    }
    if (stale()) return;

    // Bricks that still failed stay unloaded (w=0 renders as nothing, like empty) and
    // are retried by the regular refinement path. Failure is not emptiness.
    const stillFailed = bricks.filter(b => !this.loadedBricks.has(b.key) && !this.emptyBricks.has(b.key));
    if (stillFailed.length > 0) {
      this.bricksFailed += stillFailed.length;
      console.error(`[Kiln] loadBaseLod: ${stillFailed.length} bricks failed after retry — left unloaded`);
    }

    const now = performance.now();
    const totalMs = now - t0;
    const firstCommit = this.milestones.firstAtlasCommit;
    const firstBrickStr = firstCommit !== null ? (firstCommit - t0).toFixed(0) : 'n/a';
    this.baseLodPending = 0;
    this.baseLodLoaded = true;
    stampBaseCoverage(this.milestones, resolved.size, bricks.length, now);
    if (this.milestones.baseChannel0Complete === null) this.milestones.baseChannel0Complete = now;
    this.milestones.baseComplete = now;

    // Show the completed base LOD right away, even if the camera never moves again
    this.flushAccumulationReset();

    // Channels made visible during the base load could not join it; fetch them now.
    if (this.pendingVisibleBits) {
      const bits = this.pendingVisibleBits;
      this.pendingVisibleBits = 0;
      this.fillMissingChannels(bits);
    }

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
  update(view: ViewParams): void {
    if (this.disposed) return;
    this.frameCount++;

    const cameraPos: [number, number, number] = [
      view.position[0]!,
      view.position[1]!,
      view.position[2]!,
    ];

    // Detect camera movement
    const cameraMoved = this.hasCameraMoved(cameraPos);

    if (cameraMoved) {
      this.cameraStillFrames = 0;
      this.lastCameraPos = cameraPos;
    } else {
      this.cameraStillFrames++;
    }

    // Throttled to every updateInterval frames, both while moving and while
    // still — dispatch is gated during interaction anyway (see below), and
    // cancellation has its own grace period, so per-frame recompute during
    // movement bought nothing but full octree traversals at the tightest
    // frame budget. Recompute immediately the instant the camera stops.
    const regularUpdate = (this.frameCount - this.lastUpdateFrame) >= this.updateInterval;
    const cameraJustStopped = this.cameraStillFrames === this.cameraStillThreshold;

    // Don't start streaming finer LODs until base LOD is fully loaded.
    // loadBaseLod runs independently; fine bricks requested before it finishes
    // have no parent in loadedBricks, so eviction calls clearBrick without a
    // fallback and permanently holes the indirection table.
    if (!this.baseLodLoaded) {
      return;
    }

    if (regularUpdate || cameraJustStopped) {
      this.lastUpdateFrame = this.frameCount;
      // A settled camera starts a new refinement burst: let the first bricks own the link.
      if (cameraJustStopped) this.refineWindow = 2;
      this.computeDesiredSet(view);
    }

    // Gate new dispatches during interaction — keep recomputing the desired
    // set (so cancellation stays fresh) but don't start new loads that will
    // likely be stale in 100ms. Stream full detail when the camera settles.
    if (view.interacting !== true) {
      this.processLoadQueue();
    }
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
  forceUpdate(view: ViewParams): void {
    if (this.disposed) return;
    this.lastUpdateFrame = this.frameCount;
    this.computeDesiredSet(view);
  }

  /**
   * Clear all state
   */
  /** Abort all work and drop timers; the manager is inert afterwards. GPU resources are owned by VolumeResources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.baseLoadAbort?.abort();
    this.fillAbort?.abort();
    for (const controller of this.inFlightRequests.values()) controller.abort();
    this.inFlightRequests.clear();
    this.loadQueue = [];
    this.cancelAccumulationReset();
  }

  clear(): void {
    if (this.disposed) return;
    // Cancel all in-flight requests
    for (const controller of this.inFlightRequests.values()) {
      controller.abort();
    }
    this.inFlightRequests.clear();
    this.inFlightStaleTime.clear();
    this.dispatchTimestamps.clear();
    this.cancelAccumulationReset();
    Object.assign(this.milestones, createBrickMilestones());

    // reset the allocator wholesale instead of freeing slot-by-slot.
    // The old per-slot free loop left every pinned base-LOD slot in the
    // allocator's pinned set; after reload those indices were permanently
    // unevictable. reset() clears used, pinned, metadata, and the free list.
    this.resources.allocator.reset();
    this.fillAbort?.abort();
    this.fillAbort = null;
    this.fillPending = 0;
    this.pendingVisibleBits = 0;
    this.slotChannels.clear();
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
      pendingCount: this.lastStats.pendingCount + this.baseLodPending + this.fillPending,
      totalBytesDownloaded: networkStats.totalBytesDownloaded,
      bytesPerSecond: networkStats.recentBytesPerSecond,
      requestCount: networkStats.requestCount,
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
      bricksFailed: this.bricksFailed,
      avgBrickLatencyMs: this.brickLatencyAvg.value,
    };
  }

  /**
   * Compute the desired set of bricks based on camera position and frustum
   * Uses Screen-Space Error (SSE) for LOD selection
   */
  private computeDesiredSet(view: ViewParams): void {
    const cameraPos: [number, number, number] = [
      view.position[0]!,
      view.position[1]!,
      view.position[2]!,
    ];

    // a fresh desired set is the retry point for refused allocations.
    this.allocationStalled = false;

    // Get frustum planes
    const viewProj = mat4.multiply(view.proj, view.view);
    const frustum = extractFrustumPlanes(viewProj);

    // projectionFactor targets full viewport resolution — LOD selection pre-loads
    // fine bricks during interaction; dispatch gating prevents wasted loads.
    this.projectionFactor = view.height / (2 * Math.tan(view.fovY / 2));

    // Get LOD range from metadata
    const maxLod = this.maxLod;

    // Desired bricks from traversal
    const desiredBricks: BrickRequest[] = [];

    // Recursive traversal function
    const traverse = (bx: number, by: number, bz: number, lod: number): void => {
      const level = this.levelsByLod[lod];
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
      // Demand culling (never the base level, which stays pinned)
      if (lod !== maxLod && !this.demandAccepts(aabb, lod)) return;

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
        const finerLevel = this.levelsByLod[lod - 1];
        if (!finerLevel) {
          // No finer LOD available, use current
          this.addDesiredBrick(desiredBricks, bx, by, bz, lod, dist);
          return;
        }

        // Children per axis follow the level model (1 or 2); bounds-check at the finer grid
        const [finerGridX, finerGridY, finerGridZ] = finerLevel.brickGrid;
        const nextLod = lod - 1;
        const [nx, ny, nz] = this.config.childCounts(lod);

        for (let dz = 0; dz < nz; dz++) {
          for (let dy = 0; dy < ny; dy++) {
            for (let dx = 0; dx < nx; dx++) {
              const cx = bx * nx + dx;
              const cy = by * ny + dy;
              const cz = bz * nz + dz;

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
    const rootLevel = this.levelsByLod[maxLod];
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
      evictedCount: this.lastStats.evictedCount,
      allocationsRefused: this.lastStats.allocationsRefused,
      pipelineTimings: { avgQueueMs: 0, avgFetchMs: 0, avgAssemblyMs: 0, avgUploadMs: 0, sampleCount: 0 },
      bricksDispatched: 0, // live values from getStats()
      bricksCommitted: 0,
      bricksCancelled: 0,
      bricksDiscarded: 0,
      bricksFailed: 0,
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
      this.inFlightRequests.size < (this.refineRamp ? Math.min(this.maxConcurrentRequests, this.refineWindow) : this.maxConcurrentRequests) &&
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
      // May replace a coarse parent already on screen — the region must redraw
      this.notifyContentChanged();
      return;
    }

    // Try CPU cache first, fall back to network — load all channels in parallel.
    // Capped to renderer.numChannels (≤ 4) so we never write to a non-existent atlas.
    // Caching deferred until after emptiness check (empty bricks shouldn't evict useful cache entries).
    const numChannels = this.resources.numChannels;
    const loadChannels = this.channelsToLoad();
    const fromCache: boolean[] = new Array(numChannels).fill(false);
    const channelResults: (BrickLoadResult | null)[] = new Array(numChannels).fill(null);
    await Promise.all(
      loadChannels.map(async (ch) => {
        const cacheKey = `ch${ch}:${key}`;
        const cached = this.brickCache.get(cacheKey);
        if (cached) {
          fromCache[ch] = true;
          // Cached data has no stats — use 1 for max so it's never treated as empty
          channelResults[ch] = { data: cached, min: 0, max: 1, avg: 0 } as BrickLoadResult;
          return;
        }
        channelResults[ch] = await this.dataProvider.loadBrick(lod, bx, by, bz, ch, signal);
      })
    );
    if (signal.aborted) return;

    // first loaded channel mandatory; other channels degrade gracefully (retry re-fetches missing ones).
    if (!channelResults[loadChannels[0]!]) {
      this.bricksFailed++;
      return;
    }

    // Emptiness check via inline stats. Skipped for cache-served bricks
    // (sentinel stats would false-positive; cached bricks are already proven non-empty).
    if (!fromCache.some(v => v)) {
      const threshold = this.config.emptyBrickThreshold ?? 1;
      const maxAcrossChannels = Math.max(...channelResults.map(r => r?.max ?? 0));
      if (maxAcrossChannels < threshold) {
        this.emptyBricks.add(key);
        this.resources.indirection.setEmpty(bx, by, bz, lod);
        this.notifyContentChanged();
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
    const tUpload = performance.now();
    const dirty = this.dirtyChannels.get(result.slotIndex) ?? 0;
    this.slotChannels.set(result.slotIndex, 0);
    for (let ch = 0; ch < numChannels; ch++) {
      const data = channelResults[ch]?.data ?? null;
      // Channels not loaded (hidden or failed) are zeroed only if the slot region is stale.
      if (data || (dirty >> ch) & 1) this.writeSlotChannel(result.slotIndex, result.slot, ch, data);
    }
    this.uploadAvg.add(performance.now() - tUpload);

    // Update indirection
    this.resources.indirection.setBrick(bx, by, bz, result.slot.x, result.slot.y, result.slot.z, lod);

    // Set metadata for future eviction
    this.resources.allocator.setMetadata(result.slotIndex, { lod, bx, by, bz, key });

    // Track
    this.loadedBricks.set(key, { slot: result.slot, slotIndex: result.slotIndex });
    this.bricksCommitted++;
    this.refineWindow = Math.min(this.maxConcurrentRequests, this.refineWindow * 2);

    // A channel shown while this fetch was in flight is not in loadChannels: backfill it.
    const missing = this.visibleMask & ~(this.slotChannels.get(result.slotIndex) ?? 0) & ((1 << numChannels) - 1);
    if (missing) this.fillMissingChannels(missing);

    // Record end-to-end latency (dispatch → committed)
    const dispatchTime = this.dispatchTimestamps.get(key);
    if (dispatchTime !== undefined) {
      this.brickLatencyAvg.add(performance.now() - dispatchTime);
    }

    this.notifyContentChanged();
  }

  /** Bumped on every visible content commit (brick upload or empty marker). */
  get contentVersion(): number {
    return this.contentVersionCounter;
  }

  /** Record a content commit and schedule the accumulation reset that displays it. */
  private notifyContentChanged(): void {
    this.contentVersionCounter++;
    this.scheduleAccumulationReset();
  }

  private scheduleAccumulationReset(): void {
    const now = performance.now();
    const firstPending = this.firstPendingResetAt ?? now;
    this.firstPendingResetAt = firstPending;
    const delay = Math.max(0, Math.min(RESET_QUIET_MS, RESET_MAX_WAIT_MS - (now - firstPending)));
    if (this.resetAccumulationTimer !== null) clearTimeout(this.resetAccumulationTimer);
    this.resetAccumulationTimer = setTimeout(() => this.flushAccumulationReset(), delay) as unknown as number;
  }

  /** Fire a pending (or immediate) accumulation reset now. */
  private flushAccumulationReset(): void {
    this.cancelAccumulationReset();
    this.onResetAccumulation();
  }

  private cancelAccumulationReset(): void {
    if (this.resetAccumulationTimer !== null) clearTimeout(this.resetAccumulationTimer);
    this.resetAccumulationTimer = null;
    this.firstPendingResetAt = null;
  }

  // Helper functions

  private getBrickAABB(
    bx: number,
    by: number,
    bz: number,
    lod: number
  ): { min: [number, number, number]; max: [number, number, number] } {
    if (!this.levelsByLod[lod]) return { min: [0, 0, 0], max: [0, 0, 0] };

    // Same convention as the shader's voxelToNormalized: only the last brick per axis is truncated
    const cells = this.config.levelSpanCells(lod);
    const dims = this.config.dimensions;
    const normalizedSize = this.config.normalizedSize;
    const toWorld = (voxel: number, axis: number) => (voxel / dims[axis]! - 0.5) * normalizedSize[axis]!;

    const min: [number, number, number] = [0, 0, 0];
    const max: [number, number, number] = [0, 0, 0];
    const index = [bx, by, bz];
    for (let axis = 0; axis < 3; axis++) {
      const span = LOGICAL_BRICK_SIZE * cells[axis]!;
      const v0 = index[axis]! * span;
      const v1 = Math.min(v0 + span, dims[axis]!);
      min[axis] = toWorld(v0, axis);
      max[axis] = toWorld(v1, axis);
    }
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
  /** Conservative SSE voxel size at `lod`: the largest voxel among axes that finer levels
   *  still improve (exponent > 0), so an axis stored at native resolution never forces a split. */
  private getVoxelWorldSize(lod: number): number {
    const normalizedSize = this.config.normalizedSize;
    const dims = this.config.dimensions;
    const exponent = this.config.levelExponent(lod);
    const improvable = [0, 1, 2].filter(a => exponent[a]! > 0);
    const axes = improvable.length > 0 ? improvable : [0, 1, 2];
    return Math.max(...axes.map(a => (normalizedSize[a]! / dims[a]!) * (1 << exponent[a]!)));
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
    const maxLod = this.maxLod;

    // Walk up the LOD hierarchy to find a loaded parent
    for (let parentLod = lod + 1; parentLod <= maxLod; parentLod++) {
      const [rx, ry, rz] = this.config.levelRatio(parentLod, lod);
      const parentBx = Math.floor(bx / rx);
      const parentBy = Math.floor(by / ry);
      const parentBz = Math.floor(bz / rz);

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
    const [nx, ny, nz] = this.config.childCounts(lod);
    for (let dz = 0; dz < nz; dz++) {
      for (let dy = 0; dy < ny; dy++) {
        for (let dx = 0; dx < nx; dx++) {
          const childKey = `lod${finerLod}:${bz * nz + dz}/${by * ny + dy}/${bx * nx + dx}`;
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
    const maxLod = this.maxLod;
    for (let parentLod = lod + 1; parentLod <= maxLod; parentLod++) {
      const [rx, ry, rz] = this.config.levelRatio(parentLod, lod);
      const parentKey = `lod${parentLod}:${Math.floor(bz / rz)}/${Math.floor(by / ry)}/${Math.floor(bx / rx)}`;
      if (this.emptyBricks.has(parentKey)) return true;
    }
    return false;
  }
}
