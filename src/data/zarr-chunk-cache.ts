/**
 * LRU cache for decoded Zarr chunks
 *
 * Multiple bricks often overlap the same Zarr chunk, so caching avoids
 * redundant fetches and decompression. Uses a simple Map-based LRU strategy.
 */

export class ZarrChunkCache {
  private cache = new Map<string, { data: ArrayLike<number>; shape: number[] }>();
  private maxEntries: number;

  constructor(maxEntries = 128) {
    this.maxEntries = maxEntries;
  }

  /** Build a cache key from LOD and chunk coordinates */
  static key(lod: number, cz: number, cy: number, cx: number): string {
    return `${lod}:${cz}/${cy}/${cx}`;
  }

  get(key: string): { data: ArrayLike<number>; shape: number[] } | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry;
  }

  set(key: string, data: ArrayLike<number>, shape: number[]): void {
    // If already exists, delete first to refresh position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { data, shape });
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
