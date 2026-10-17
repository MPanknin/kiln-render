import { describe, expect, it, vi } from 'vitest';
import { KilnEngine } from '../src/engine.js';
import type { SourceSelection } from '../src/data/data-provider.js';

describe('engine channel-count changes', () => {
  it.each([{ remaining: [0, 1, 2] }, { remaining: [0, 1] }, { remaining: [0] }])(
    'rebuilds when removing trailing channels to $remaining', ({ remaining }) => {
    const engine = Object.create(KilnEngine.prototype) as any;
    engine.metadata = { sourceChannels: [0, 1, 2, 3], numChannels: 4, timepoint: 0, bitDepth: 8 };
    engine.config = {};
    engine.gpu = { bitDepth: 8 };
    engine._renderer = { numChannels: 4, resetAccumulation: vi.fn() };
    engine.dataProvider = {
      setSourceSelection: (selection: SourceSelection) => {
        engine.metadata.sourceChannels = [...selection.sourceChannels!];
        engine.metadata.numChannels = selection.sourceChannels!.length;
      },
    };
    engine.rebuildGpu = vi.fn(() => {
      engine._renderer = { numChannels: engine.metadata.numChannels, resetAccumulation: vi.fn() };
    });

    engine.setSourceSelection({ sourceChannels: remaining });

    expect(engine.rebuildGpu).toHaveBeenCalledOnce();
    expect(engine.rebuildGpu).toHaveBeenCalledWith(0);
    expect(engine.renderer.numChannels).toBe(remaining.length);
    expect(engine.metadata.sourceChannels).toEqual(remaining);
    expect(engine.renderer.resetAccumulation).toHaveBeenCalledOnce();
    });

  it('keeps an identical selection as a no-op', () => {
    const engine = Object.create(KilnEngine.prototype) as any;
    engine.metadata = { sourceChannels: [0, 1], numChannels: 2, timepoint: 0 };
    engine._renderer = { numChannels: 2 };
    engine.dataProvider = { setSourceSelection: vi.fn() };
    engine.rebuildGpu = vi.fn();

    engine.setSourceSelection({ sourceChannels: [0, 1] });

    expect(engine.rebuildGpu).not.toHaveBeenCalled();
  });
});
