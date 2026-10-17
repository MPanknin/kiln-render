import { describe, expect, it, vi } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { AtlasAllocator } from '../src/streaming/atlas-allocator.js';
import { DatasetConfig } from '../src/core/config.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

const request = { lod: 0, bx: 0, by: 0, bz: 0, key: 'lod0:0/0/0', distance: 1 };
const dark = () => ({ data: new Uint8Array(66 ** 3), min: 0, max: 0, avg: 0 });

function setup(loadBrick: (...args: any[]) => Promise<unknown>) {
  const resources = {
    numChannels: 2, allocator: new AtlasAllocator(2),
    canvases: [{ bitDepth: 8 }, { bitDepth: 8 }],
    indirection: { clearAll: vi.fn(), setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn() },
  };
  const provider = { isBrickEmpty: vi.fn(async () => false), loadBrick: vi.fn(loadBrick) };
  const sm = new StreamingManager(resources as never, provider as never,
    { maxLod: 0, levels: [], numChannels: 2, bitDepth: 8 } as never, {} as GPUDevice,
    new DatasetConfig([128, 64, 64], [1, 1, 1], 1), vi.fn(), 1);
  (sm as any).baseLodLoaded = true;
  (sm as any).desiredKeys.add(request.key);
  return { sm, resources, provider, state: sm as any };
}

describe('visibility changes invalidate emptiness', () => {
  it('loads newly visible signal even when provider stats still describe the dark channel', async () => {
    const { sm, resources, provider, state } = setup(async (_l, _x, _y, _z, ch) => ({ ...dark(), max: ch === 1 ? 128 : 0 }));
    try {
      await state.loadBrick(request, new AbortController().signal);
      expect(state.emptyBricks.get(request.key)).toBe(1); // proven for channel 0 only
      provider.isBrickEmpty.mockResolvedValue(true); // only channel 0 has been scanned

      sm.setVisibleChannels(3);
      expect(state.emptyBricks.has(request.key)).toBe(false);
      expect(resources.indirection.clearAll).toHaveBeenCalledOnce();
      await state.loadBrick(request, new AbortController().signal);

      expect(provider.loadBrick.mock.calls.map(c => c[4])).toEqual([0, 0, 1]);
      expect(state.loadedBricks.has(request.key)).toBe(true);
      expect(resources.indirection.setBrick).toHaveBeenCalledOnce();
    } finally { sm.dispose(); }
  });

  it('restores resident fallback mappings when invalidating empty regions', () => {
    const { sm, resources, state } = setup(async () => dark());
    const allocation = resources.allocator.allocate(0)!;
    const brick = { lod: 1, bx: 0, by: 0, bz: 0, key: 'lod1:0/0/0' };
    resources.allocator.setMetadata(allocation.slotIndex, brick);
    state.loadedBricks.set(brick.key, allocation);
    state.slotChannels.set(allocation.slotIndex, 3);
    state.emptyBricks.set(request.key, 1); // proven dark while only channel 0 was visible
    try {
      sm.setVisibleChannels(3);
      expect(resources.indirection.setBrick).toHaveBeenCalledWith(0, 0, 0,
        allocation.slot.x, allocation.slot.y, allocation.slot.z, 1);
      expect(state.loadedBricks.has(brick.key)).toBe(true);
    } finally { sm.dispose(); }
  });

  it('does not let an in-flight dark result hide a newly visible channel', async () => {
    let resolve!: (value: ReturnType<typeof dark>) => void;
    const pending = new Promise<ReturnType<typeof dark>>(r => { resolve = r; });
    const { sm, resources, provider, state } = setup(async () => pending);
    try {
      const done = state.loadBrick(request, new AbortController().signal);
      await vi.waitFor(() => expect(provider.loadBrick).toHaveBeenCalledOnce());
      sm.setVisibleChannels(3);
      resolve(dark());
      await done;
      expect(resources.indirection.setEmpty).not.toHaveBeenCalled();
      expect(state.emptyBricks.has(request.key)).toBe(false);
    } finally { sm.dispose(); }
  });

  it('hiding a channel preserves existing residency and empty markers', () => {
    const { sm, resources, state } = setup(async () => dark());
    state.visibleMask = 3;
    state.emptyBricks.set(request.key, 3);
    try {
      sm.setVisibleChannels(1);
      expect(state.emptyBricks.has(request.key)).toBe(true);
      expect(resources.indirection.clearAll).not.toHaveBeenCalled();
    } finally { sm.dispose(); }
  });

  it('keeps markers proven with a channel when that channel is shown again', () => {
    const { sm, resources, state } = setup(async () => dark());
    state.visibleMask = 3;
    state.emptyBricks.set(request.key, 3);
    try {
      sm.setVisibleChannels(1);
      sm.setVisibleChannels(3);
      expect(state.emptyBricks.get(request.key)).toBe(3);
      expect(resources.indirection.clearAll).not.toHaveBeenCalled();
    } finally { sm.dispose(); }
  });

  it('re-marks the markers that stay valid after rebuilding the table', () => {
    const { sm, resources, state } = setup(async () => dark());
    state.emptyBricks.set(request.key, 1);
    state.emptyBricks.set('lod1:0/0/0', 3);
    try {
      sm.setVisibleChannels(3);
      expect([...state.emptyBricks.keys()]).toEqual(['lod1:0/0/0']);
      expect(resources.indirection.setEmpty).toHaveBeenCalledWith(0, 0, 0, 1);
    } finally { sm.dispose(); }
  });
});
