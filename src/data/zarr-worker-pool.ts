/**
 * ZarrWorkerPool - Pool of Web Workers for parallel Zarr brick loading
 *
 * Each worker runs the full pipeline: fetch + decompress + assemble 66³ bricks.
 * The main thread never touches voxel data — just dispatches requests
 * and uploads returned buffers to the GPU.
 */

import type { ZarrWorkerRequest, ZarrWorkerResponse } from './zarr-chunk-worker.js';

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
  private nextWorkerIndex = 0;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private is16bit = false;

  constructor(
    private poolSize: number = navigator.hardwareConcurrency
      ? Math.min(navigator.hardwareConcurrency, 4)
      : 2
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
    targetBitDepth?: 8 | 16,
  ): Promise<void> {
    this.is16bit = is16bit;
    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(
        new URL('./zarr-chunk-worker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (event: MessageEvent<ZarrWorkerResponse>) => {
        const { type: msgType, id, error, data, min, max, avg } = event.data;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);

        if (error) {
          pending.reject(new Error(error));
        } else if (msgType === 'init') {
          pending.resolve(undefined);
        } else if (msgType === 'loadBrick' && data) {
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
          targetBitDepth,
        };
        worker.postMessage(req);
      });
      initPromises.push(initPromise);
    }

    await Promise.all(initPromises);
  }

  /**
   * Reconfigure target bit depth after initialization (e.g., if format detection requires downsampling)
   */
  async setTargetBitDepth(bitDepth: 8 | 16): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const worker of this.workers) {
      const promise = new Promise<void>((resolve, reject) => {
        const id = this.requestId++;
        this.pendingRequests.set(id, {
          resolve: () => resolve(),
          reject: (e) => reject(e),
        });
        const req: ZarrWorkerRequest = {
          type: 'setTargetBitDepth',
          id,
          targetBitDepth: bitDepth,
        };
        worker.postMessage(req);
      });
      promises.push(promise);
    }
    await Promise.all(promises);
  }

  /**
   * Load a fully assembled 66³ brick in a worker (off main thread)
   */
  loadBrick(lod: number, bx: number, by: number, bz: number): Promise<BrickResult> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const worker = this.workers[this.nextWorkerIndex]!;
      this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;

      this.pendingRequests.set(id, { resolve, reject });

      const req: ZarrWorkerRequest = { type: 'loadBrick', id, lod, bx, by, bz };
      worker.postMessage(req);
    });
  }

  terminate(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.pendingRequests.clear();
  }
}
