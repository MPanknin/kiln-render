/**
 * Atlas Allocator - manages free/used brick slots in the atlas texture.
 * Uses LRU eviction when full, tracking brick metadata for indirection cleanup.
 */

import { GRID_SIZE } from '../core/config.js';

// Slots touched within this many frames are protected from eviction.
// Prevents thrash when atlas is under pressure — a freshly loaded brick
// can't be immediately evicted by the next allocation in the same burst.
const MIN_EVICTION_AGE = 30;

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

  // Atlas grid dimension (slots per axis); may be smaller than the default
  // GRID_SIZE when the atlas was shrunk to fit a VRAM budget.
  private readonly gridSize: number;

  // Total slots available (gridSize³)
  readonly totalSlots: number;

  constructor(gridSize: number = GRID_SIZE) {
    this.gridSize = gridSize;
    this.totalSlots = gridSize * gridSize * gridSize;
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

  // cheap pre-dispatch check for the streaming manager's backpressure
  hasEvictableSlot(currentFrame: number): boolean {
    if (this.freeList.length > 0) return true;
    return this.findLRUSlot(currentFrame) !== -1;
  }

  /** Allocate a slot, evicting the LRU slot if the atlas is full. */
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
    const victim = this.findLRUSlot(frame);
    if (victim === -1) {
      // nothing evictable right now (all pinned or recently touched)
      // bricks stay desired and retry
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
   * Find the least recently used slot (skips pinned and recently-touched slots)
   */
  private findLRUSlot(currentFrame: number): number {
    let oldestFrame = Infinity;
    let victimIdx = -1;

    for (let i = 0; i < this.totalSlots; i++) {
      if (this.pinned.has(i)) continue;
      if (!this.used.has(i)) continue;

      const frameNum = this.lastUsedFrame[i] ?? 0;

      // Skip recently-touched slots to prevent thrash
      if (currentFrame - frameNum < MIN_EVICTION_AGE) continue;

      if (frameNum < oldestFrame) {
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
    // a freed slot must not stay pinned
    this.pinned.delete(idx);
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
    return slot.x + slot.y * this.gridSize + slot.z * this.gridSize * this.gridSize;
  }

  /**
   * Convert flat index to slot coordinates
   */
  indexToSlot(idx: number): AtlasSlot {
    const x = idx % this.gridSize;
    const y = Math.floor(idx / this.gridSize) % this.gridSize;
    const z = Math.floor(idx / (this.gridSize * this.gridSize));
    return { x, y, z };
  }
}
