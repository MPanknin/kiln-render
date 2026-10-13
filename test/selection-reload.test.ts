/**
 * Source selection switch: StreamingManager.reload() re-streams for the provider's new
 * channel/timepoint mapping without dropping the picture — base bricks keep their slots and
 * are overwritten in place; the CPU brick cache is keyed by source identity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { writeToCanvas } from '../src/core/volume.js';
import type { DataProvider, VolumeMetadata, NetworkStats, BrickLoadResult } from '../src/data/data-provider.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

function metadataFor(gridX: number): VolumeMetadata {
  return {
    name: 't', dimensions: [64 * gridX, 64, 64], brickSize: 64, physicalBrickSize: 66,
    maxLod: 0, bitDepth: 8, numChannels: 1, sourceChannels: [0], timepoint: 0,
    sourceChannelCount: 3, timepointCount: 2,
    levels: [{ lod: 0, dimensions: [64 * gridX, 64, 64], brickGrid: [gridX, 1, 1], brickCount: gridX }],
  };
}

const brick = (): BrickLoadResult => ({ data: new Uint8Array(66 * 66 * 66), min: 0, max: 128, avg: 64 });

function makeProvider(meta: VolumeMetadata): DataProvider {
  return {
    initialize: vi.fn().mockResolvedValue(meta),
    getMetadata: vi.fn().mockReturnValue(meta),
    getBrickGrid: vi.fn().mockReturnValue(meta.levels[0]!.brickGrid),
    loadBrick: vi.fn(() => Promise.resolve(brick())),
    isBrickEmpty: vi.fn().mockResolvedValue(false),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 } as NetworkStats),
    dispose: vi.fn(),
  };
}

function makeResources() {
  let slot = 0;
  return {
    numChannels: 1,
    allocator: {
      allocate: vi.fn(() => ({ slot: { x: slot, y: 0, z: 0 }, slotIndex: slot++, evicted: null })),
      setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(), usedCount: 0, totalSlots: 512,
    },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: [{ _ch: 0, bitDepth: 8 }],
  };
}

const config = { normalizedSize: [1, 1, 1] as [number, number, number], emptyBrickThreshold: 1 };
const make = (resources: unknown, provider: DataProvider, meta: VolumeMetadata) =>
  new StreamingManager(resources as never, provider, meta, {} as GPUDevice, config as never, vi.fn());

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

beforeEach(() => { vi.mocked(writeToCanvas).mockClear(); });

describe('reload after a source selection switch', () => {
  it('keeps the base bricks on screen and overwrites their slots in place', async () => {
    const meta = metadataFor(2);
    const provider = makeProvider(meta);
    const resources = makeResources();
    const sm = make(resources, provider, meta);
    await flush();
    expect(sm.baseLodLoaded).toBe(true);
    expect(resources.allocator.allocate).toHaveBeenCalledTimes(2);
    vi.mocked(provider.loadBrick).mockClear();
    vi.mocked(writeToCanvas).mockClear();
    resources.indirection.setBrick.mockClear();

    meta.timepoint = 1; // the provider switched the shared metadata
    sm.reload(0b1);

    // Old bricks are pointed at again immediately: no blank frame while the new data loads.
    expect(resources.indirection.clearAll).toHaveBeenCalledTimes(1);
    expect(resources.indirection.setBrick).toHaveBeenCalledTimes(2);
    expect(sm.baseLodLoaded).toBe(false);
    await flush();
    expect(sm.baseLodLoaded).toBe(true);
    expect(provider.loadBrick).toHaveBeenCalledTimes(2);
    expect(writeToCanvas).toHaveBeenCalledTimes(2);
    expect(resources.allocator.allocate).toHaveBeenCalledTimes(2); // same slots, no new allocation
    expect(resources.allocator.free).not.toHaveBeenCalled();
  });

  it('releases the slot of a base brick that is empty in the new selection', async () => {
    const meta = metadataFor(2);
    const provider = makeProvider(meta);
    const resources = makeResources();
    const sm = make(resources, provider, meta);
    await flush();

    vi.mocked(provider.isBrickEmpty).mockImplementation(async (_l, bx) => bx === 0);
    meta.sourceChannels = [2];
    sm.reload(0b1);
    await flush();
    expect(resources.allocator.free).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 });
    expect(resources.indirection.setEmpty).toHaveBeenCalledWith(0, 0, 0, 0);
    expect((sm as any).loadedBricks.size).toBe(1);
  });

  it('keys the CPU brick cache by source channel and timepoint, not by slot', () => {
    const meta = metadataFor(1);
    meta.numChannels = 2; meta.sourceChannels = [4, 1]; meta.timepoint = 7;
    const sm: any = make({ ...makeResources(), numChannels: 2 }, makeProvider(meta), meta);
    expect(sm.cacheKey(1, 'lod0:0/0/0')).toBe('c1@7:lod0:0/0/0');
    expect(sm.reload(0)).toBeUndefined(); // nothing stale: no-op
  });
});
