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
