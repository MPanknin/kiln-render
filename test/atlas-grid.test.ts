/**
 * Adaptive atlas sizing — the atlas grid shrinks with channel count so total
 * atlas VRAM stays within a budget (prevents 4-channel OOM crashes on
 * shared-memory mobile GPUs), and the chosen size is injected into the shaders.
 */
import { describe, it, expect } from 'vitest';
import { computeAtlasGrid, GRID_SIZE } from '../src/core/config.js';
import { buildComputeShader, buildSlicePlanesShader } from '../src/shaders/index.js';

describe('adaptive atlas sizing', () => {
  it('keeps full 660 grid for 1-2 channels (r16float)', () => {
    expect(computeAtlasGrid(1, 2)).toEqual({ gridSize: 10, atlasSize: 660 });
    expect(computeAtlasGrid(2, 2)).toEqual({ gridSize: 10, atlasSize: 660 });
  });
  it('shrinks the grid for 4 channels (r16float)', () => {
    const g = computeAtlasGrid(4, 2);
    expect(g.gridSize).toBeLessThan(GRID_SIZE);
    expect(g.atlasSize).toBe(g.gridSize * 66);
    // total VRAM under the default budget
    expect(4 * g.atlasSize ** 3 * 2).toBeLessThanOrEqual(1_400_000_000);
  });
  it('never exceeds the max grid and respects an explicit budget', () => {
    expect(computeAtlasGrid(1, 2, 100).gridSize).toBe(6); // clamped to MIN
    expect(computeAtlasGrid(1, 2, 1e12).gridSize).toBe(GRID_SIZE); // clamped to MAX
  });
  it('injects the runtime atlas size into the compute + slice shaders', () => {
    expect(buildComputeShader(528)).toContain('ATLAS_SIZE: f32 = 528.0');
    expect(buildSlicePlanesShader(528)).toContain('ATLAS_SIZE: f32 = 528.0');
    expect(buildComputeShader(660)).toContain('ATLAS_SIZE: f32 = 660.0');
  });
});
