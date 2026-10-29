/**
 * BrickCache - CPU-side LRU cache for decompressed brick data.
 * Re-uploads evicted bricks without network round-trip. Bounded by bytes.
 */

import type { BrickData } from '../data/data-provider.js';

/** Default budget: 256 MB */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export interface BrickCacheStats {
  bytes: number;
  maxBytes: number;
  entries: number;
  /** Cumulative lookups that found the brick, and that did not */
  hits: number;
  misses: number;
  /** Cumulative entries dropped to stay within the budget */
  evictions: number;
}

export class BrickCache {
  private cache = new Map<string, BrickData>();
  private totalBytes = 0;
  private maxBytes: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  get(key: string): BrickData | undefined {
    const data = this.cache.get(key);
    if (data) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, data);
      this.hits++;
    } else {
      this.misses++;
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
      this.evictions++;
    }

    this.cache.set(key, data);
    this.totalBytes += data.byteLength;
  }

  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }

  /** Occupancy and cumulative hit, miss and eviction counts (counts survive clear()). */
  get stats(): BrickCacheStats {
    return {
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
