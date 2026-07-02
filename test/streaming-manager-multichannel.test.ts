/**
 * Multi-channel loading behaviour in StreamingManager
 *
 * These tests verify that for a dataset with N channels:
 *  - dataProvider.loadBrick is called once per channel per brick (channelIndex 0…N-1)
 *  - writeToCanvas is called once per channel, writing to the correct atlas canvas
 *  - Empty bricks short-circuit before any channel data is fetched
 *
 * WebGPU is avoided by mocking writeToCanvas and supplying lightweight stand-ins
 * for Renderer and GPUDevice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import type { DataProvider, VolumeMetadata, NetworkStats } from '../src/data/data-provider.js';

// ---------------------------------------------------------------------------
// Mock writeToCanvas — the only WebGPU-touching function called during base
// LOD loading.  Everything else operates on plain JS objects.
// ---------------------------------------------------------------------------

vi.mock('../src/core/volume.js', () => ({
  writeToCanvas: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(numChannels: number): VolumeMetadata {
  return {
    name: 'test',
    dimensions: [64, 64, 64],
    brickSize: 64,
    physicalBrickSize: 66,
    maxLod: 0,
    bitDepth: 8,
    numChannels,
    levels: [
      {
        lod: 0,
        dimensions: [64, 64, 64],
        brickGrid: [1, 1, 1],
        brickCount: 1,
      },
    ],
  };
}

function makeProvider(numChannels: number, isEmpty = false): DataProvider {
  const brickData = new Uint8Array(66 * 66 * 66);
  return {
    initialize: vi.fn().mockResolvedValue(makeMetadata(numChannels)),
    getMetadata: vi.fn().mockReturnValue(makeMetadata(numChannels)),
    getBrickGrid: vi.fn().mockReturnValue([1, 1, 1] as [number, number, number]),
    loadBrick: vi.fn().mockResolvedValue(brickData),
    isBrickEmpty: vi.fn().mockResolvedValue(isEmpty),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({
      totalBytesDownloaded: 0,
      recentBytesPerSecond: 0,
      requestCount: 0,
    } as NetworkStats),
    dispose: vi.fn(),
  };
}

/**
 * Minimal Renderer stand-in.  Only the properties accessed during
 * loadBaseLod and the streaming loadBrick path are populated.
 * `canvases` is an array of plain objects — the real type is irrelevant
 * because writeToCanvas is mocked.
 */
function makeRenderer(numChannels: number) {
  return {
    numChannels,
    allocator: {
      allocate: vi.fn().mockReturnValue({
        slot: { x: 0, y: 0, z: 0 },
        slotIndex: 0,
        evicted: null,
      }),
      setMetadata: vi.fn(),
      pin: vi.fn(),
      touch: vi.fn(),
      free: vi.fn(),
      usedCount: 0,
      totalSlots: 512,
    },
    indirection: {
      setBrick: vi.fn(),
      setEmpty: vi.fn(),
      clearBrick: vi.fn(),
      clearAll: vi.fn(),
    },
    // One canvas per channel — indexed in loadBrick as renderer.canvases[ch]
    canvases: Array.from({ length: Math.max(numChannels, 1) }, (_, i) => ({ _ch: i })),
    resetAccumulation: vi.fn(),
  };
}

/** Minimal DatasetConfig stand-in. */
function makeConfig() {
  return {
    normalizedSize: [1, 1, 1] as [number, number, number],
    emptyBrickThreshold: 1,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamingManager — multi-channel base LOD loading', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls loadBrick once for a 1-channel dataset (channelIndex 0)', async () => {
    const provider = makeProvider(1);
    const renderer = makeRenderer(1);

    const sm = new StreamingManager(
      renderer as any,
      provider,
      makeMetadata(1),
      {} as GPUDevice,
      makeConfig() as any,
    );

    await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });

    expect(provider.loadBrick).toHaveBeenCalledTimes(1);
    expect(provider.loadBrick).toHaveBeenCalledWith(0, 0, 0, 0, 0);
  });

  it('calls loadBrick twice for a 2-channel dataset, once per channel', async () => {
    const provider = makeProvider(2);
    const renderer = makeRenderer(2);

    const sm = new StreamingManager(
      renderer as any,
      provider,
      makeMetadata(2),
      {} as GPUDevice,
      makeConfig() as any,
    );

    await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });

    expect(provider.loadBrick).toHaveBeenCalledTimes(2);
    expect(provider.loadBrick).toHaveBeenCalledWith(0, 0, 0, 0, 0); // ch 0
    expect(provider.loadBrick).toHaveBeenCalledWith(0, 0, 0, 0, 1); // ch 1
  });

  it('calls loadBrick for all 4 channels of a 4-channel dataset', async () => {
    const provider = makeProvider(4);
    const renderer = makeRenderer(4);

    const sm = new StreamingManager(
      renderer as any,
      provider,
      makeMetadata(4),
      {} as GPUDevice,
      makeConfig() as any,
    );

    await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });

    expect(provider.loadBrick).toHaveBeenCalledTimes(4);
    for (let ch = 0; ch < 4; ch++) {
      expect(provider.loadBrick).toHaveBeenCalledWith(0, 0, 0, 0, ch);
    }
  });

  it('writes each channel to the corresponding atlas canvas', async () => {
    const { writeToCanvas } = await import('../src/core/volume.js');

    const provider = makeProvider(2);
    const renderer = makeRenderer(2);

    const sm = new StreamingManager(
      renderer as any,
      provider,
      makeMetadata(2),
      {} as GPUDevice,
      makeConfig() as any,
    );

    await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });

    // writeToCanvas must have been called twice — once per channel
    expect(vi.mocked(writeToCanvas)).toHaveBeenCalledTimes(2);

    // Channel 0 → canvases[0], channel 1 → canvases[1]
    expect(vi.mocked(writeToCanvas)).toHaveBeenCalledWith(
      expect.anything(),        // device (mocked)
      renderer.canvases[0],     // atlas for channel 0
      expect.any(Uint8Array),
      expect.anything(),
      expect.anything(),
    );
    expect(vi.mocked(writeToCanvas)).toHaveBeenCalledWith(
      expect.anything(),
      renderer.canvases[1],     // atlas for channel 1
      expect.any(Uint8Array),
      expect.anything(),
      expect.anything(),
    );
  });

  it('allocates exactly one atlas slot shared across all channels', async () => {
    const provider = makeProvider(3);
    const renderer = makeRenderer(3);

    const sm = new StreamingManager(
      renderer as any,
      provider,
      makeMetadata(3),
      {} as GPUDevice,
      makeConfig() as any,
    );

    await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });

    // 3 channels loaded, but only 1 slot allocated (channels share the atlas slot)
    expect(renderer.allocator.allocate).toHaveBeenCalledTimes(1);
  });

  it('does not call loadBrick for an empty brick', async () => {
    const provider = makeProvider(2, /* isEmpty */ true);
    const renderer = makeRenderer(2);

    const sm = new StreamingManager(
      renderer as any,
      provider,
      makeMetadata(2),
      {} as GPUDevice,
      makeConfig() as any,
    );

    await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });

    expect(provider.loadBrick).not.toHaveBeenCalled();
  });

  it('marks empty bricks in the indirection table without loading data', async () => {
    const provider = makeProvider(2, /* isEmpty */ true);
    const renderer = makeRenderer(2);

    const sm = new StreamingManager(
      renderer as any,
      provider,
      makeMetadata(2),
      {} as GPUDevice,
      makeConfig() as any,
    );

    await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });

    expect(renderer.indirection.setEmpty).toHaveBeenCalledWith(0, 0, 0, 0);
    expect(renderer.allocator.allocate).not.toHaveBeenCalled();
  });
});
