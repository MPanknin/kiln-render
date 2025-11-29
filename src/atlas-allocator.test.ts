import { describe, it, expect, beforeEach } from 'vitest';
import { AtlasAllocator } from './atlas-allocator.js';

describe('AtlasAllocator', () => {
  let allocator: AtlasAllocator;

  beforeEach(() => {
    allocator = new AtlasAllocator();
  });

  it('should start with all slots free', () => {
    expect(allocator.freeCount).toBe(512); // 8x8x8
    expect(allocator.usedCount).toBe(0);
    expect(allocator.isFull).toBe(false);
  });

  it('should allocate a slot', () => {
    const slot = allocator.allocate();
    expect(slot).not.toBeNull();
    expect(allocator.usedCount).toBe(1);
    expect(allocator.freeCount).toBe(511);
  });

  it('should return unique slots', () => {
    const slots = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const slot = allocator.allocate();
      expect(slot).not.toBeNull();
      const key = `${slot!.x},${slot!.y},${slot!.z}`;
      expect(slots.has(key)).toBe(false);
      slots.add(key);
    }
  });

  it('should free a slot', () => {
    const slot = allocator.allocate()!;
    expect(allocator.usedCount).toBe(1);

    allocator.free(slot);
    expect(allocator.usedCount).toBe(0);
    expect(allocator.freeCount).toBe(512);
  });

  it('should reuse freed slots', () => {
    const slot1 = allocator.allocate()!;
    allocator.free(slot1);

    const slot2 = allocator.allocate()!;
    expect(slot2.x).toBe(slot1.x);
    expect(slot2.y).toBe(slot1.y);
    expect(slot2.z).toBe(slot1.z);
  });

  it('should return null when full', () => {
    // Allocate all 512 slots
    for (let i = 0; i < 512; i++) {
      expect(allocator.allocate()).not.toBeNull();
    }

    expect(allocator.isFull).toBe(true);
    expect(allocator.allocate()).toBeNull();
  });

  it('should reset properly', () => {
    // Allocate some slots
    for (let i = 0; i < 100; i++) {
      allocator.allocate();
    }
    expect(allocator.usedCount).toBe(100);

    allocator.reset();
    expect(allocator.usedCount).toBe(0);
    expect(allocator.freeCount).toBe(512);
  });

  it('should track allocated slots', () => {
    const slot1 = allocator.allocate()!;
    const slot2 = allocator.allocate()!;

    expect(allocator.isAllocated(slot1)).toBe(true);
    expect(allocator.isAllocated(slot2)).toBe(true);

    allocator.free(slot1);
    expect(allocator.isAllocated(slot1)).toBe(false);
    expect(allocator.isAllocated(slot2)).toBe(true);
  });

  it('should return all allocated slots', () => {
    const slot1 = allocator.allocate()!;
    const slot2 = allocator.allocate()!;
    const slot3 = allocator.allocate()!;

    const allocated = allocator.getAllocatedSlots();
    expect(allocated.length).toBe(3);
  });

  it('should have valid slot coordinates', () => {
    for (let i = 0; i < 512; i++) {
      const slot = allocator.allocate()!;
      expect(slot.x).toBeGreaterThanOrEqual(0);
      expect(slot.x).toBeLessThan(8);
      expect(slot.y).toBeGreaterThanOrEqual(0);
      expect(slot.y).toBeLessThan(8);
      expect(slot.z).toBeGreaterThanOrEqual(0);
      expect(slot.z).toBeLessThan(8);
    }
  });
});
