/**
 * ZarrChunkWorker - Web Worker that fetches, decompresses, and assembles
 * 66³ bricks entirely off-thread, transferring results back zero-copy.
 */

import { open, root, Array as ZarrArray, registry } from 'zarrita';
import type { DataType, Readable } from 'zarrita';
import blosc from 'numcodecs/blosc';
import lz4 from 'numcodecs/lz4';
import zstd from 'numcodecs/zstd';
import { TolerantFetchStore } from './tolerant-fetch-store.js';
import { uint16ToFloat16, float32ToFloat16Bits } from '../utils/float16.js';

// Static codec imports — zarrita's dynamic imports fail in Vite dev workers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set('blosc', async () => blosc as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set('lz4', async () => lz4 as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set('zstd', async () => zstd as any);

/** Messages from main thread to worker */
export interface ZarrWorkerRequest {
  type: 'init' | 'loadBrick' | 'setTargetFormat' | 'setFloatRange' | 'cancel';
  id: number;
  /** For 'init': dataset URL and array paths */
  url?: string;
  paths?: string[];
  /** For 'loadBrick': brick parameters */
  lod?: number;
  bx?: number;
  by?: number;
  bz?: number;
  /** Brick assembly parameters (sent with init, cached in worker) */
  logicalBrickSize?: number;
  physicalBrickSize?: number;
  /** Per-LOD scale factors and chunk info (sent with init) */
  lodParams?: {
    scaleX: number; scaleY: number; scaleZ: number;
    actualDimX: number; actualDimY: number; actualDimZ: number;
    csx: number; csy: number; csz: number;
    shapePrefixLength: number;
    channelAxisIdx: number;
  }[];
  /** Channel index to load (for datasets with a channel axis) */
  channelIndex?: number;
  /** Main-thread timestamp (performance.now) when request was dispatched — for queue wait measurement */
  dispatchTime?: number;
  is16bit?: boolean;
  /** Target texture format: r8unorm (8-bit), r16unorm (16-bit uint), r16float (16-bit float) */
  targetFormat?: 'r8unorm' | 'r16unorm' | 'r16float';
  /** Whether source data is float32/float64 */
  isFloat32?: boolean;
  /** Float normalisation range — voxel values are mapped from [floatMin, floatMax] → [0, 65535] */
  floatMin?: number;
  floatMax?: number;
}

/** Messages from worker to main thread */
export interface ZarrWorkerResponse {
  type: 'init' | 'loadBrick' | 'setTargetFormat' | 'setFloatRange';
  id: number;
  error?: string;
  /** For 'loadBrick': assembled brick data (transferable) */
  data?: ArrayBuffer;
  /** Brick stats */
  min?: number;
  max?: number;
  avg?: number;
  /** Raw-space min/max for float data (before normalisation) — used for range derivation */
  rawMin?: number;
  rawMax?: number;
  /** Per-stage timing (ms) — for pipeline telemetry */
  fetchMs?: number;
  assemblyMs?: number;
  /** Worker queue wait: dispatchTime → worker starts processing (ms) */
  queueMs?: number;
  /** Chunk-cache hit ratio for this brick (hits / total chunks needed) */
  chunkHits?: number;
  chunkTotal?: number;
}

// Worker state
let arrays: ZarrArray<DataType, Readable>[] = [];
let LOGICAL_SIZE = 64;
let PHYSICAL_SIZE = 66;
let lodParams: ZarrWorkerRequest['lodParams'] = [];
let is16bit = false;
let targetFormat: 'r8unorm' | 'r16unorm' | 'r16float' = 'r16unorm';
let isFloat32 = false;
let floatMin = 0;
let floatMax = 1;

// Per-worker chunk cache (LRU, bounded by byte count to prevent OOM)
const chunkCache = new Map<string, { data: ArrayLike<number>; shape: number[]; bytes: number }>();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 32 * 1024 * 1024; // 32 MB per worker

// In-flight chunk fetch promises — coalesces concurrent requests for the same chunk
// so multiple assembleBrick calls that need the same chunk share one fetch+decompress
const inflightFetches = new Map<string, Promise<{ data: ArrayLike<number>; shape: number[] }>>();

// Store reference
let workerStore: TolerantFetchStore | null = null;

// Cancellation state
const cancelledRequests = new Set<number>();
const activeControllers = new Map<number, AbortController>();

function cacheKey(lod: number, cz: number, cy: number, cx: number, channelIndex: number): string {
  return `${lod}:ch${channelIndex}:${cz}/${cy}/${cx}`;
}

function estimateBytes(data: ArrayLike<number>): number {
  if (data instanceof Uint8Array || data instanceof Int8Array) return data.length;
  if (data instanceof Uint16Array || data instanceof Int16Array) return data.length * 2;
  if (data instanceof Float32Array || data instanceof Uint32Array || data instanceof Int32Array) return data.length * 4;
  if (data instanceof Float64Array) return data.length * 8;
  return data.length * (is16bit ? 2 : 1); // fallback estimate
}

function cacheSet(key: string, data: ArrayLike<number>, shape: number[]): void {
  const bytes = estimateBytes(data);
  if (chunkCache.has(key)) {
    cacheBytes -= chunkCache.get(key)!.bytes;
    chunkCache.delete(key);
  }
  while (cacheBytes + bytes > MAX_CACHE_BYTES && chunkCache.size > 0) {
    const oldest = chunkCache.keys().next().value!;
    cacheBytes -= chunkCache.get(oldest)!.bytes;
    chunkCache.delete(oldest);
  }
  chunkCache.set(key, { data, shape, bytes });
  cacheBytes += bytes;
}

self.onmessage = (event: MessageEvent<ZarrWorkerRequest>) => {
  const { type, id } = event.data;

  // Cancel messages are handled immediately — not queued.
  // They must arrive and take effect even while a loadBrick is in progress.
  if (type === 'cancel') {
    cancelledRequests.add(id);
    const controller = activeControllers.get(id);
    if (controller) controller.abort();
    return;
  }

  if (type === 'setTargetFormat') {
    targetFormat = event.data.targetFormat ?? 'r16unorm';
    const resp: ZarrWorkerResponse = { type: 'setTargetFormat', id };
    (self as unknown as Worker).postMessage(resp);
    return;
  }

  if (type === 'setFloatRange') {
    floatMin = event.data.floatMin ?? 0;
    floatMax = event.data.floatMax ?? 1;
    const resp: ZarrWorkerResponse = { type: 'setFloatRange', id };
    (self as unknown as Worker).postMessage(resp);
    return;
  }

  if (type === 'init') {
    // Init is called once at startup before any loadBrick — safe to handle directly
    (async () => {
      try {
        const { url, paths } = event.data;
        LOGICAL_SIZE = event.data.logicalBrickSize ?? 64;
        PHYSICAL_SIZE = event.data.physicalBrickSize ?? 66;
        lodParams = event.data.lodParams ?? [];
        is16bit = event.data.is16bit ?? false;
        targetFormat = event.data.targetFormat ?? 'r16unorm';
        isFloat32 = event.data.isFloat32 ?? false;
        floatMin = event.data.floatMin ?? 0;
        floatMax = event.data.floatMax ?? 1;
        if (isFloat32) {
          console.log(`[ZarrWorker] Float32 normalization range: [${floatMin}, ${floatMax}]`);
        }

        workerStore = new TolerantFetchStore(url!);
        const rootGroup = await open(root(workerStore), { kind: 'group' });

        arrays = [];
        for (const path of paths!) {
          const arr = await open(rootGroup.resolve(path), { kind: 'array' });
          arrays.push(arr);
        }

        const resp: ZarrWorkerResponse = { type: 'init', id };
        (self as unknown as Worker).postMessage(resp);
      } catch (e) {
        const resp: ZarrWorkerResponse = {
          type: 'init', id,
          error: e instanceof Error ? e.message : 'Init failed',
        };
        (self as unknown as Worker).postMessage(resp);
      }
    })();
    return;
  }

  if (type === 'loadBrick') {
    const { lod, bx, by, bz, dispatchTime } = event.data;
    const channelIndex = event.data.channelIndex ?? 0;
    const queueMs = dispatchTime !== undefined ? performance.now() - dispatchTime : undefined;

    // Already cancelled before we started? Skip entirely.
    if (cancelledRequests.has(id)) {
      cancelledRequests.delete(id);
      return;
    }

    const controller = new AbortController();
    activeControllers.set(id, controller);

    (async () => {
      try {
        const result = await assembleBrick(lod!, bx!, by!, bz!, channelIndex, controller.signal);

        activeControllers.delete(id);
        cancelledRequests.delete(id);

        if (controller.signal.aborted) return;

        const resp: ZarrWorkerResponse = {
          type: 'loadBrick', id,
          data: result.buffer,
          min: result.min,
          max: result.max,
          avg: result.avg,
          rawMin: result.rawMin,
          rawMax: result.rawMax,
          fetchMs: result.fetchMs,
          assemblyMs: result.assemblyMs,
          queueMs,
          chunkHits: result.chunkHits,
          chunkTotal: result.chunkTotal,
        };
        (self as unknown as Worker).postMessage(resp, [result.buffer]);
      } catch (e) {
        activeControllers.delete(id);
        cancelledRequests.delete(id);

        if (e instanceof DOMException && e.name === 'AbortError') return;

        const resp: ZarrWorkerResponse = {
          type: 'loadBrick', id,
          error: e instanceof Error ? e.message : 'loadBrick failed',
        };
        (self as unknown as Worker).postMessage(resp);
      }
    })();
  }
};

/**
 * Full brick assembly: fetch overlapping chunks, decompress, re-chunk into 66³ brick
 */
async function assembleBrick(
  lod: number, bx: number, by: number, bz: number, channelIndex: number, signal?: AbortSignal
): Promise<{ buffer: ArrayBuffer; min: number; max: number; avg: number; rawMin?: number; rawMax?: number; fetchMs: number; assemblyMs: number; chunkHits: number; chunkTotal: number }> {
  const arr = arrays[lod]!;
  const params = lodParams![lod]!;
  const { scaleX, scaleY, scaleZ, actualDimX, actualDimY, actualDimZ, csx, csy, csz, shapePrefixLength, channelAxisIdx } = params;
  const physSize = PHYSICAL_SIZE;

  // Virtual brick voxel range (in uniformly downsampled space)
  const vStartX = bx * LOGICAL_SIZE - 1;
  const vStartY = by * LOGICAL_SIZE - 1;
  const vStartZ = bz * LOGICAL_SIZE - 1;

  // Map virtual range to actual Zarr array range for chunk prefetching
  const aStartX = Math.max(0, Math.floor(Math.max(0, vStartX) * scaleX));
  const aStartY = Math.max(0, Math.floor(Math.max(0, vStartY) * scaleY));
  const aStartZ = Math.max(0, Math.floor(Math.max(0, vStartZ) * scaleZ));
  const aEndX = Math.min(actualDimX - 1, Math.floor((vStartX + physSize - 1) * scaleX));
  const aEndY = Math.min(actualDimY - 1, Math.floor((vStartY + physSize - 1) * scaleY));
  const aEndZ = Math.min(actualDimZ - 1, Math.floor((vStartZ + physSize - 1) * scaleZ));

  // Determine which Zarr chunks overlap
  const minCx = Math.floor(aStartX / csx);
  const minCy = Math.floor(aStartY / csy);
  const minCz = Math.floor(aStartZ / csz);
  const maxCx = Math.floor(aEndX / csx);
  const maxCy = Math.floor(aEndY / csy);
  const maxCz = Math.floor(aEndZ / csz);

  // --- Stage 1: chunk fetch (HTTP + zarr decompression, parallel, with cache + dedup) ---
  const t0 = performance.now();
  // Flat chunk lookup: direct integer indexing replaces Map<string> + per-voxel
  // string allocation in the assembly loop.
  // Index = (cz-minCz)*ncy*ncx + (cy-minCy)*ncx + (cx-minCx)
  const ncx = maxCx - minCx + 1;
  const ncy = maxCy - minCy + 1;
  const chunkCount = ncx * ncy * (maxCz - minCz + 1);
  const chunkDataArr: (ArrayLike<number> | null)[] = new Array(chunkCount).fill(null);
  const chunkW = new Int32Array(chunkCount);  // per-chunk width (stride for Y)
  const chunkWH = new Int32Array(chunkCount); // per-chunk W*H (stride for Z)

  const setChunkEntry = (fi: number, data: ArrayLike<number>, shape: number[]) => {
    chunkDataArr[fi] = data;
    const w = shape[shape.length - 1]!;
    const h = shape[shape.length - 2]!;
    chunkW[fi] = w;
    chunkWH[fi] = w * h;
  };

  let chunkHits = 0;
  const fetchPromises: Promise<void>[] = [];
  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const fi = (cz - minCz) * ncy * ncx + (cy - minCy) * ncx + (cx - minCx);
        const key = cacheKey(lod, cz, cy, cx, channelIndex);
        const cached = chunkCache.get(key);
        if (cached) {
          // refresh recency: delete+re-set moves to end of map iteration order (LRU)
          chunkCache.delete(key);
          chunkCache.set(key, cached);
          setChunkEntry(fi, cached.data, cached.shape);
          chunkHits++;
        } else {
          // In-flight dedup: if another assembleBrick is already fetching this
          // chunk, share its promise instead of issuing a duplicate HTTP request
          let chunkPromise = inflightFetches.get(key);
          const prefix = new Array(shapePrefixLength).fill(0);
          if (channelAxisIdx >= 0 && channelAxisIdx < shapePrefixLength) {
            prefix[channelAxisIdx] = channelIndex;
          }
          const coords = [...prefix, cz, cy, cx];
          if (!chunkPromise) {
            chunkPromise = arr.getChunk(coords, { signal } as RequestInit).then(chunk => {
              const entry = { data: chunk.data as unknown as ArrayLike<number>, shape: chunk.shape };
              cacheSet(key, entry.data, entry.shape);
              return entry;
            }).finally(() => {
              inflightFetches.delete(key);
            });
            inflightFetches.set(key, chunkPromise);
          }
          fetchPromises.push(chunkPromise.then(entry => {
            setChunkEntry(fi, entry.data, entry.shape);
          }).catch(e => {
            // Dedup conflict: the shared fetch was aborted by another brick's
            // signal, but this brick is still active. Retry with our own signal.
            if (e instanceof DOMException && e.name === 'AbortError' && !signal?.aborted) {
              const cached = chunkCache.get(key);
              if (cached) {
                setChunkEntry(fi, cached.data, cached.shape);
                return;
              }
              return arr.getChunk(coords, { signal } as RequestInit).then(chunk => {
                const entry = { data: chunk.data as unknown as ArrayLike<number>, shape: chunk.shape };
                cacheSet(key, entry.data, entry.shape);
                setChunkEntry(fi, entry.data, entry.shape);
              });
            }
            throw e;
          }));
        }
      }
    }
  }
  if (fetchPromises.length > 0) {
    await Promise.all(fetchPromises);
  }
  const fetchMs = performance.now() - t0;

  // Abort check between fetch and assembly — the CPU-bound assembly loop
  // can't yield, so this is the last interruptible point.
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // --- Stage 2: brick assembly (LUT-based voxel scatter + format conversion) ---
  // Precompute per-axis LUTs: local brick coord → (chunk index, intra-chunk offset).
  // Eliminates ~287k string allocations + Map.get calls per 66³ brick.
  const lutChunkX = new Int32Array(physSize);
  const lutChunkY = new Int32Array(physSize);
  const lutChunkZ = new Int32Array(physSize);
  const lutOffX = new Int32Array(physSize);
  const lutOffY = new Int32Array(physSize);
  const lutOffZ = new Int32Array(physSize);

  for (let i = 0; i < physSize; i++) {
    const gx = Math.max(0, Math.min(actualDimX - 1, Math.round((vStartX + i) * scaleX)));
    const cxI = Math.floor(gx / csx);
    lutChunkX[i] = cxI - minCx;
    lutOffX[i] = gx - cxI * csx;

    const gy = Math.max(0, Math.min(actualDimY - 1, Math.round((vStartY + i) * scaleY)));
    const cyI = Math.floor(gy / csy);
    lutChunkY[i] = cyI - minCy;
    lutOffY[i] = gy - cyI * csy;

    const gz = Math.max(0, Math.min(actualDimZ - 1, Math.round((vStartZ + i) * scaleZ)));
    const czI = Math.floor(gz / csz);
    lutChunkZ[i] = czI - minCz;
    lutOffZ[i] = gz - czI * csz;
  }

  const t1 = performance.now();
  const brick = is16bit
    ? new Uint16Array(physSize * physSize * physSize)
    : new Uint8Array(physSize * physSize * physSize);

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  // Raw-space min/max for float data — used by StreamingManager to derive
  // the actual data range during base LOD loading.
  let rawMinVal = Infinity;
  let rawMaxVal = -Infinity;

  for (let lz = 0; lz < physSize; lz++) {
    const czi = lutChunkZ[lz]!;
    const lcz = lutOffZ[lz]!;
    const zBase = czi * ncy * ncx;
    const brickZBase = lz * physSize * physSize;

    for (let ly = 0; ly < physSize; ly++) {
      const cyi = lutChunkY[ly]!;
      const lcy = lutOffY[ly]!;
      const yzBase = zBase + cyi * ncx;
      const brickYZBase = brickZBase + ly * physSize;

      for (let lx = 0; lx < physSize; lx++) {
        const fi = yzBase + lutChunkX[lx]!;
        const data = chunkDataArr[fi];
        if (data) {
          const idx = lcz * chunkWH[fi]! + lcy * chunkW[fi]! + lutOffX[lx]!;
          const raw = Number(data[idx]!);

          let brickVal: number;
          let statVal: number;

          if (isFloat32) {
            const range = floatMax - floatMin;
            const normalizedVal = range > 0
              ? Math.max(0, Math.min(1, (raw - floatMin) / range))
              : 0;
            // Stats always in [0, 65535] space so isBrickEmpty thresholds work
            statVal = Math.round(normalizedVal * 65535);
            // Store raw float value as float16 bits — shader normalises using floatMin/floatMax uniforms.
            // Clamp to r16float representable range (±65504) before encoding.
            brickVal = float32ToFloat16Bits(Math.max(-65504, Math.min(65504, raw)));
            // Track raw-space extremes for range derivation
            if (isFinite(raw)) {
              if (raw < rawMinVal) rawMinVal = raw;
              if (raw > rawMaxVal) rawMaxVal = raw;
            }
          } else {
            brickVal = raw;
            statVal = raw;
          }

          brick[brickYZBase + lx] = brickVal;
          min = Math.min(min, statVal);
          max = Math.max(max, statVal);
          sum += statVal;
        }
      }
    }
  }

  const voxelCount = physSize * physSize * physSize;

  // Handle format conversions based on targetFormat
  let outputBrick: Uint8Array | Uint16Array = brick;

  if (is16bit && targetFormat === 'r8unorm') {
    // 16-bit → 8-bit conversion (downsample for r8unorm fallback)
    const uint16Brick = brick as Uint16Array;
    const uint8Brick = new Uint8Array(uint16Brick.length);

    // Downsample: take high byte (>> 8)
    let min8 = Infinity;
    let max8 = -Infinity;
    let sum8 = 0;

    for (let i = 0; i < uint16Brick.length; i++) {
      const val8 = (uint16Brick[i] ?? 0) >> 8;
      uint8Brick[i] = val8;
      min8 = Math.min(min8, val8);
      max8 = Math.max(max8, val8);
      sum8 += val8;
    }

    outputBrick = uint8Brick;
    min = min8 === Infinity ? 0 : min8;
    max = max8 === -Infinity ? 0 : max8;
    sum = sum8;
  } else if (is16bit && targetFormat === 'r16float' && !isFloat32) {
    // uint16 data → float16 conversion: maps [0, 65535] → [0.0, 1.0] in float16 bits
    // Skipped for float32 data — float16 bits already written per-voxel in the inner loop
    const uint16Brick = brick as Uint16Array;
    const float16Brick = uint16ToFloat16(uint16Brick);
    outputBrick = float16Brick;
    // Stats remain in original uint16 range (0-65535)
  }
  // else: r16unorm or 8-bit source - no conversion needed

  const assemblyMs = performance.now() - t1;

  const buffer = outputBrick.buffer instanceof ArrayBuffer
    ? outputBrick.buffer
    : outputBrick.buffer.slice(0);

  return {
    buffer: buffer as ArrayBuffer,
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    avg: sum / voxelCount,
    rawMin: isFloat32 && isFinite(rawMinVal) ? rawMinVal : undefined,
    rawMax: isFloat32 && isFinite(rawMaxVal) ? rawMaxVal : undefined,
    fetchMs,
    assemblyMs,
    chunkHits,
    chunkTotal: chunkCount,
  };
}
