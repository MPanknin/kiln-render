/**
 * Base-LOD range derivation on the raw-value path (int16/float), and
 * rejections from the data provider during base load, channel backfill and
 * setFloatRange: none may surface as an unhandled rejection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { float32ToFloat16Bits } from '../src/utils/float16.js';
import type { DataProvider, VolumeMetadata, NetworkStats, BrickLoadResult } from '../src/data/data-provider.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

const VOXELS = 66 * 66 * 66;

function floatMetadata(numChannels: number, gridX = 1): VolumeMetadata {
  return {
    name: 't', dimensions: [64 * gridX, 64, 64], brickSize: 64, physicalBrickSize: 66,
    maxLod: 0, bitDepth: 16, numChannels, isFloat: true, dtype: 'int16',
    levels: [{ lod: 0, dimensions: [64 * gridX, 64, 64], brickGrid: [gridX, 1, 1], brickCount: gridX }],
  };
}

/** A raw-value brick: values spread evenly over [0, max], stored as float16 bits. */
function rawBrick(max: number): BrickLoadResult {
  const data = new Uint16Array(VOXELS);
  for (let i = 0; i < VOXELS; i++) data[i] = float32ToFloat16Bits(Math.round((i / (VOXELS - 1)) * max));
  return { data, min: 0, max: 65535, avg: 32768, rawMin: 0, rawMax: max };
}

function makeProvider(meta: VolumeMetadata, loadBrick: DataProvider['loadBrick'], extra: Partial<DataProvider> = {}): DataProvider {
  return {
    initialize: vi.fn().mockResolvedValue(meta),
    getMetadata: vi.fn().mockReturnValue(meta),
    getBrickGrid: vi.fn().mockReturnValue(meta.levels[0]!.brickGrid),
    loadBrick: vi.fn(loadBrick),
    isBrickEmpty: vi.fn().mockResolvedValue(false),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 } as NetworkStats),
    dispose: vi.fn(),
    ...extra,
  };
}

function makeResources(numChannels: number) {
  let slot = 0;
  return {
    numChannels,
    allocator: {
      allocate: vi.fn(() => ({ slot: { x: slot, y: 0, z: 0 }, slotIndex: slot++, evicted: null })),
      setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(), reset: vi.fn(), usedCount: 0, totalSlots: 512,
    },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: Array.from({ length: numChannels }, (_, i) => ({ _ch: i, bitDepth: 16 })),
  };
}

const config = { normalizedSize: [1, 1, 1] as [number, number, number], emptyBrickThreshold: 1 };
const make = (provider: DataProvider, meta: VolumeMetadata, visible = 0xf) =>
  new StreamingManager(makeResources(meta.numChannels) as never, provider, meta, {} as GPUDevice, config as never, vi.fn(), visible);

const aborted = () => new DOMException('Aborted', 'AbortError');
const settle = () => new Promise(r => setTimeout(r, 20));

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.restoreAllMocks();
});

describe('raw-value range derivation', () => {
  it('derives the float range from every loaded channel, not just channel 0', async () => {
    const meta = floatMetadata(2);
    const provider = makeProvider(meta, (_l, _x, _y, _z, ch) => Promise.resolve(rawBrick(ch === 0 ? 100 : 1000)));
    const sm = make(provider, meta);
    const derived = vi.fn();
    sm.setRangesDerivedCallback(derived);
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    await vi.waitFor(() => expect(derived).toHaveBeenCalled());

    const [lo, hi] = derived.mock.calls[0]![0].dataRange as [number, number];
    expect(lo).toBeLessThan(5);
    // Channel 1 reaches 1000; a range clipped to channel 0 would end near 100.
    expect(hi).toBeGreaterThan(900);
  });
});

describe('provider rejections stay handled', () => {
  it('setFloatRange rejecting on teardown does not leave an unhandled rejection', async () => {
    const meta = floatMetadata(1);
    // A plain function, not vi.fn(): Vitest attaches a handler to promises a
    // mock returns, which would hide the unhandled rejection under test.
    let floatRangeCalls = 0;
    const provider = makeProvider(meta, () => Promise.resolve(rawBrick(500)), {
      setFloatRange: () => { floatRangeCalls++; return Promise.reject(aborted()); },
    });
    const sm = make(provider, meta);
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    await vi.waitFor(() => expect(floatRangeCalls).toBe(1));
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('a base-load brick that rejects is retried and does not leave an unhandled rejection', async () => {
    const meta = floatMetadata(1, 2);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = makeProvider(meta, (_l, bx) => (bx === 1 ? Promise.reject(new Error('network down')) : Promise.resolve(rawBrick(500))));
    const sm = make(provider, meta);
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    await settle();
    expect(unhandled).toEqual([]);
    // brick 1: first attempt + sequential retry
    expect(vi.mocked(provider.loadBrick).mock.calls.filter(c => c[1] === 1).length).toBe(2);
  });

  it('a backfill that is aborted or fails does not leave an unhandled rejection and the rest still loads', async () => {
    const meta = floatMetadata(2, 2);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backfilled: number[] = [];
    const provider = makeProvider(meta, (_l, bx, _y, _z, ch) => {
      if (ch === 0) return Promise.resolve(rawBrick(500));
      if (bx === 0) return Promise.reject(aborted());
      backfilled.push(bx);
      return Promise.resolve(rawBrick(500));
    });
    const sm = make(provider, meta, 0b01);
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));

    sm.setVisibleChannels(0b11);
    await vi.waitFor(() => expect(sm.getStats().pendingCount).toBe(0));
    await settle();
    expect(unhandled).toEqual([]);
    expect(backfilled).toEqual([1]);
  });
});
