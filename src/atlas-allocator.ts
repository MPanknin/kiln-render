/**
 * Atlas Allocator - manages free/used brick slots in the atlas texture
 *
 * Simple free-list allocator. When full, caller must evict before allocating.
 */

import { GRID_SIZE } from './config.js';

export interface AtlasSlot {
  x: number;
  y: number;
  z: number;
}

export class AtlasAllocator {
  // Track which slots are used (flat index -> boolean)
  private used: Set<number>;

  // Free list for O(1) allocation
  private freeList: number[];

  // Total slots available (8x8x8 = 512)
  readonly totalSlots: number;

  constructor() {
    this.totalSlots = GRID_SIZE * GRID_SIZE * GRID_SIZE;
    this.used = new Set();
    this.freeList = [];

    // Initialize free list with all slots
    for (let i = this.totalSlots - 1; i >= 0; i--) {
      this.freeList.push(i);
    }
  }

  /**
   * Allocate a free slot in the atlas
   * Returns null if atlas is full
   */
  allocate(): AtlasSlot | null {
    if (this.freeList.length === 0) {
      return null;
    }

    const idx = this.freeList.pop()!;
    this.used.add(idx);

    return this.indexToSlot(idx);
  }

  /**
   * Free a slot back to the pool
   */
  free(slot: AtlasSlot): void {
    const idx = this.slotToIndex(slot);

    if (!this.used.has(idx)) {
      console.warn(`AtlasAllocator: slot [${slot.x},${slot.y},${slot.z}] not in use`);
      return;
    }

    this.used.delete(idx);
    this.freeList.push(idx);
  }

  /**
   * Check if a slot is currently allocated
   */
  isAllocated(slot: AtlasSlot): boolean {
    return this.used.has(this.slotToIndex(slot));
  }

  /**
   * Get number of free slots remaining
   */
  get freeCount(): number {
    return this.freeList.length;
  }

  /**
   * Get number of used slots
   */
  get usedCount(): number {
    return this.used.size;
  }

  /**
   * Check if atlas is full
   */
  get isFull(): boolean {
    return this.freeList.length === 0;
  }

  /**
   * Reset allocator (free all slots)
   */
  reset(): void {
    this.used.clear();
    this.freeList = [];
    for (let i = this.totalSlots - 1; i >= 0; i--) {
      this.freeList.push(i);
    }
  }

  /**
   * Get all currently allocated slots
   */
  getAllocatedSlots(): AtlasSlot[] {
    return Array.from(this.used).map(idx => this.indexToSlot(idx));
  }

  private slotToIndex(slot: AtlasSlot): number {
    return slot.x + slot.y * GRID_SIZE + slot.z * GRID_SIZE * GRID_SIZE;
  }

  private indexToSlot(idx: number): AtlasSlot {
    const x = idx % GRID_SIZE;
    const y = Math.floor(idx / GRID_SIZE) % GRID_SIZE;
    const z = Math.floor(idx / (GRID_SIZE * GRID_SIZE));
    return { x, y, z };
  }
}
