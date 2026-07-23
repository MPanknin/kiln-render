/** ZarrWorkerPool - Pool of Web Workers for parallel brick loading; main
 *  thread only uploads to GPU. workerIndexFor hashes on spatial+channel
 *  footprint so a brick's channels spread across workers, not one. */

import type { ZarrWorkerRequest, ZarrWorkerResponse } from './zarr-chunk-worker.js';
import type { PipelineTimings } from './data-provider.js';
import { RollingAvg } from './network-tracker.js';
import { isFlagEnabled } from '../core/feature-flags.js';
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
  /** Real network bytes fetched for this brick's chunks (delta since this worker's previous response). */
  chunkBytesFetched?: number;
  /** Real HTTP requests issued for this brick's chunks (delta since this worker's previous response). */
  chunkRequestsIssued?: number;
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

  /** Per-worker last-seen cumulative store bytes/requests, for delta computation. */
  private workerLastBytes: number[] = [];
  private workerLastRequests: number[] = [];

  /** Stored from init() for spatial worker routing (see workerIndexFor). */
  private lodParams: ZarrWorkerRequest['lodParams'] = [];
  private logicalBrickSize = 64;

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
    this.lodParams = lodParams;
    this.logicalBrickSize = logicalBrickSize;
    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = createWorker();
      this.workerLastBytes[i] = 0;
      this.workerLastRequests[i] = 0;

      worker.onmessage = (event: MessageEvent<ZarrWorkerResponse>) => {
        const { type: msgType, id, error, data, min, max, avg, rawMin, rawMax, fetchMs, assemblyMs, queueMs, chunkHits, chunkTotal, chunkStoreBytes, chunkStoreRequests } = event.data;
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
          // Diff against this worker's last-seen cumulative store totals —
          // the store counter is monotonic, so this is exact even if two
          // loadBrick calls overlap on the same worker.
          let chunkBytesFetched: number | undefined;
          let chunkRequestsIssued: number | undefined;
          if (chunkStoreBytes !== undefined && chunkStoreRequests !== undefined) {
            chunkBytesFetched = Math.max(0, chunkStoreBytes - (this.workerLastBytes[i] ?? 0));
            chunkRequestsIssued = Math.max(0, chunkStoreRequests - (this.workerLastRequests[i] ?? 0));
            this.workerLastBytes[i] = chunkStoreBytes;
            this.workerLastRequests[i] = chunkStoreRequests;
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
            chunkBytesFetched,
            chunkRequestsIssued,
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
          // ?p3=1 / ?p4=1 — read here (main thread), forwarded since a worker
          // can't read the page URL itself. See docs/audits/kiln-render - fetch_patterns.md.
          dynamicCacheBudget: isFlagEnabled('p3'),
          refcountedAborts: isFlagEnabled('p4'),
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

  /** Deterministic worker index for one brick+channel; -1 (round-robin) if
   *  lodParams are missing. Hashes channelIndex too, so a brick's channels
   *  spread across workers instead of piling onto one. */
  private workerIndexFor(lod: number, bx: number, by: number, bz: number, channelIndex: number): number {
    const params = this.lodParams?.[lod];
    if (!params || this.workers.length === 0) return -1;
    const { scaleX, scaleY, scaleZ, csx, csy, csz } = params;
    const minChunk = (b: number, scale: number, cs: number): number =>
      Math.floor(Math.max(0, Math.floor(Math.max(0, b * this.logicalBrickSize - 1) * scale)) / cs);
    return this.workerIndexForChunk(lod, minChunk(bx, scaleX, csx), minChunk(by, scaleY, csy), minChunk(bz, scaleZ, csz), channelIndex);
  }

  /** Hash-from-chunk-coords half of workerIndexFor, so routing stays one
   *  shared implementation. `channelIndex` defaults to 0 for callers with no channel axis. */
  private workerIndexForChunk(lod: number, cx: number, cy: number, cz: number, channelIndex = 0): number {
    if (this.workers.length === 0) return -1;
    let h = (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791) ^ ((lod + 1) * 2654435761) ^ (channelIndex * 2246822519);
    // Math.imul, not `*`: plain float64 multiply overflows MAX_SAFE_INTEGER and
    // loses low bits before `>>> 0`, collapsing most coords onto worker 0.
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    // Second avalanche step (MurmurHash2 finalizer) for low-bit mixing; must
    // pair with `>>> 0` — signed `h ^ (h>>>15)` + negative `%` would index workers OOB.
    h = (h ^ (h >>> 15)) >>> 0;
    return h % this.workers.length;
  }

  /** Load a 66³ brick, routed to a worker by spatial+channel footprint. Supports AbortSignal cancellation. */
  loadBrick(lod: number, bx: number, by: number, bz: number, channelIndex = 0, signal?: AbortSignal): Promise<BrickResult> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      let workerIdx = this.workerIndexFor(lod, bx, by, bz, channelIndex);
      if (workerIdx < 0) {
        workerIdx = this.nextWorkerIndex;
        this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
      }
      const worker = this.workers[workerIdx]!;

      this.pendingRequests.set(id, { resolve, reject });
      this.requestToWorker.set(id, workerIdx);

      // Date.now(), not performance.now() — the worker diffs this against its
      // own clock, and only Date.now() shares an epoch across the worker boundary.
      const req: ZarrWorkerRequest = { type: 'loadBrick', id, lod, bx, by, bz, channelIndex, dispatchTime: Date.now() };
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
