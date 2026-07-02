/**
 * ZarrWorkerPool - Pool of Web Workers for parallel Zarr brick loading
 *
 * Each worker runs the full pipeline: fetch + decompress + assemble 66³ bricks.
 * The main thread never touches voxel data — just dispatches requests
 * and uploads returned buffers to the GPU.
 */

import type { ZarrWorkerRequest, ZarrWorkerResponse } from './zarr-chunk-worker.js';
import type { PipelineTimings } from './data-provider.js';
import { RollingAvg } from './network-tracker.js';
import ZarrChunkWorkerInline from './zarr-chunk-worker.ts?worker&inline';

/**
 * In dev, use a URL-based worker so zarrita codec chunks (blosc/zstd/lz4) can be
 * loaded via the Vite dev server. Blob workers have null origin and cannot
 * dynamically import modules from localhost.
 *
 * In production, use the pre-bundled inline worker where all codec deps are
 * included via inlineDynamicImports — no external fetches needed.
 */
function createWorker(): Worker {
  if (import.meta.env.DEV) {
    const DevWorker = Worker;
    const devWorkerPath = './zarr-chunk-worker.ts';
    return new DevWorker(new URL(devWorkerPath, import.meta.url), { type: 'module' });
  }
  return new ZarrChunkWorkerInline();
}

export interface BrickResult {
  data: Uint8Array | Uint16Array;
  min: number;
  max: number;
  avg: number;
}

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

export class ZarrWorkerPool {
  private workers: Worker[] = [];
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private is16bit = false;
  private fetchAvg = new RollingAvg();
  private assemblyAvg = new RollingAvg();

  /** Per-LOD chunk layout, kept on main thread for spatial-affinity dispatch */
  private lodChunkInfo: { scaleX: number; scaleY: number; scaleZ: number; csx: number; csy: number; csz: number }[] = [];
  private logicalBrickSize = 64;

  constructor(
    private poolSize: number = navigator.hardwareConcurrency
      ? Math.min(navigator.hardwareConcurrency, 8)
      : 4
  ) {}

  /**
   * Initialize all workers with the dataset URL, array paths, and brick params.
   */
  async init(
    url: string,
    paths: string[],
    lodParams: ZarrWorkerRequest['lodParams'],
    logicalBrickSize: number,
    physicalBrickSize: number,
    is16bit: boolean,
    targetFormat?: 'r8unorm' | 'r16unorm' | 'r16float',
    isFloat32?: boolean,
    floatRange?: [number, number],
  ): Promise<void> {
    this.is16bit = is16bit;
    this.logicalBrickSize = logicalBrickSize;
    this.lodChunkInfo = (lodParams ?? []).map(p => ({
      scaleX: p.scaleX, scaleY: p.scaleY, scaleZ: p.scaleZ,
      csx: p.csx, csy: p.csy, csz: p.csz,
    }));
    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = createWorker();

      worker.onmessage = (event: MessageEvent<ZarrWorkerResponse>) => {
        const { type: msgType, id, error, data, min, max, avg, fetchMs, assemblyMs } = event.data;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);

        if (error) {
          pending.reject(new Error(error));
        } else if (msgType === 'init' || msgType === 'setTargetFormat') {
          pending.resolve(undefined);
        } else if (msgType === 'loadBrick' && data) {
          if (fetchMs !== undefined) this.fetchAvg.add(fetchMs);
          if (assemblyMs !== undefined) this.assemblyAvg.add(assemblyMs);
          const typedData = this.is16bit
            ? new Uint16Array(data)
            : new Uint8Array(data);
          pending.resolve({
            data: typedData,
            min: min ?? 0,
            max: max ?? 0,
            avg: avg ?? 0,
          } as BrickResult);
        } else {
          pending.reject(new Error('Empty brick response'));
        }
      };

      worker.onerror = (err) => {
        console.error('ZarrWorkerPool worker error:', err);
      };

      this.workers.push(worker);

      const initPromise = new Promise<void>((resolve, reject) => {
        const id = this.requestId++;
        this.pendingRequests.set(id, {
          resolve: () => resolve(),
          reject: (e) => reject(e),
        });
        const req: ZarrWorkerRequest = {
          type: 'init', id, url, paths,
          lodParams, logicalBrickSize, physicalBrickSize, is16bit,
          targetFormat,
          isFloat32: isFloat32 ?? false,
          floatMin: floatRange?.[0],
          floatMax: floatRange?.[1],
        };
        worker.postMessage(req);
      });
      initPromises.push(initPromise);
    }

    await Promise.all(initPromises);
  }

  /**
   * Reconfigure target texture format after initialization
   * Format determines output format: r8unorm (8-bit), r16unorm (16-bit uint), r16float (16-bit float)
   */
  async setTargetFormat(format: 'r8unorm' | 'r16unorm' | 'r16float'): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const worker of this.workers) {
      const promise = new Promise<void>((resolve, reject) => {
        const id = this.requestId++;
        this.pendingRequests.set(id, {
          resolve: () => resolve(),
          reject: (e) => reject(e),
        });
        const req: ZarrWorkerRequest = {
          type: 'setTargetFormat',
          id,
          targetFormat: format,
        };
        worker.postMessage(req);
      });
      promises.push(promise);
    }
    await Promise.all(promises);
  }

  /**
   * Pick a worker by spatial affinity: bricks that overlap the same zarr chunks
   * land on the same worker, maximizing per-worker chunk-cache hits.
   */
  private getAffinityWorker(lod: number, bx: number, by: number, bz: number): number {
    const info = this.lodChunkInfo[lod];
    if (!info) return 0;

    // Brick center in virtual voxel coords → actual zarr coords → chunk index
    const half = this.logicalBrickSize >> 1;
    const cx = Math.floor((bx * this.logicalBrickSize + half) * info.scaleX / info.csx);
    const cy = Math.floor((by * this.logicalBrickSize + half) * info.scaleY / info.csy);
    const cz = Math.floor((bz * this.logicalBrickSize + half) * info.scaleZ / info.csz);

    // Spatial hash → worker index (constants are large coprime numbers for mixing)
    const h = ((lod * 73856093) ^ (cx * 19349663) ^ (cy * 83492791) ^ (cz * 4256233)) >>> 0;
    return h % this.workers.length;
  }

  /**
   * Load a fully assembled 66³ brick in a worker (off main thread)
   */
  loadBrick(lod: number, bx: number, by: number, bz: number, channelIndex = 0): Promise<BrickResult> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const worker = this.workers[this.getAffinityWorker(lod, bx, by, bz)]!;

      this.pendingRequests.set(id, { resolve, reject });

      const req: ZarrWorkerRequest = { type: 'loadBrick', id, lod, bx, by, bz, channelIndex };
      worker.postMessage(req);
    });
  }

  getPipelineTimings(): PipelineTimings {
    return {
      avgFetchMs: this.fetchAvg.value,
      avgAssemblyMs: this.assemblyAvg.value,
      avgUploadMs: 0, // measured in StreamingManager
      sampleCount: this.fetchAvg.count,
    };
  }

  terminate(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.pendingRequests.clear();
  }
}
