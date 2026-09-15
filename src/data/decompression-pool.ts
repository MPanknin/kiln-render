/**
 * DecompressionPool - Round-robin Web Worker pool for parallel
 * gzip decompression of brick data off the main thread.
 */

import type { DecompressRequest, DecompressResponse } from './decompression-worker.js';
import type { SourceFormat, TargetFormat } from './brick-convert.js';
import DecompressionWorker from './decompression-worker.ts?worker&inline';

interface PendingRequest {
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
}

export class DecompressionPool {
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  enabled = true;
  private targetFormat: TargetFormat = 'r16unorm';

  /** Target texture format for decompressed data: r8unorm, r16unorm or r16float. */
  setTargetFormat(format: TargetFormat): void {
    this.targetFormat = format;
  }

  constructor(poolSize: number = navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, 8) : 4) {
    for (let i = 0; i < poolSize; i++) {
      const worker = new DecompressionWorker();

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

  }

  /** Decompress a gzip buffer of `sourceFormat` voxels, converted to the target format. */
  decompress(compressedData: ArrayBuffer, sourceFormat: SourceFormat): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const worker = this.workers[this.nextWorkerIndex]!;
      this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;

      this.pendingRequests.set(id, { resolve, reject });

      const request: DecompressRequest = {
        id,
        data: compressedData,
        sourceFormat,
        targetFormat: this.targetFormat,
      };
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
    for (const pending of this.pendingRequests.values()) pending.reject(new DOMException('Aborted', 'AbortError'));
    this.pendingRequests.clear();
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
