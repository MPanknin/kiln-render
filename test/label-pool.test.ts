import { describe, expect, it } from 'vitest';
import { RangeAllocator, SlotAllocator, paletteClassSize } from '../src/labels/allocators.js';

describe('label pool allocators', () => {
  it('hands out low slots first and reuses released ones', () => {
    const slots = new SlotAllocator();
    expect(slots.alloc()).toBeNull();
    slots.grow(2);
    expect([slots.alloc(), slots.alloc(), slots.alloc()]).toEqual([0, 1, null]);
    slots.release(0);
    slots.grow(2);
    expect([slots.alloc(), slots.alloc(), slots.alloc()]).toEqual([0, 2, 3]);
    expect(slots.usedCount).toBe(4);
    expect(slots.freeCount).toBe(0);
    expect(slots.capacity).toBe(4);
  });

  it('rounds palettes up to powers of four', () => {
    expect([1, 4, 5, 16, 17, 287497].map(paletteClassSize)).toEqual([4, 4, 16, 16, 64, 1048576]);
  });

  it('reuses freed ranges of the same class and grows by doubling', () => {
    const ranges = new RangeAllocator(32);
    expect(ranges.alloc(3)).toBe(0);
    expect(ranges.alloc(10)).toBe(4);
    expect(ranges.alloc(16)).toBeNull(); // 20 + 16 > 32
    expect(ranges.growFor(16)).toBe(64);
    expect(ranges.alloc(16)).toBe(20);
    ranges.release(4, 10);
    expect(ranges.usedCount).toBe(20);
    expect(ranges.alloc(12)).toBe(4);
    ranges.reset(8);
    expect(ranges.alloc(4)).toBe(0);
    expect(ranges.capacity).toBe(8);
  });
});
