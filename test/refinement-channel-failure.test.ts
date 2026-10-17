import { describe, expect, it, vi } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { AtlasAllocator } from '../src/streaming/atlas-allocator.js';
import { DatasetConfig } from '../src/core/config.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

describe('multichannel refinement failure', () => {
  it('retries a failed channel instead of permanently marking a dark brick empty', async () => {
    let fail = true;
    const loadBrick = vi.fn(async (_lod: number, _x: number, _y: number, _z: number, ch: number) =>
      ch === 1 && fail ? null : { data: new Uint8Array(66 ** 3), min: 0, max: ch === 1 ? 128 : 0, avg: 0 });
    const resources = {
      numChannels: 2, allocator: new AtlasAllocator(2),
      canvases: [{ bitDepth: 8 }, { bitDepth: 8 }],
      indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn() },
    };
    const sm = new StreamingManager(resources as never, { loadBrick, isBrickEmpty: async () => false } as never,
      { maxLod: 0, levels: [], numChannels: 2, bitDepth: 8 } as never, {} as GPUDevice,
      new DatasetConfig([64, 64, 64], [1, 1, 1], 1), vi.fn(), 3);
    const state = sm as any;
    const request = { lod: 0, bx: 0, by: 0, bz: 0, key: 'lod0:0/0/0', distance: 1 };
    state.desiredKeys.add(request.key);
    try {
      await state.loadBrick(request, new AbortController().signal);
      expect(resources.indirection.setEmpty).not.toHaveBeenCalled();
      expect(state.emptyBricks.has(request.key)).toBe(false);
      expect(state.bricksFailed).toBe(1);

      fail = false;
      await state.loadBrick(request, new AbortController().signal);
      expect(loadBrick).toHaveBeenCalledTimes(4);
      expect(resources.indirection.setBrick).toHaveBeenCalledOnce();
      expect(state.loadedBricks.has(request.key)).toBe(true);
    } finally { sm.dispose(); }
  });

  it('still marks a successfully loaded all-dark brick empty', async () => {
    const resources = { numChannels: 2, allocator: new AtlasAllocator(2),
      indirection: { setEmpty: vi.fn() }, canvases: [{ bitDepth: 8 }, { bitDepth: 8 }] };
    const provider = { isBrickEmpty: async () => false,
      loadBrick: async () => ({ data: new Uint8Array(66 ** 3), min: 0, max: 0, avg: 0 }) };
    const sm = new StreamingManager(resources as never, provider as never,
      { maxLod: 0, levels: [], numChannels: 2, bitDepth: 8 } as never, {} as GPUDevice,
      new DatasetConfig([64, 64, 64], [1, 1, 1], 1), vi.fn(), 3);
    try {
      await (sm as any).loadBrick({ lod: 0, bx: 0, by: 0, bz: 0, key: 'lod0:0/0/0', distance: 1 }, new AbortController().signal);
      expect(resources.indirection.setEmpty).toHaveBeenCalledOnce();
    } finally { sm.dispose(); }
  });
});
