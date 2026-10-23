/**
 * Image streaming with labels shown: a brick the image leaves empty is only skipped when it has
 * no labels either, so labelled regions keep a slot for their label brick.
 */
import { describe, expect, it, vi } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import type { BrickLoadResult, DataProvider, NetworkStats, VolumeMetadata } from '../src/data/data-provider.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

/** One 64³ uint16 brick whose cached stats say it is dark. */
async function streaming(labelled: boolean | null, numChannels = 1) {
  const meta: VolumeMetadata = {
    name: 'v', dimensions: [64, 64, 64], brickSize: 64, physicalBrickSize: 66, maxLod: 0, bitDepth: 16, numChannels,
    levels: [{ lod: 0, dimensions: [64, 64, 64], brickGrid: [1, 1, 1], brickCount: 1 }],
  };
  const brick: BrickLoadResult = { data: new Uint16Array(66 ** 3), min: 0, max: 0, avg: 0 };
  const provider = {
    initialize: vi.fn(), getMetadata: () => meta, getBrickGrid: () => [1, 1, 1],
    loadBrick: vi.fn(async () => brick), isBrickEmpty: vi.fn(async () => true), getBrickStats: vi.fn(async () => null),
    getNetworkStats: () => ({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 }) as NetworkStats,
    dispose: vi.fn(),
  } as unknown as DataProvider;
  const resources = {
    numChannels,
    allocator: {
      allocate: vi.fn(() => ({ slot: { x: 0, y: 0, z: 0 }, slotIndex: 0, evicted: null })),
      setMetadata: vi.fn(), getMetadata: vi.fn(() => ({ lod: 0, bx: 0, by: 0, bz: 0, key: 'lod0:0/0/0' })),
      pin: vi.fn(), touch: vi.fn(), free: vi.fn(), usedCount: 0, totalSlots: 8,
    },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: Array.from({ length: numChannels }, () => ({ bitDepth: 16, format: 'r16unorm' })),
  };
  const config = { normalizedSize: [1, 1, 1], emptyBrickThreshold: 1 };
  const sm = new StreamingManager(resources as never, provider, meta, {} as GPUDevice, config as never, vi.fn());
  const check = vi.fn(async () => labelled ?? false);
  if (labelled !== null) sm.setLabelCheck(check);
  await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
  return { sm, resources, check };
}

describe('empty bricks with labels', () => {
  it('skip a brick the image leaves empty when it has no labels', async () => {
    const { resources, check } = await streaming(false);
    expect(check).toHaveBeenCalledWith(0, 0, 0, 0);
    expect(resources.indirection.setEmpty).toHaveBeenCalledWith(0, 0, 0, 0);
    expect(resources.allocator.allocate).not.toHaveBeenCalled();
  });

  it('load a brick the image leaves empty when it has labels', async () => {
    const { resources } = await streaming(true);
    expect(resources.indirection.setEmpty).not.toHaveBeenCalled();
    expect(resources.indirection.setBrick).toHaveBeenCalledWith(0, 0, 0, 0, 0, 0, 0);
  });

  it('are decided again once labels are shown', async () => {
    const { sm, resources } = await streaming(null);
    expect(resources.indirection.setEmpty).toHaveBeenCalledOnce();
    sm.setLabelCheck(async () => true);
    expect((sm as unknown as { emptyBricks: Map<string, number> }).emptyBricks.size).toBe(0);
    expect(resources.indirection.clearAll).toHaveBeenCalled();
  });

  it('are kept when the fetched image is dark but labelled', async () => {
    const { sm, resources } = await streaming(null);
    const internals = sm as unknown as {
      dataProvider: DataProvider; desiredKeys: Set<string>;
      loadBrick(request: { lod: number; bx: number; by: number; bz: number; key: string }, signal: AbortSignal): Promise<void>;
    };
    vi.mocked(internals.dataProvider.isBrickEmpty).mockResolvedValue(false); // no cached stats: the fetched data decides
    const request = { lod: 0, bx: 0, by: 0, bz: 0, key: 'lod0:0/0/0' };
    internals.desiredKeys.add(request.key);

    sm.setLabelCheck(async () => false);
    await internals.loadBrick(request, new AbortController().signal);
    expect(resources.indirection.setEmpty).toHaveBeenCalledTimes(2);

    sm.setLabelCheck(async () => true);
    internals.desiredKeys.add(request.key);
    await internals.loadBrick(request, new AbortController().signal);
    expect(resources.indirection.setEmpty).toHaveBeenCalledTimes(2);
    expect(resources.indirection.setBrick).toHaveBeenCalledWith(0, 0, 0, 0, 0, 0, 0);
  });
});


const request = { lod: 0, bx: 0, by: 0, bz: 0, key: 'lod0:0/0/0' };
type StreamingInternals = {
  dataProvider: DataProvider;
  desiredKeys: Set<string>;
  emptyBricks: Map<string, number>;
  loadBrick(brick: typeof request, signal: AbortSignal): Promise<void>;
  loadBaseLod(): Promise<void>;
};
const paths = [
  { name: 'cached stats', cached: true, channels: 1 },
  { name: 'single-channel inline stats', cached: false, channels: 1 },
  { name: 'multichannel inline stats', cached: false, channels: 2 },
];

/** Pause precisely at the label lookup, after the image has been found empty. */
async function pendingEmptyCheck(cached: boolean, channels: number, base = false) {
  const { sm, resources } = await streaming(null, channels);
  const internals = sm as unknown as StreamingInternals;
  vi.mocked(internals.dataProvider.isBrickEmpty).mockResolvedValue(cached);
  let resolve!: (value: boolean) => void;
  const check = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  sm.setLabelCheck(check);
  internals.desiredKeys.add(request.key);
  const controller = new AbortController();
  const pending = base ? internals.loadBaseLod() : internals.loadBrick(request, controller.signal);
  await vi.waitFor(() => expect(check).toHaveBeenCalled());
  resources.indirection.setEmpty.mockClear();
  return { sm, resources, internals, controller, pending, resolve, check };
}

describe('pending label emptiness decisions', () => {
  it.each(paths)('cannot hide a replacement label source via $name', async ({ cached, channels }) => {
    const t = await pendingEmptyCheck(cached, channels);
    try {
      t.sm.setLabelCheck(async () => true);
      t.resolve(false);
      await t.pending;
      expect(t.resources.indirection.setEmpty).not.toHaveBeenCalled();
      expect(t.internals.emptyBricks.has(request.key)).toBe(false);
      expect(t.resources.indirection.setBrick).toHaveBeenCalled();
    } finally { t.sm.dispose(); }
  });

  it('cannot hide a replacement label source during the base load', async () => {
    const t = await pendingEmptyCheck(true, 1, true);
    try {
      t.sm.setLabelCheck(async () => true);
      t.resolve(false);
      await t.pending;
      expect(t.resources.indirection.setEmpty).not.toHaveBeenCalled();
      expect(t.internals.emptyBricks.has(request.key)).toBe(false);
      expect(t.resources.indirection.setBrick).toHaveBeenCalled();
    } finally { t.sm.dispose(); }
  });

  it('invalidates a check even if the same callback is installed again', async () => {
    const t = await pendingEmptyCheck(true, 1);
    try {
      t.sm.setLabelCheck(null);
      t.sm.setLabelCheck(t.check);
      // Further lookups belong to the new selection, despite callback identity matching.
      t.check.mockResolvedValue(true);
      t.resolve(false);
      await t.pending;
      expect(t.resources.indirection.setEmpty).not.toHaveBeenCalled();
      expect(t.internals.emptyBricks.has(request.key)).toBe(false);
    } finally { t.sm.dispose(); }
  });

  it.each(paths)('cannot write after cancellation via $name', async ({ cached, channels }) => {
    const t = await pendingEmptyCheck(cached, channels);
    try {
      t.controller.abort(); // e.g. reload for another timepoint
      t.resolve(false);
      await t.pending;
      expect(t.resources.indirection.setEmpty).not.toHaveBeenCalled();
      expect(t.internals.emptyBricks.has(request.key)).toBe(false);
      expect(t.resources.allocator.allocate).not.toHaveBeenCalled();
    } finally { t.sm.dispose(); }
  });
});
