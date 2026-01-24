import { describe, it, expect, beforeEach } from 'vitest';
import { AtlasAllocator } from '../src/streaming/atlas-allocator.js';
import { GRID_SIZE, TOTAL_BRICK_SLOTS } from '../src/core/config.js';

describe('AtlasAllocator', () => {
  let allocator: AtlasAllocator;

  beforeEach(() => {
    allocator = new AtlasAllocator();
  });

  it('should start with all slots free', () => {
    expect(allocator.freeCount).toBe(TOTAL_BRICK_SLOTS);
    expect(allocator.usedCount).toBe(0);
    expect(allocator.isFull).toBe(false);
  });

  it('should allocate a slot', () => {
    const result = allocator.allocate();
    expect(result).not.toBeNull();
    expect(result!.slot).toBeDefined();
    expect(result!.slotIndex).toBeGreaterThanOrEqual(0);
    expect(result!.evicted).toBeNull();
    expect(allocator.usedCount).toBe(1);
    expect(allocator.freeCount).toBe(TOTAL_BRICK_SLOTS - 1);
  });

  it('should return unique slots', () => {
    const slots = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const result = allocator.allocate();
      expect(result).not.toBeNull();
      const key = `${result!.slot.x},${result!.slot.y},${result!.slot.z}`;
      expect(slots.has(key)).toBe(false);
      slots.add(key);
    }
  });

  it('should free a slot', () => {
    const result = allocator.allocate()!;
    expect(allocator.usedCount).toBe(1);

    allocator.free(result.slot);
    expect(allocator.usedCount).toBe(0);
    expect(allocator.freeCount).toBe(TOTAL_BRICK_SLOTS);
  });

  it('should reuse freed slots', () => {
    const result1 = allocator.allocate()!;
    allocator.free(result1.slot);

    const result2 = allocator.allocate()!;
    expect(result2.slot.x).toBe(result1.slot.x);
    expect(result2.slot.y).toBe(result1.slot.y);
    expect(result2.slot.z).toBe(result1.slot.z);
  });

  it('should evict LRU when full', () => {
    // Allocate all slots
    for (let i = 0; i < TOTAL_BRICK_SLOTS; i++) {
      const result = allocator.allocate(i); // Use frame number
      expect(result).not.toBeNull();
      // Set metadata so we can track eviction
      allocator.setMetadata(result!.slotIndex, {
        lod: 0,
        bx: i,
        by: 0,
        bz: 0,
        key: `brick-${i}`
      });
    }

    expect(allocator.isFull).toBe(true);

    // Next allocation should evict the oldest (frame 0)
    const result = allocator.allocate(TOTAL_BRICK_SLOTS);
    expect(result).not.toBeNull();
    expect(result!.evicted).not.toBeNull();
    expect(result!.evicted!.key).toBe('brick-0');
  });

  it('should reset properly', () => {
    // Allocate some slots
    for (let i = 0; i < 100; i++) {
      allocator.allocate();
    }
    expect(allocator.usedCount).toBe(100);

    allocator.reset();
    expect(allocator.usedCount).toBe(0);
    expect(allocator.freeCount).toBe(TOTAL_BRICK_SLOTS);
  });

  it('should return all allocated slots', () => {
    allocator.allocate();
    allocator.allocate();
    allocator.allocate();

    const allocated = allocator.getAllocatedSlots();
    expect(allocated.length).toBe(3);
  });

  it('should have valid slot coordinates', () => {
    for (let i = 0; i < Math.min(100, TOTAL_BRICK_SLOTS); i++) {
      const result = allocator.allocate()!;
      expect(result.slot.x).toBeGreaterThanOrEqual(0);
      expect(result.slot.x).toBeLessThan(GRID_SIZE);
      expect(result.slot.y).toBeGreaterThanOrEqual(0);
      expect(result.slot.y).toBeLessThan(GRID_SIZE);
      expect(result.slot.z).toBeGreaterThanOrEqual(0);
      expect(result.slot.z).toBeLessThan(GRID_SIZE);
    }
  });

  describe('pinning', () => {
    it('should not evict pinned slots', () => {
      // Allocate all slots
      const firstResult = allocator.allocate(0)!;
      allocator.setMetadata(firstResult.slotIndex, {
        lod: 0, bx: 0, by: 0, bz: 0, key: 'first'
      });
      allocator.pin(firstResult.slotIndex);

      for (let i = 1; i < TOTAL_BRICK_SLOTS; i++) {
        const result = allocator.allocate(i)!;
        allocator.setMetadata(result.slotIndex, {
          lod: 0, bx: i, by: 0, bz: 0, key: `brick-${i}`
        });
      }

      // First slot is pinned and oldest, but should not be evicted
      const newResult = allocator.allocate(TOTAL_BRICK_SLOTS);
      expect(newResult).not.toBeNull();
      expect(newResult!.evicted).not.toBeNull();
      expect(newResult!.evicted!.key).not.toBe('first');
    });

    it('should track pinned count', () => {
      const r1 = allocator.allocate()!;
      const r2 = allocator.allocate()!;

      allocator.pin(r1.slotIndex);
      expect(allocator.pinnedCount).toBe(1);

      allocator.pin(r2.slotIndex);
      expect(allocator.pinnedCount).toBe(2);

      allocator.unpin(r1.slotIndex);
      expect(allocator.pinnedCount).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently used slot', () => {
      // Allocate all slots with different frame times
      for (let i = 0; i < TOTAL_BRICK_SLOTS; i++) {
        const result = allocator.allocate(i * 10)!;
        allocator.setMetadata(result.slotIndex, {
          lod: 0, bx: i, by: 0, bz: 0, key: `brick-${i}`
        });
      }

      // Touch slot 0 with a very recent frame
      allocator.touch(0, 10000);

      // Next allocation should evict slot 1 (frame 10, not slot 0 which is now recent)
      const result = allocator.allocate(10001);
      expect(result!.evicted!.key).toBe('brick-1');
    });
  });
});
