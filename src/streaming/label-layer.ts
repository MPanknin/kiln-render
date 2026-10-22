/**
 * Streams a label image into the label atlas, slot for slot alongside the image: when a slot
 * gets a new image brick, its labels are marked stale and the label brick at the same address
 * is loaded. The shader shows a slot's labels only once they have arrived, so a reused slot
 * never shows the previous brick's labels.
 */

import type { DataProvider } from '../data/data-provider.js';
import type { VolumeResources } from '../core/volume-resources.js';

/** Label bricks loading at once; they share the network with the image stream. */
const MAX_IN_FLIGHT = 6;

interface SlotLabels {
  key: string;
  ready: boolean;
  abort?: AbortController;
}

interface LabelJob {
  slotIndex: number;
  key: string;
  lod: number;
  bx: number;
  by: number;
  bz: number;
}

export class LabelLayer {
  private readonly slots: Array<SlotLabels | undefined>;
  /** Pending loads by slot, oldest first; remapping a slot replaces its job. */
  private readonly queue = new Map<number, LabelJob>();
  /** hasLabels() answers by timepoint and brick */
  private readonly labelled = new Map<string, Promise<boolean>>();
  private inFlight = 0;
  private disposed = false;

  /**
   * @param levels  which levels the label image covers (see matchLabelLevels)
   * @param onCommit  called after each label brick lands, to redraw
   */
  constructor(
    private readonly resources: VolumeResources,
    private readonly provider: DataProvider,
    private readonly levels: readonly boolean[],
    private readonly onCommit: () => void,
  ) {
    this.slots = new Array(resources.allocator.totalSlots);
    resources.indirection.onBrickMapped = (lod, bx, by, bz, x, y, z) =>
      this.brickMapped(lod, bx, by, bz, resources.allocator.slotToIndex({ x, y, z }));
    this.loadResident();
  }

  /** Re-load the labels of every resident brick, e.g. for another timepoint. */
  reload(): void {
    for (const [slotIndex, entry] of this.slots.entries()) {
      if (!entry) continue;
      entry.abort?.abort();
      if (entry.ready) this.resources.setLabelSlotReady(slotIndex, false);
      this.slots[slotIndex] = undefined;
    }
    this.queue.clear();
    this.loadResident();
  }

  /**
   * Whether the label brick at this address holds any label. The image streaming asks for
   * bricks the image leaves empty: those still load when labelled, so the labels have a slot.
   * An unreadable label brick counts as labelled.
   */
  hasLabels(lod: number, bx: number, by: number, bz: number): Promise<boolean> {
    if (this.disposed || !this.levels[lod]) return Promise.resolve(false);
    const key = `${this.provider.getMetadata().timepoint ?? 0}/${lod}/${bx}/${by}/${bz}`;
    let result = this.labelled.get(key);
    if (!result) {
      result = this.provider.loadBrick(lod, bx, by, bz, 0).then(r => !r || r.max > 0, () => true);
      this.labelled.set(key, result);
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.slots) entry?.abort?.abort();
    this.queue.clear();
    this.resources.indirection.onBrickMapped = undefined;
  }

  /** Bricks already in the atlas, coarsest first so the overview is labelled first. */
  private loadResident(): void {
    const { allocator } = this.resources;
    allocator.getAllocatedSlots()
      .map(slot => ({ slotIndex: allocator.slotToIndex(slot), meta: allocator.getMetadata(allocator.slotToIndex(slot)) }))
      .filter(s => s.meta)
      .sort((a, b) => b.meta!.lod - a.meta!.lod)
      .forEach(({ slotIndex, meta }) => this.brickMapped(meta!.lod, meta!.bx, meta!.by, meta!.bz, slotIndex));
  }

  private brickMapped(lod: number, bx: number, by: number, bz: number, slotIndex: number): void {
    if (this.disposed) return;
    const key = `${lod}/${bx}/${by}/${bz}`;
    const current = this.slots[slotIndex];
    if (current?.key === key) return; // same brick, labels loaded or on their way
    current?.abort?.abort();
    if (current?.ready) this.resources.setLabelSlotReady(slotIndex, false);
    this.slots[slotIndex] = { key, ready: false };
    this.queue.delete(slotIndex);
    if (!this.levels[lod]) return;
    this.queue.set(slotIndex, { slotIndex, key, lod, bx, by, bz });
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.size > 0) {
      const [slotIndex, job] = this.queue.entries().next().value!;
      this.queue.delete(slotIndex);
      const entry = this.slots[slotIndex];
      if (entry?.key !== job.key || entry.ready) continue;
      const abort = new AbortController();
      entry.abort = abort;
      this.inFlight++;
      this.provider.loadBrick(job.lod, job.bx, job.by, job.bz, 0, abort.signal)
        .then(result => {
          if (this.disposed || this.slots[slotIndex] !== entry || !result) return;
          const data = result.data instanceof Uint16Array ? result.data : Uint16Array.from(result.data);
          this.resources.writeLabelBrick(this.resources.allocator.indexToSlot(slotIndex), data);
          this.resources.setLabelSlotReady(slotIndex, true);
          entry.ready = true;
          this.onCommit();
        })
        .catch(e => { if (!abort.signal.aborted) console.warn('[Kiln] label brick failed:', e); })
        .finally(() => {
          if (entry.abort === abort) entry.abort = undefined;
          this.inFlight--;
          if (!this.disposed) this.pump();
        });
    }
  }
}
