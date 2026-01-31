/**
 * DecompressionPool - Worker pool for parallel brick decompression
 *
 * Manages a pool of Web Workers to decompress gzip-compressed bricks
 * without blocking the main thread. Uses round-robin assignment with
 * promise-based request tracking.
 */

import type { DecompressRequest, DecompressResponse } from './decompression-worker.js';

interface PendingRequest {
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
}

export class DecompressionPool {
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private _enabled = true;

  /** Whether compression is enabled (can be toggled for backwards compatibility) */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
  }

  constructor(poolSize: number = navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, 4) : 2) {
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(
        new URL('./decompression-worker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (event: MessageEvent<DecompressResponse>) => {
        const { id, data, error } = event.data;
        const pending = this.pendingRequests.get(id);

        if (!pending) {
          console.warn(`DecompressionPool: received response for unknown request ${id}`);
          return;
        }

        this.pendingRequests.delete(id);

        if (error || !data) {
          pending.reject(new Error(error || 'Decompression returned null'));
        } else {
          pending.resolve(new Uint8Array(data));
        }
      };

      worker.onerror = (error) => {
        console.error('DecompressionPool worker error:', error);
      };

      this.workers.push(worker);
    }

    console.log(`DecompressionPool: initialized with ${poolSize} workers`);
  }

  /**
   * Decompress a gzip-compressed buffer
   * Returns a promise that resolves to the decompressed Uint8Array
   */
  decompress(compressedData: ArrayBuffer): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const worker = this.workers[this.nextWorkerIndex]!;
      this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;

      this.pendingRequests.set(id, { resolve, reject });

      const request: DecompressRequest = { id, data: compressedData };
      // Transfer ownership to worker (zero-copy)
      worker.postMessage(request, [compressedData]);
    });
  }

  /**
   * Get pool statistics
   */
  getStats(): { workerCount: number; pendingRequests: number } {
    return {
      workerCount: this.workers.length,
      pendingRequests: this.pendingRequests.size,
    };
  }

  /**
   * Terminate all workers
   */
  terminate(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.pendingRequests.clear();
    console.log('DecompressionPool: terminated');
  }
}

// Singleton instance for the application
let poolInstance: DecompressionPool | null = null;

/**
 * Get or create the global decompression pool
 */
export function getDecompressionPool(): DecompressionPool {
  if (!poolInstance) {
    poolInstance = new DecompressionPool();
  }
  return poolInstance;
}

/**
 * Terminate the global decompression pool
 */
export function terminateDecompressionPool(): void {
  if (poolInstance) {
    poolInstance.terminate();
    poolInstance = null;
  }
}
