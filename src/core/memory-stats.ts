/**
 * Memory telemetry: what the engine holds on the GPU and in CPU caches, and the
 * pressure signals that say whether a budget is too small. Read-only; every
 * number comes from the owning component, nothing is tracked centrally.
 */

export interface MemoryStats {
  gpu: {
    /** Atlas textures over all channels */
    atlasBytes: number;
    atlasSlotsUsed: number;
    atlasSlotsTotal: number;
    atlasSlotsPinned: number;
    /** Output, accumulation and depth textures over every view and render scale */
    renderTargetBytes: number;
    views: number;
    scaleSets: number;
    /** Label pool, palette, entries and pick buffers, now and at most */
    labelBytes: number;
    labelMaxBytes: number;
    /** Indirection table, ray-visibility and pick buffers */
    otherBytes: number;
    totalBytes: number;
  };
  cpu: {
    /** Decompressed bricks kept for re-upload after atlas eviction */
    brickCacheBytes: number;
    brickCacheMaxBytes: number;
    brickCacheEntries: number;
    /** Hits over lookups since load; 0 before the first lookup */
    brickCacheHitRatio: number;
    /** Decoded chunks held by the Zarr workers; 0 for other providers */
    chunkCacheBytes: number;
    chunkCacheMaxBytes: number;
    chunkCacheHitRatio: number;
    /** Chrome's performance.memory; null elsewhere */
    jsHeapBytes: number | null;
  };
  pressure: {
    atlasEvictions: number;
    /** Desired bricks that found no evictable slot */
    allocationsRefused: number;
    brickCacheEvictions: number;
    labelPoolGrows: number;
    labelPoolAtBudget: boolean;
  };
}

/** Chrome's non-standard heap size; null where the API does not exist. */
export function jsHeapBytes(): number | null {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? mem.usedJSHeapSize : null;
}
