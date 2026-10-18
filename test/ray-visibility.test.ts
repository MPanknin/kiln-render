import { describe, expect, it } from 'vitest';
import { RayVisibility } from '../src/streaming/ray-visibility.js';

/** Bitset with the given cell indices set, as the shader writes it. */
function bits(grid: [number, number, number], cells: number[]): Uint32Array {
  const out = new Uint32Array(RayVisibility.wordCount(grid));
  for (const c of cells) out[c >> 5]! |= 1 << (c & 31);
  return out;
}

describe('RayVisibility', () => {
  const grid: [number, number, number] = [4, 3, 3]; // 36 cells → 2 words
  const cell = (x: number, y: number, z: number) => (z * grid[1] + y) * grid[0] + x;

  it('sizes the bitset to the grid', () => {
    expect(RayVisibility.wordCount(grid)).toBe(2);
    expect(RayVisibility.wordCount([32, 1, 1])).toBe(1);
  });

  it('is not ready until the first readback', () => {
    const v = new RayVisibility(grid);
    expect(v.ready).toBe(false);
    v.report(bits(grid, []));
    expect(v.ready).toBe(true);
  });

  it('finds a seen cell inside a box and ignores boxes without one', () => {
    const v = new RayVisibility(grid);
    v.report(bits(grid, [cell(3, 2, 2)])); // last cell, in the second word
    expect(v.anySeen([2, 2, 2], [2, 2, 2])).toBe(true); // box clipped to the grid
    expect(v.anySeen([0, 0, 0], [2, 2, 2])).toBe(false);
  });

  it('keeps a cell visible for the hold window, counted in frames', () => {
    const v = new RayVisibility(grid, 2);
    v.report(bits(grid, [cell(1, 1, 1)]));
    v.report(bits(grid, []));
    expect(v.anySeen([1, 1, 1], [1, 1, 1])).toBe(true);
    v.report(bits(grid, []));
    expect(v.anySeen([1, 1, 1], [1, 1, 1])).toBe(false);
  });

  it('holds for the same number of frames whatever each readback covers', () => {
    const batched = new RayVisibility(grid, 8);
    batched.report(bits(grid, [cell(1, 1, 1)]), 4);
    batched.report(bits(grid, []), 4);
    expect(batched.anySeen([1, 1, 1], [1, 1, 1])).toBe(true);
    batched.report(bits(grid, []), 4);
    expect(batched.anySeen([1, 1, 1], [1, 1, 1])).toBe(false);

    // TAA off: one frame per readback must not shrink the window to 8 / 4 readbacks
    const single = new RayVisibility(grid, 8);
    single.report(bits(grid, [cell(1, 1, 1)]), 1);
    for (let i = 0; i < 7; i++) single.report(bits(grid, []), 1);
    expect(single.anySeen([1, 1, 1], [1, 1, 1])).toBe(true);
    single.report(bits(grid, []), 1);
    expect(single.anySeen([1, 1, 1], [1, 1, 1])).toBe(false);
  });

  it('forgets everything on reset', () => {
    const v = new RayVisibility(grid);
    v.report(bits(grid, [cell(0, 0, 0)]));
    v.reset();
    expect(v.ready).toBe(false);
    expect(v.anySeen([0, 0, 0], [1, 1, 1])).toBe(false);
  });
});
