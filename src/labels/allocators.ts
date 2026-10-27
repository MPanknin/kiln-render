/** Allocators for the label pool: fixed-size brick slots, and variable-size palette ranges. */

/** Free list of slot indices; capacity grows when the pool texture does. */
export class SlotAllocator {
  private readonly free: number[] = [];
  private total = 0;

  get capacity(): number { return this.total; }
  get freeCount(): number { return this.free.length; }
  get usedCount(): number { return this.total - this.free.length; }

  /** Add slots [capacity, capacity + count); lower ones are handed out first. */
  grow(count: number): void {
    const added: number[] = [];
    for (let i = this.total + count - 1; i >= this.total; i--) added.push(i);
    this.free.unshift(...added);
    this.total += count;
  }

  /** A free slot, or null when none is. */
  alloc(): number | null {
    return this.free.pop() ?? null;
  }

  release(slot: number): void {
    this.free.push(slot);
  }

  reset(): void {
    this.free.length = 0;
    this.total = 0;
  }
}

/** Palette sizes come in powers of four from 4 (a brick has at most 65535 IDs plus background). */
const MIN_CLASS = 4;

export function paletteClassSize(entries: number): number {
  let size = MIN_CLASS;
  while (size < entries) size *= 4;
  return size;
}

/**
 * Ranges of a growable buffer, in size classes with a free list each, so freed ranges are
 * reused exactly and fragmentation stays bounded without compaction.
 */
export class RangeAllocator {
  private readonly freeLists = new Map<number, number[]>();
  private top = 0;
  private used = 0;

  constructor(private cap: number) {}

  get capacity(): number { return this.cap; }
  /** Entries in allocated ranges (size classes, not requested sizes). */
  get usedCount(): number { return this.used; }

  /** Offset of a range for `entries`, or null when the capacity must grow first. */
  alloc(entries: number): number | null {
    const size = paletteClassSize(entries);
    const reused = this.freeLists.get(size)?.pop();
    if (reused !== undefined) {
      this.used += size;
      return reused;
    }
    if (this.top + size > this.cap) return null;
    const offset = this.top;
    this.top += size;
    this.used += size;
    return offset;
  }

  release(offset: number, entries: number): void {
    const size = paletteClassSize(entries);
    let list = this.freeLists.get(size);
    if (!list) this.freeLists.set(size, list = []);
    list.push(offset);
    this.used -= size;
  }

  /** Room for at least `entries` more past the top; the caller grows the buffer to the new capacity. */
  growFor(entries: number): number {
    while (this.top + paletteClassSize(entries) > this.cap) this.cap *= 2;
    return this.cap;
  }

  reset(capacity: number): void {
    this.freeLists.clear();
    this.top = 0;
    this.used = 0;
    this.cap = capacity;
  }
}
