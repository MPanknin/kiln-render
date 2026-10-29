/**
 * KilnEngine.getMemoryStats() sums what each component reports: atlas, render targets of
 * every view, labels, the brick and chunk caches, and the pressure counters.
 */
import { describe, expect, it } from 'vitest';
import { KilnEngine } from '../src/engine.js';

function engine(overrides: Record<string, unknown> = {}): KilnEngine {
  const e: any = Object.create(KilnEngine.prototype);
  const renderer = (targets: number, buffers: number, sets: number) =>
    ({ renderTargetBytes: targets, bufferBytes: buffers, scaleSetCount: sets });
  Object.assign(e, {
    views: [{ renderer: renderer(1000, 10, 2) }, { renderer: renderer(500, 5, 1) }],
    _resources: {
      atlasBytes: 4000,
      allocator: { usedCount: 7, totalSlots: 8, pinnedCount: 3 },
      indirection: { gpuBytes: 100 },
    },
    gpu: { labels: { gpuBytes: 300, poolBytes: 200, maxPoolBytes: 200, poolGrows: 2 } },
    _streamingManager: {
      getStats: () => ({
        evictedCount: 4, allocationsRefused: 1,
        pipelineTimings: { chunkCacheHitRatio: 0.5, chunkCacheBytes: 600, chunkCacheMaxBytes: 1200 },
      }),
      brickCacheStats: { bytes: 50, maxBytes: 80, entries: 2, hits: 3, misses: 1, evictions: 6 },
    },
    ...overrides,
  });
  return e as KilnEngine;
}

describe('KilnEngine.getMemoryStats', () => {
  it('sums GPU bytes over atlas, every view, labels and the rest', () => {
    const m = engine().getMemoryStats();
    expect(m.gpu).toEqual({
      atlasBytes: 4000, atlasSlotsUsed: 7, atlasSlotsTotal: 8, atlasSlotsPinned: 3,
      renderTargetBytes: 1500, views: 2, scaleSets: 3,
      labelBytes: 300, labelMaxBytes: 200,
      otherBytes: 115, totalBytes: 4000 + 1500 + 300 + 115,
    });
  });

  it('reports the caches with hit ratios', () => {
    const m = engine().getMemoryStats();
    expect(m.cpu).toMatchObject({
      brickCacheBytes: 50, brickCacheMaxBytes: 80, brickCacheEntries: 2, brickCacheHitRatio: 0.75,
      chunkCacheBytes: 600, chunkCacheMaxBytes: 1200, chunkCacheHitRatio: 0.5,
    });
    expect(m.pressure).toEqual({
      atlasEvictions: 4, allocationsRefused: 1, brickCacheEvictions: 6, labelPoolGrows: 2, labelPoolAtBudget: true,
    });
  });

  it('is zero, not NaN, before any lookup and without a Zarr provider', () => {
    const m = engine({
      _streamingManager: {
        getStats: () => ({ evictedCount: 0, allocationsRefused: 0, pipelineTimings: {} }),
        brickCacheStats: { bytes: 0, maxBytes: 80, entries: 0, hits: 0, misses: 0, evictions: 0 },
      },
    }).getMemoryStats();
    expect(m.cpu.brickCacheHitRatio).toBe(0);
    expect(m.cpu.chunkCacheBytes).toBe(0);
    expect(m.cpu.chunkCacheMaxBytes).toBe(0);
    expect(m.cpu.chunkCacheHitRatio).toBe(0);
  });
});
