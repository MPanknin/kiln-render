/**
 * Atlas Allocator - manages free/used brick slots in the atlas texture
 *
 * Uses LRU (Least Recently Used) eviction when the atlas is full.
 * Each slot tracks the brick metadata so we can properly clear the
 * indirection table when evicting.
 */

import { GRID_SIZE } from '../core/config.js';

export interface AtlasSlot {
  x: number;
  y: number;
  z: number;
}

export interface BrickMetadata {
  lod: number;
  bx: number;
  by: number;
  bz: number;
  key: string; // For quick lookup in loadedBricks map
}

export interface AllocationResult {
  slot: AtlasSlot;
  slotIndex: number;
  evicted: BrickMetadata | null;
}

export class AtlasAllocator {
  // Track which slots are used (flat index -> boolean)
  private used: Set<number>;

  // Track which slots are pinned (never evicted)
  private pinned: Set<number>;

  // Free list for O(1) allocation
  private freeList: number[];

  // LRU tracking: frame number when each slot was last used
  private lastUsedFrame: Uint32Array;

  // Reverse mapping: slot index -> brick metadata (for eviction)
  private slotMetadata: (BrickMetadata | null)[];

  // Total slots available (8x8x8 = 512)
  readonly totalSlots: number;

  constructor() {
    this.totalSlots = GRID_SIZE * GRID_SIZE * GRID_SIZE;
    this.used = new Set();
    this.pinned = new Set();
    this.freeList = [];
    this.lastUsedFrame = new Uint32Array(this.totalSlots);
    this.slotMetadata = new Array(this.totalSlots).fill(null);

    // Initialize free list with all slots
    for (let i = this.totalSlots - 1; i >= 0; i--) {
      this.freeList.push(i);
    }
  }

  /**
   * Touch a slot to mark it as recently used
   * Call this for every brick in the current desired set
   */
  touch(slotIndex: number, frame: number): void {
    this.lastUsedFrame[slotIndex] = frame;
  }

  /**
   * Touch a slot by its coordinates
   */
  touchSlot(slot: AtlasSlot, frame: number): void {
    this.touch(this.slotToIndex(slot), frame);
  }

  /**
   * Set metadata for a slot (call after loading a brick)
   */
  setMetadata(slotIndex: number, meta: BrickMetadata): void {
    this.slotMetadata[slotIndex] = meta;
  }

  /**
   * Pin a slot so it will never be evicted
   */
  pin(slotIndex: number): void {
    this.pinned.add(slotIndex);
  }

  /**
   * Unpin a slot so it can be evicted again
   */
  unpin(slotIndex: number): void {
    this.pinned.delete(slotIndex);
  }

  /**
   * Check if a slot is pinned
   */
  isPinned(slotIndex: number): boolean {
    return this.pinned.has(slotIndex);
  }

  /**
   * Get count of pinned slots
   */
  get pinnedCount(): number {
    return this.pinned.size;
  }

  /**
   * Get metadata for a slot
   */
  getMetadata(slotIndex: number): BrickMetadata | null {
    return this.slotMetadata[slotIndex] ?? null;
  }

  /**
   * Allocate a slot in the atlas
   * If atlas is full, evicts the least recently used slot
   *
   * @param frame - Current frame number for LRU tracking
   * @returns AllocationResult with slot and any evicted brick metadata
   */
  allocate(frame: number = 0): AllocationResult | null {
    // Try free list first
    if (this.freeList.length > 0) {
      const idx = this.freeList.pop()!;
      this.used.add(idx);
      this.lastUsedFrame[idx] = frame;

      return {
        slot: this.indexToSlot(idx),
        slotIndex: idx,
        evicted: null
      };
    }

    // Atlas is full - find LRU slot to evict
    const victim = this.findLRUSlot();
    if (victim === -1) {
      // This shouldn't happen if atlas has slots
      return null;
    }

    const evicted = this.slotMetadata[victim] ?? null;

    // Update tracking for the reused slot
    this.lastUsedFrame[victim] = frame;
    this.slotMetadata[victim] = null;

    return {
      slot: this.indexToSlot(victim),
      slotIndex: victim,
      evicted
    };
  }

  /**
   * Find the least recently used slot (skips pinned slots)
   */
  private findLRUSlot(): number {
    let oldestFrame = Infinity;
    let victimIdx = -1;

    for (let i = 0; i < this.totalSlots; i++) {
      // Never evict pinned slots
      if (this.pinned.has(i)) continue;

      const frameNum = this.lastUsedFrame[i] ?? 0;
      if (this.used.has(i) && frameNum < oldestFrame) {
        oldestFrame = frameNum;
        victimIdx = i;
      }
    }

    return victimIdx;
  }

  /**
   * Free a slot back to the pool (explicit free, not LRU eviction)
   */
  free(slot: AtlasSlot): void {
    const idx = this.slotToIndex(slot);

    if (!this.used.has(idx)) {
      console.warn(`AtlasAllocator: slot [${slot.x},${slot.y},${slot.z}] not in use`);
      return;
    }

    this.used.delete(idx);
    this.slotMetadata[idx] = null;
    this.lastUsedFrame[idx] = 0;
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
    this.pinned.clear();
    this.freeList = [];
    this.lastUsedFrame.fill(0);
    this.slotMetadata.fill(null);

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

  /**
   * Convert slot coordinates to flat index
   */
  slotToIndex(slot: AtlasSlot): number {
    return slot.x + slot.y * GRID_SIZE + slot.z * GRID_SIZE * GRID_SIZE;
  }

  /**
   * Convert flat index to slot coordinates
   */
  indexToSlot(idx: number): AtlasSlot {
    const x = idx % GRID_SIZE;
    const y = Math.floor(idx / GRID_SIZE) % GRID_SIZE;
    const z = Math.floor(idx / (GRID_SIZE * GRID_SIZE));
    return { x, y, z };
  }
}
