import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KilnEngine } from '../src/engine.js';
import { VolumeResources } from '../src/core/volume-resources.js';
import { Renderer } from '../src/core/renderer.js';
import { DatasetConfig } from '../src/core/config.js';
import { UnsupportedDatasetError } from '../src/data/data-provider.js';

vi.mock('../src/core/volume-resources.js', () => ({ VolumeResources: vi.fn(function () {}) }));
vi.mock('../src/core/renderer.js', () => ({ Renderer: vi.fn(function () {}) }));

function build(baseBricks: number, maxLod = 0, atlasBudgetBytes?: number) {
  const metadata = { numChannels: 1, maxLod,
    // Use the grid as the source of truth rather than trusting a declared brickCount.
    levels: [{ lod: maxLod, brickGrid: [baseBricks, 1, 1], brickCount: 1 }] };
  return (KilnEngine as any).buildGpu({}, metadata, new DatasetConfig([64, 64, 64]),
    { textureFormat: 'r8unorm', outputFormat: 'bgra8unorm', bitDepth: 8, atlasBudgetBytes });
}

beforeEach(() => vi.clearAllMocks());

describe('base atlas capacity', () => {
  it('rejects an oversized base before any atlas or renderer allocation', () => {
    expect(() => build(1001)).toThrow(UnsupportedDatasetError);
    expect(() => build(1001)).toThrow(/1001 pinned bricks.*1000 slots/);
    expect(VolumeResources).not.toHaveBeenCalled();
    expect(Renderer).not.toHaveBeenCalled();
  });
  it('allows an exactly fitting single-level dataset', () => {
    expect(() => build(1000)).not.toThrow();
    expect(VolumeResources).toHaveBeenCalledOnce();
  });
  it('requires a working slot if finer levels exist', () => {
    expect(() => build(1000, 1)).toThrow(/free slot for refinement/);
    expect(() => build(999, 1)).not.toThrow();
  });
  it('checks the budget-adjusted capacity', () => {
    expect(() => build(217, 0, 1)).toThrow(/216 slots/);
    expect(() => build(216, 0, 1)).not.toThrow();
  });
});

describe('base atlas capacity on a channel-count change', () => {
  // 600 base bricks fit 2 channels (10³ slots) but not 4 (8³ slots at r16float)
  function engineWithBase(brickGrid: number[]) {
    const engine = Object.create(KilnEngine.prototype) as any;
    engine.metadata = { sourceChannels: [0, 1], numChannels: 2, sourceChannelCount: 4, timepoint: 0, maxLod: 1,
      levels: [{ lod: 1, brickGrid, brickCount: 0 }] };
    engine.gpu = { textureFormat: 'r16float', outputFormat: 'bgra8unorm', bitDepth: 16 };
    engine._renderer = { numChannels: 2, dispose: vi.fn() };
    engine.dataProvider = { setSourceSelection: vi.fn() };
    engine.rebuildGpu = vi.fn();
    return engine;
  }

  it('rejects the selection before the provider or the GPU resources change', () => {
    const engine = engineWithBase([10, 10, 6]);
    expect(() => engine.setSourceSelection({ sourceChannels: [0, 1, 2, 3] })).toThrow(/600 pinned bricks.*512 slots at 4 channels/);
    expect(() => engine.setSourceSelection({})).toThrow(UnsupportedDatasetError); // default: first four
    expect(engine.dataProvider.setSourceSelection).not.toHaveBeenCalled();
    expect(engine.rebuildGpu).not.toHaveBeenCalled();
    expect(engine._renderer.dispose).not.toHaveBeenCalled();
  });

  it('lets a base that fits the new atlas through', () => {
    const engine = engineWithBase([8, 8, 6]);
    expect(() => engine.setSourceSelection({ sourceChannels: [0, 1, 2, 3] })).not.toThrow();
    expect(engine.dataProvider.setSourceSelection).toHaveBeenCalledOnce();
  });
});
