import { describe, expect, it, vi } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { AtlasAllocator } from '../src/streaming/atlas-allocator.js';
import { DatasetConfig } from '../src/core/config.js';
import { writeToCanvas } from '../src/core/volume.js';
import { float16BitsToFloat32, float32ToFloat16Bits } from '../src/utils/float16.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

function setup(mask = 1) {
  const resources = { numChannels: 2, allocator: new AtlasAllocator(2),
    canvases: [{ bitDepth: 16, format: 'r16float' }, { bitDepth: 16, format: 'r16float' }],
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn() } };
  const provider = { isBrickEmpty: async () => false,
    loadBrick: async (_l: number, _x: number, _y: number, _z: number, ch: number) => ch === 0
      ? { data: new Uint16Array(66 ** 3).fill(float32ToFloat16Bits(50)), min: 0, max: 128, avg: 0 }
      : null };
  const sm = new StreamingManager(resources as never, provider as never,
    { maxLod: 0, levels: [], numChannels: 2, bitDepth: 16, isFloat: true, dataRange: [-100, 100] } as never,
    {} as GPUDevice, new DatasetConfig([64, 64, 64], [1, 1, 1], 1), vi.fn(), mask);
  return { sm, resources, state: sm as any };
}

function expectTransparent(data: Uint16Array) {
  const raw = float16BitsToFloat32(data[0]!);
  expect(raw).toBe(-65504);
  expect(data.every(value => value === data[0])).toBe(true);
  for (const [min, max] of [[-100, 100], [-32768, 32767], [-65504, 65504], [0, 1]]) {
    expect(Math.max(0, Math.min(1, (raw - min!) / (max! - min!)))).toBe(0);
  }
}

describe('raw float missing-channel padding', () => {
  it('initialises missing channels even in a fresh base slot', () => {
    const { sm, resources, state } = setup();
    vi.mocked(writeToCanvas).mockClear();
    try {
      state.zeroStaleChannels(0, { x: 0, y: 0, z: 0 }, 0);
      const calls = vi.mocked(writeToCanvas).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toBe(resources.canvases[1]);
      expectTransparent(calls[0]![2] as Uint16Array);
      expect(state.slotChannels.get(0)).toBe(0);
    } finally { sm.dispose(); }
  });

  it.each([1, 3])('pads fresh refined slots with mask %i without claiming missing data is loaded', async (mask) => {
    const { sm, resources, state } = setup(mask);
    vi.mocked(writeToCanvas).mockClear();
    const request = { lod: 0, bx: 0, by: 0, bz: 0, key: 'lod0:0/0/0', distance: 1 };
    state.desiredKeys.add(request.key);
    // Isolate the commit from the separate missing-channel retry mechanism.
    state.fillMissingChannels = vi.fn();
    try {
      await state.loadBrick(request, new AbortController().signal);
      const writes = vi.mocked(writeToCanvas).mock.calls.filter(c => c[1] === resources.canvases[1]);
      expect(writes).toHaveLength(1);
      expectTransparent(writes[0]![2] as Uint16Array);
      expect(state.slotChannels.get(0)).toBe(1);
    } finally { sm.dispose(); }
  });
});
