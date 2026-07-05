/**
 * ZarrWorkerPool - Round-robin pool of Web Workers for parallel brick loading.
 * Each worker runs fetch + decompress + assemble; main thread only uploads to GPU.
 */

import type { ZarrWorkerRequest, ZarrWorkerResponse } from './zarr-chunk-worker.js';
import type { PipelineTimings } from './data-provider.js';
import { RollingAvg } from './network-tracker.js';
import ZarrChunkWorkerInline from './zarr-chunk-worker.ts?worker&inline';

/** Dev: URL worker for Vite imports. Prod: pre-bundled inline worker. */
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
  /** Raw-space min (float datasets only) */
  rawMin?: number;
  /** Raw-space max (float datasets only) */
  rawMax?: number;
}

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

export class ZarrWorkerPool {
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private is16bit = false;
  private queueAvg = new RollingAvg();
  private fetchAvg = new RollingAvg();
  private assemblyAvg = new RollingAvg();
  private chunkHitTotal = 0;
  private chunkReqTotal = 0;

  /** Maps request ID → worker index, for routing cancel messages */
  private requestToWorker = new Map<number, number>();

  /** Abort listeners to clean up on normal completion (prevents stale cancel messages) */
  private abortListeners = new Map<number, { signal: AbortSignal; listener: () => void }>();

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
    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = createWorker();

      worker.onmessage = (event: MessageEvent<ZarrWorkerResponse>) => {
        const { type: msgType, id, error, data, min, max, avg, rawMin, rawMax, fetchMs, assemblyMs, queueMs, chunkHits, chunkTotal } = event.data;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);

        // Clean up request→worker mapping
        this.requestToWorker.delete(id);

        // Remove abort listener so a later signal.abort() doesn't post a stale cancel
        const entry = this.abortListeners.get(id);
        if (entry) {
          entry.signal.removeEventListener('abort', entry.listener);
          this.abortListeners.delete(id);
        }

        if (error) {
          pending.reject(new Error(error));
        } else if (msgType === 'init' || msgType === 'setTargetFormat' || msgType === 'setFloatRange') {
          pending.resolve(undefined);
        } else if (msgType === 'loadBrick' && data) {
          if (queueMs !== undefined) this.queueAvg.add(queueMs);
          if (fetchMs !== undefined) this.fetchAvg.add(fetchMs);
          if (assemblyMs !== undefined) this.assemblyAvg.add(assemblyMs);
          if (chunkHits !== undefined && chunkTotal !== undefined) {
            this.chunkHitTotal += chunkHits;
            this.chunkReqTotal += chunkTotal;
          }
          const typedData = this.is16bit
            ? new Uint16Array(data)
            : new Uint8Array(data);
          pending.resolve({
            data: typedData,
            min: min ?? 0,
            max: max ?? 0,
            avg: avg ?? 0,
            rawMin,
            rawMax,
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

  /** Load a 66³ brick in a round-robin worker. Supports AbortSignal cancellation. */
  loadBrick(lod: number, bx: number, by: number, bz: number, channelIndex = 0, signal?: AbortSignal): Promise<BrickResult> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const workerIdx = this.nextWorkerIndex;
      this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
      const worker = this.workers[workerIdx]!;

      this.pendingRequests.set(id, { resolve, reject });
      this.requestToWorker.set(id, workerIdx);

      const req: ZarrWorkerRequest = { type: 'loadBrick', id, lod, bx, by, bz, channelIndex, dispatchTime: performance.now() };
      worker.postMessage(req);

      if (signal) {
        const onAbort = () => {
          // Send cancel message to the worker
          worker.postMessage({ type: 'cancel', id });
          // Reject immediately so the caller doesn't wait
          const pending = this.pendingRequests.get(id);
          if (pending) {
            this.pendingRequests.delete(id);
            this.requestToWorker.delete(id);
            pending.reject(new DOMException('Aborted', 'AbortError'));
          }
        };

        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
          // Store the listener ref so we can remove it on normal completion
          this.abortListeners.set(id, { signal, listener: onAbort });
        }
      }
    });
  }

  /**
   * Update the float normalisation range on all workers.
   * Called after base LOD loading derives the actual data range.
   */
  async setFloatRange(min: number, max: number): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const worker of this.workers) {
      const promise = new Promise<void>((resolve, reject) => {
        const id = this.requestId++;
        this.pendingRequests.set(id, {
          resolve: () => resolve(),
          reject: (e) => reject(e),
        });
        const req: ZarrWorkerRequest = {
          type: 'setFloatRange',
          id,
          floatMin: min,
          floatMax: max,
        };
        worker.postMessage(req);
      });
      promises.push(promise);
    }
    await Promise.all(promises);
  }

  getPipelineTimings(): PipelineTimings {
    return {
      avgQueueMs: this.queueAvg.value,
      avgFetchMs: this.fetchAvg.value,
      avgAssemblyMs: this.assemblyAvg.value,
      avgUploadMs: 0, // measured in StreamingManager
      sampleCount: this.fetchAvg.count,
      chunkCacheHitRatio: this.chunkReqTotal > 0 ? this.chunkHitTotal / this.chunkReqTotal : 0,
    };
  }

  terminate(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.pendingRequests.clear();
    this.requestToWorker.clear();
    this.abortListeners.clear();
  }
}
