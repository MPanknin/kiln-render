/**
 * ZarrChunkWorker - Web Worker for fully off-main-thread Zarr brick loading
 *
 * Runs the entire pipeline inside the worker:
 *   1. Fetch compressed Zarr chunks over HTTP
 *   2. Decompress via zarrita's codec pipeline (zstd/blosc WASM)
 *   3. Assemble 66³ brick from overlapping chunks (re-chunking + ghost borders)
 *   4. Compute brick stats (min/max/avg)
 *   5. Transfer the assembled brick buffer back to main thread (zero-copy)
 *
 * The main thread never touches voxel data — it just dispatches requests
 * and uploads the returned buffers to the GPU atlas.
 */

import { open, root, Array as ZarrArray, registry } from 'zarrita';
import type { DataType, Readable } from 'zarrita';
import blosc from 'numcodecs/blosc';
import lz4 from 'numcodecs/lz4';
import zstd from 'numcodecs/zstd';
import { TolerantFetchStore } from './tolerant-fetch-store.js';
import { uint16ToFloat16, float32ToFloat16Bits } from '../utils/float16.js';

// Override zarrita's default codec registry with static imports.
// By default zarrita lazily loads codecs via dynamic import("numcodecs/blosc") etc.,
// which Vite pre-bundles to @fs paths that workers cannot fetch in dev mode.
// Static imports bundle the codecs directly into the worker chunk.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set('blosc', async () => blosc as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set('lz4', async () => lz4 as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set('zstd', async () => zstd as any);

/** Messages from main thread to worker */
export interface ZarrWorkerRequest {
  type: 'init' | 'loadBrick' | 'setTargetFormat';
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
  type: 'init' | 'loadBrick' | 'setTargetFormat';
  id: number;
  error?: string;
  /** For 'loadBrick': assembled brick data (transferable) */
  data?: ArrayBuffer;
  /** Brick stats */
  min?: number;
  max?: number;
  avg?: number;
  /** Per-stage timing (ms) — for pipeline telemetry */
  fetchMs?: number;
  assemblyMs?: number;
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
const MAX_CACHE_BYTES = 128 * 1024 * 1024; // 128 MB per worker

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

self.onmessage = async (event: MessageEvent<ZarrWorkerRequest>) => {
  const { type, id } = event.data;

  if (type === 'setTargetFormat') {
    targetFormat = event.data.targetFormat ?? 'r16unorm';
    const resp: ZarrWorkerResponse = { type: 'setTargetFormat', id };
    (self as unknown as Worker).postMessage(resp);
    return;
  }

  if (type === 'init') {
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

      const store = new TolerantFetchStore(url!);
      const rootGroup = await open(root(store), { kind: 'group' });

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
  } else if (type === 'loadBrick') {
    try {
      const { lod, bx, by, bz } = event.data;
      const channelIndex = event.data.channelIndex ?? 0;
      const result = await assembleBrick(lod!, bx!, by!, bz!, channelIndex);

      const resp: ZarrWorkerResponse = {
        type: 'loadBrick', id,
        data: result.buffer,
        min: result.min,
        max: result.max,
        avg: result.avg,
        fetchMs: result.fetchMs,
        assemblyMs: result.assemblyMs,
      };
      (self as unknown as Worker).postMessage(resp, [result.buffer]);
    } catch (e) {
      const resp: ZarrWorkerResponse = {
        type: 'loadBrick', id,
        error: e instanceof Error ? e.message : 'loadBrick failed',
      };
      (self as unknown as Worker).postMessage(resp);
    }
  }
};

/**
 * Full brick assembly: fetch overlapping chunks, decompress, re-chunk into 66³ brick
 */
async function assembleBrick(
  lod: number, bx: number, by: number, bz: number, channelIndex: number
): Promise<{ buffer: ArrayBuffer; min: number; max: number; avg: number; fetchMs: number; assemblyMs: number }> {
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

  // --- Stage 1: chunk fetch (HTTP + zarr decompression, parallel, with cache) ---
  const t0 = performance.now();
  // Per-brick snapshot: concurrent assembleBrick calls share chunkCache and can evict
  // each other's entries between the await and the loop below. Read from here, not chunkCache.
  const localChunks = new Map<string, { data: ArrayLike<number>; shape: number[] }>();
  const fetchPromises: Promise<void>[] = [];
  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = cacheKey(lod, cz, cy, cx, channelIndex);
        const cached = chunkCache.get(key);
        if (cached) {
          localChunks.set(key, cached);
        } else {
          const prefix = new Array(shapePrefixLength).fill(0);
          if (channelAxisIdx >= 0 && channelAxisIdx < shapePrefixLength) {
            prefix[channelAxisIdx] = channelIndex;
          }
          fetchPromises.push(
            arr.getChunk([...prefix, cz, cy, cx]).then(chunk => {
              const entry = { data: chunk.data as unknown as ArrayLike<number>, shape: chunk.shape };
              localChunks.set(key, entry);
              cacheSet(key, chunk.data as unknown as ArrayLike<number>, chunk.shape);
            })
          );
        }
      }
    }
  }
  if (fetchPromises.length > 0) {
    await Promise.all(fetchPromises);
  }
  const fetchMs = performance.now() - t0;

  // --- Stage 2: brick assembly (voxel scatter + format conversion) ---
  const t1 = performance.now();
  const brick = is16bit
    ? new Uint16Array(physSize * physSize * physSize)
    : new Uint8Array(physSize * physSize * physSize);

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (let lz = 0; lz < physSize; lz++) {
    for (let ly = 0; ly < physSize; ly++) {
      for (let lx = 0; lx < physSize; lx++) {
        const vx = vStartX + lx;
        const vy = vStartY + ly;
        const vz = vStartZ + lz;

        const gx = Math.max(0, Math.min(actualDimX - 1, Math.round(vx * scaleX)));
        const gy = Math.max(0, Math.min(actualDimY - 1, Math.round(vy * scaleY)));
        const gz = Math.max(0, Math.min(actualDimZ - 1, Math.round(vz * scaleZ)));

        const cx = Math.floor(gx / csx);
        const cy = Math.floor(gy / csy);
        const cz = Math.floor(gz / csz);

        const lcx = gx - cx * csx;
        const lcy = gy - cy * csy;
        const lcz = gz - cz * csz;

        const key = cacheKey(lod, cz, cy, cx, channelIndex);
        const chunk = localChunks.get(key);
        if (chunk) {
          const chunkW = chunk.shape[chunk.shape.length - 1]!;
          const chunkH = chunk.shape[chunk.shape.length - 2]!;
          const idx = lcz * chunkH * chunkW + lcy * chunkW + lcx;
          const raw = Number(chunk.data[idx]!);

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
          } else {
            brickVal = raw;
            statVal = raw;
          }

          brick[lx + ly * physSize + lz * physSize * physSize] = brickVal;
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
    fetchMs,
    assemblyMs,
  };
}
