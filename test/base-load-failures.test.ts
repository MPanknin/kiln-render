/**
 * Base-LOD bricks whose channel 0 fails to load are counted as failed and left
 * unloaded — never marked empty, so the refinement path can retry them.
 */
import { describe, it, expect, vi } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { DatasetConfig } from '../src/core/config.js';
import type { DataProvider, VolumeMetadata, NetworkStats } from '../src/data/data-provider.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

// 128³ volume, one LOD, 2×2×2 base bricks.
const metadata: VolumeMetadata = {
  name: 'fail', dimensions: [128, 128, 128], brickSize: 64, physicalBrickSize: 66,
  maxLod: 0, bitDepth: 8, numChannels: 1,
  levels: [{ lod: 0, dimensions: [128, 128, 128], brickGrid: [2, 2, 2], brickCount: 8 }],
};

function makeProvider(failingKeys: Set<string>): DataProvider {
  const brick = new Uint8Array(66 * 66 * 66);
  return {
    initialize: vi.fn().mockResolvedValue(metadata),
    getMetadata: vi.fn().mockReturnValue(metadata),
    getBrickGrid: vi.fn().mockReturnValue([2, 2, 2] as [number, number, number]),
    loadBrick: vi.fn(async (_lod: number, bx: number, by: number, bz: number) =>
      failingKeys.has(`${bx}/${by}/${bz}`) ? null : { data: brick, min: 0, max: 128, avg: 64 }),
    isBrickEmpty: vi.fn().mockResolvedValue(false),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({
      totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0,
    } as NetworkStats),
    dispose: vi.fn(),
  };
}

function makeResources() {
  let slot = 0;
  return {
    numChannels: 1,
    allocator: {
      allocate: vi.fn(() => ({ slot: { x: slot, y: 0, z: 0 }, slotIndex: slot++, evicted: null })),
      setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(),
      usedCount: 0, totalSlots: 512,
    },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: [{ bitDepth: 8 }],
  };
}

describe('StreamingManager base load — failed bricks', () => {
  it('leaves failed bricks unloaded and counts them; never marks them empty', async () => {
    const resources = makeResources();
    const sm = new StreamingManager(
      resources as never, makeProvider(new Set(['0/0/0', '1/1/1'])), metadata,
      {} as GPUDevice, new DatasetConfig([128, 128, 128]) as never, vi.fn(),
    );
    await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });

    const priv = sm as unknown as { loadedBricks: Map<string, unknown>; emptyBricks: Set<string> };
    expect(priv.loadedBricks.size).toBe(6);
    expect(priv.emptyBricks.size).toBe(0);
    expect(resources.indirection.setEmpty).not.toHaveBeenCalled();
    expect(sm.getStats().bricksFailed).toBe(2);
    // 6 of 8 resolved = 75%: the 50% milestone is real, the 90% one must stay unset
    expect(sm.milestones.baseCoverage50).not.toBeNull();
    expect(sm.milestones.baseCoverage90).toBeNull();
    expect(sm.milestones.baseComplete).not.toBeNull();
  });

  it('a clean base load reports zero failures', async () => {
    const sm = new StreamingManager(
      makeResources() as never, makeProvider(new Set()), metadata,
      {} as GPUDevice, new DatasetConfig([128, 128, 128]) as never, vi.fn(),
    );
    await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });
    expect(sm.getStats().bricksFailed).toBe(0);
  });
});
