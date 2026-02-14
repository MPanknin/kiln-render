/**
 * BrickCache - CPU-side LRU cache for decompressed brick data
 *
 * Keeps recently fetched brick data in memory so that bricks evicted
 * from the GPU atlas can be re-uploaded without a network round-trip.
 * Bounded by total byte count, not entry count.
 */

import type { BrickData } from '../data/data-provider.js';

/** Default budget: 256 MB */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export class BrickCache {
  private cache = new Map<string, BrickData>();
  private totalBytes = 0;
  private maxBytes: number;

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  get(key: string): BrickData | undefined {
    const data = this.cache.get(key);
    if (data) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, data);
    }
    return data;
  }

  put(key: string, data: BrickData): void {
    // If already present, remove old entry first
    const existing = this.cache.get(key);
    if (existing) {
      this.totalBytes -= existing.byteLength;
      this.cache.delete(key);
    }

    // Evict oldest entries until under budget
    while (this.totalBytes + data.byteLength > this.maxBytes && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value!;
      const oldData = this.cache.get(oldest)!;
      this.totalBytes -= oldData.byteLength;
      this.cache.delete(oldest);
    }

    this.cache.set(key, data);
    this.totalBytes += data.byteLength;
  }

  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }
}
