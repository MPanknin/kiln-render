/**
 * Base-LOD load experiments behind ?p20=1 (ramp-up + cheap-first ordering) and
 * ?p21=1 (channel-progressive commit). Flags are mocked per test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { writeToCanvas } from '../src/core/volume.js';
import type { DataProvider, VolumeMetadata, NetworkStats, BrickLoadResult } from '../src/data/data-provider.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

const flags = new Set<string>();
vi.mock('../src/core/feature-flags.js', () => ({
  isFlagEnabled: (name: string) => flags.has(name),
  flagNumber: (_name: string, fallback: number) => fallback,
  activeFlags: () => [...flags],
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function metadataFor(numChannels: number, gridX: number): VolumeMetadata {
  return {
    name: 't', dimensions: [64 * gridX, 64, 64], brickSize: 64, physicalBrickSize: 66,
    maxLod: 0, bitDepth: 8, numChannels,
    levels: [{ lod: 0, dimensions: [64 * gridX, 64, 64], brickGrid: [gridX, 1, 1], brickCount: gridX }],
  };
}

const brick = (): BrickLoadResult => ({ data: new Uint8Array(66 * 66 * 66), min: 0, max: 128, avg: 64 });

function makeProvider(meta: VolumeMetadata, loadBrick: DataProvider['loadBrick'], cost?: (bx: number) => number): DataProvider {
  return {
    initialize: vi.fn().mockResolvedValue(meta),
    getMetadata: vi.fn().mockReturnValue(meta),
    getBrickGrid: vi.fn().mockReturnValue(meta.levels[0]!.brickGrid),
    loadBrick: vi.fn(loadBrick),
    isBrickEmpty: vi.fn().mockResolvedValue(false),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 } as NetworkStats),
    dispose: vi.fn(),
    ...(cost ? { estimateBrickCost: vi.fn((_l: number, bx: number) => cost(bx)) } : {}),
  };
}

function makeResources(numChannels: number) {
  let slot = 0;
  return {
    numChannels,
    allocator: {
      allocate: vi.fn(() => ({ slot: { x: slot, y: 0, z: 0 }, slotIndex: slot++, evicted: null })),
      setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(), usedCount: 0, totalSlots: 512,
    },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: Array.from({ length: numChannels }, (_, i) => ({ _ch: i, bitDepth: 8 })),
  };
}

const config = { normalizedSize: [1, 1, 1] as [number, number, number], emptyBrickThreshold: 1 };
const make = (resources: unknown, provider: DataProvider, meta: VolumeMetadata, visible = 0xf) =>
  new StreamingManager(resources as never, provider, meta, {} as GPUDevice, config as never, vi.fn(), visible);

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => { flags.clear(); vi.mocked(writeToCanvas).mockClear(); });

describe('?p21=1 channel-progressive base commit', () => {
  it('shows the brick on the first channel and writes the rest as they arrive', async () => {
    flags.add('p21');
    const meta = metadataFor(2, 1);
    const ch1 = deferred<BrickLoadResult | null>();
    const provider = makeProvider(meta, (_l, _x, _y, _z, ch) => ch === 0 ? Promise.resolve(brick()) : ch1.promise);
    const resources = makeResources(2);
    const sm = make(resources, provider, meta);

    await vi.waitFor(() => expect(resources.indirection.setBrick).toHaveBeenCalledTimes(1));
    expect(sm.milestones.firstAtlasCommit).not.toBeNull();
    expect(sm.baseLodLoaded).toBe(false);
    // fresh slot: only channel 0 written, no zero-fill of channel 1
    expect(writeToCanvas).toHaveBeenCalledTimes(1);
    expect((vi.mocked(writeToCanvas).mock.calls[0]![1] as { _ch: number })._ch).toBe(0);

    ch1.resolve(brick());
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    expect(writeToCanvas).toHaveBeenCalledTimes(2);
    expect((vi.mocked(writeToCanvas).mock.calls[1]![1] as { _ch: number })._ch).toBe(1);
    expect(resources.allocator.allocate).toHaveBeenCalledTimes(1);
  });

  it('zero-fills the other channels first when the slot was used before', async () => {
    flags.add('p21');
    const meta = metadataFor(3, 1);
    const late = deferred<BrickLoadResult | null>();
    const provider = makeProvider(meta, (_l, _x, _y, _z, ch) => ch === 1 ? Promise.resolve(brick()) : late.promise);
    const resources = makeResources(3);
    // Construct, then mark slot 0 as previously written before the load reaches the atlas.
    const sm = make(resources, provider, meta);
    (sm as unknown as { dirtyChannels: Map<number, number> }).dirtyChannels.set(0, 0b111);

    await vi.waitFor(() => expect(resources.indirection.setBrick).toHaveBeenCalledTimes(1));
    // channels 0 and 2 zeroed, channel 1 real data
    const chs = vi.mocked(writeToCanvas).mock.calls.map(c => (c[1] as { _ch: number })._ch).sort();
    expect(chs).toEqual([0, 1, 2]);
    late.resolve(brick());
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    expect(writeToCanvas).toHaveBeenCalledTimes(5);
  });

  it('keeps a brick whose channel 0 failed if another channel loaded', async () => {
    flags.add('p21');
    const meta = metadataFor(2, 1);
    const provider = makeProvider(meta, (_l, _x, _y, _z, ch) => Promise.resolve(ch === 0 ? null : brick()));
    const resources = makeResources(2);
    const sm = make(resources, provider, meta);
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    const priv = sm as unknown as { loadedBricks: Map<string, unknown> };
    expect(priv.loadedBricks.size).toBe(1);
    expect(sm.getStats().bricksFailed).toBe(0);
  });

  it('control path (flag off) is unchanged: one commit after all channels', async () => {
    const meta = metadataFor(2, 1);
    const ch1 = deferred<BrickLoadResult | null>();
    const provider = makeProvider(meta, (_l, _x, _y, _z, ch) => ch === 0 ? Promise.resolve(brick()) : ch1.promise);
    const resources = makeResources(2);
    const sm = make(resources, provider, meta);
    await flush(); await flush();
    expect(resources.indirection.setBrick).not.toHaveBeenCalled();
    ch1.resolve(brick());
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    expect(resources.indirection.setBrick).toHaveBeenCalledTimes(1);
    expect(writeToCanvas).toHaveBeenCalledTimes(2);
  });
});

describe('?p20=1 ramp-up base load', () => {
  it('loads the cheapest brick first and only widens the window after it completes', async () => {
    flags.add('p20');
    const meta = metadataFor(1, 3);
    const pending = new Map<number, ReturnType<typeof deferred<BrickLoadResult | null>>>();
    const provider = makeProvider(meta, (_l, bx) => {
      const d = deferred<BrickLoadResult | null>();
      pending.set(bx, d);
      return d.promise;
    }, bx => [8, 1, 4][bx]!);
    const resources = makeResources(1);
    const sm = make(resources, provider, meta);

    await flush(); await flush();
    // window = 1: only the cheapest brick (bx=1, cost 1) is in flight
    expect([...pending.keys()]).toEqual([1]);
    pending.get(1)!.resolve(brick());
    await vi.waitFor(() => expect(pending.size).toBe(3));
    // window doubled to 2: the remaining two dispatched together, cheaper first
    expect([...pending.keys()]).toEqual([1, 2, 0]);
    pending.get(2)!.resolve(brick());
    pending.get(0)!.resolve(brick());
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    expect(resources.indirection.setBrick).toHaveBeenCalledTimes(3);
  });

  it('control path dispatches all bricks at once', async () => {
    const meta = metadataFor(1, 3);
    const seen: number[] = [];
    const provider = makeProvider(meta, (_l, bx) => { seen.push(bx); return new Promise(() => {}); });
    make(makeResources(1), provider, meta);
    await flush(); await flush();
    expect(seen.length).toBe(3);
  });
});

describe('?p25=1 visible-channel demand', () => {
  it('base load fetches only visible channels and backfills a channel when it is shown', async () => {
    flags.add('p21'); flags.add('p25');
    const meta = metadataFor(3, 1);
    const calls: number[] = [];
    const provider = makeProvider(meta, (_l, _x, _y, _z, ch) => { calls.push(ch!); return Promise.resolve(brick()); });
    const resources = makeResources(3);
    const sm = make(resources, provider, meta, 0b101); // channels 0 and 2 visible
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    expect([...calls].sort()).toEqual([0, 2]);
    expect(writeToCanvas).toHaveBeenCalledTimes(2);

    // Show channel 1 → fetched for the resident brick and written to its slot
    sm.setVisibleChannels(0b111);
    await vi.waitFor(() => expect(calls).toContain(1));
    await vi.waitFor(() => expect(writeToCanvas).toHaveBeenCalledTimes(3));
    expect((vi.mocked(writeToCanvas).mock.calls[2]![1] as { _ch: number })._ch).toBe(1);
    // Showing it again is a no-op
    sm.setVisibleChannels(0b111);
    await flush();
    expect(calls.filter(c => c === 1).length).toBe(1);
  });

  it('never loads zero channels: an all-hidden mask falls back to channel 0', async () => {
    flags.add('p21'); flags.add('p25');
    const meta = metadataFor(2, 1);
    const calls: number[] = [];
    const provider = makeProvider(meta, (_l, _x, _y, _z, ch) => { calls.push(ch!); return Promise.resolve(brick()); });
    const sm = make(makeResources(2), provider, meta, 0);
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    expect(calls).toEqual([0]);
  });

  it('flag off: all channels load regardless of the mask', async () => {
    flags.add('p21');
    const meta = metadataFor(2, 1);
    const calls: number[] = [];
    const provider = makeProvider(meta, (_l, _x, _y, _z, ch) => { calls.push(ch!); return Promise.resolve(brick()); });
    const sm = make(makeResources(2), provider, meta, 0b01);
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    expect([...calls].sort()).toEqual([0, 1]);
  });
});
