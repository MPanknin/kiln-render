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

import { FetchStore, open, root, Array as ZarrArray } from 'zarrita';
import type { DataType, Readable } from 'zarrita';

/** Messages from main thread to worker */
export interface ZarrWorkerRequest {
  type: 'init' | 'loadBrick';
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
  }[];
  is16bit?: boolean;
}

/** Messages from worker to main thread */
export interface ZarrWorkerResponse {
  type: 'init' | 'loadBrick';
  id: number;
  error?: string;
  /** For 'loadBrick': assembled brick data (transferable) */
  data?: ArrayBuffer;
  /** Brick stats */
  min?: number;
  max?: number;
  avg?: number;
}

// Worker state
let arrays: ZarrArray<DataType, Readable>[] = [];
let LOGICAL_SIZE = 64;
let PHYSICAL_SIZE = 66;
let lodParams: ZarrWorkerRequest['lodParams'] = [];
let is16bit = false;

// Per-worker chunk cache (LRU, bounded by byte count to prevent OOM)
const chunkCache = new Map<string, { data: ArrayLike<number>; shape: number[]; bytes: number }>();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 128 * 1024 * 1024; // 128 MB per worker

function cacheKey(lod: number, cz: number, cy: number, cx: number): string {
  return `${lod}:${cz}/${cy}/${cx}`;
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

  if (type === 'init') {
    try {
      const { url, paths } = event.data;
      LOGICAL_SIZE = event.data.logicalBrickSize ?? 64;
      PHYSICAL_SIZE = event.data.physicalBrickSize ?? 66;
      lodParams = event.data.lodParams ?? [];
      is16bit = event.data.is16bit ?? false;

      const store = new FetchStore(url!);
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
      const result = await assembleBrick(lod!, bx!, by!, bz!);

      const resp: ZarrWorkerResponse = {
        type: 'loadBrick', id,
        data: result.buffer,
        min: result.min,
        max: result.max,
        avg: result.avg,
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
  lod: number, bx: number, by: number, bz: number
): Promise<{ buffer: ArrayBuffer; min: number; max: number; avg: number }> {
  const arr = arrays[lod]!;
  const params = lodParams![lod]!;
  const { scaleX, scaleY, scaleZ, actualDimX, actualDimY, actualDimZ, csx, csy, csz } = params;
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

  // Fetch all overlapping chunks in parallel (with per-worker cache)
  const fetchPromises: Promise<void>[] = [];
  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = cacheKey(lod, cz, cy, cx);
        if (!chunkCache.has(key)) {
          fetchPromises.push(
            arr.getChunk([cz, cy, cx]).then(chunk => {
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

  // Assemble 66³ brick
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

        const key = cacheKey(lod, cz, cy, cx);
        const chunk = chunkCache.get(key);
        if (chunk) {
          const chunkW = chunk.shape[chunk.shape.length - 1]!;
          const chunkH = chunk.shape[chunk.shape.length - 2]!;
          const idx = lcz * chunkH * chunkW + lcy * chunkW + lcx;
          const val = Number(chunk.data[idx]!);

          brick[lx + ly * physSize + lz * physSize * physSize] = val;
          min = Math.min(min, val);
          max = Math.max(max, val);
          sum += val;
        }
      }
    }
  }

  const voxelCount = physSize * physSize * physSize;
  return {
    buffer: brick.buffer as ArrayBuffer,
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    avg: sum / voxelCount,
  };
}
