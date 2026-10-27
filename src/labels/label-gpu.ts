/**
 * GPU side of labels, shared by every view and kept across atlas rebuilds:
 *
 * - pool: one r16uint 3D texture of 66³ slots for all layers. A mixed label brick takes one
 *   slot for its palette indices; background-only and single-ID bricks take none. The texture
 *   starts empty and grows in z (copying what it holds) up to the label budget.
 * - palette: packed RGBA per palette index of every brick in the pool (index 0 transparent).
 * - entries: per shown layer and image atlas slot, how the brick in that slot is labelled.
 * - params: LABEL_UNIFORMS (layer count and per-layer styles).
 * - pick: the label hit under one pixel, written by the shaders for hover and selection.
 *
 * Writes go to CPU mirrors and reach the GPU in flush(), once per frame. `version` changes
 * whenever a texture or buffer is replaced, so renderers know to rebuild their bind groups.
 */

import { LABEL_UNIFORMS, MAX_LABEL_LAYERS } from '../shaders/uniform-layout.js';
import { RangeAllocator, SlotAllocator } from './allocators.js';

const BRICK = 66;
export const LABEL_SLOT_BYTES = BRICK ** 3 * 2;

/** Default upper bound of the label pool's GPU memory. */
export const DEFAULT_LABEL_BUDGET_BYTES = 512 * 1024 * 1024;

/** Bytes of the pick record: hit position (vec4f), then per layer slot + 1, palette index, colour, kind. */
export const PICK_BYTES = 16 + MAX_LABEL_LAYERS * 16;

/** Entry kinds (low two bits of entry.x); the shader skips anything else. */
export const ENTRY_UNIFORM = 2;
export const ENTRY_MIXED = 3;

export interface LabelLayerGpuStyle {
  opacity: number;
  /** 0 off, 1 surface, 2 tint */
  mode3d: number;
  /** 0 off, 1 fill, 2 outline, 3 both */
  slice: number;
}

export class LabelGpu {
  /** Bumped whenever pool, entries or palette is replaced (bind groups must be rebuilt). */
  version = 0;
  readonly slots = new SlotAllocator();
  /** Slots per axis in x and y; the pool grows in z */
  readonly poolGrid: number;
  /** Most slot layers in z the budget and device allow */
  readonly maxDepth: number;
  pool: GPUTexture;
  entries: GPUBuffer;
  palette: GPUBuffer;
  readonly params: GPUBuffer;
  readonly pick: GPUBuffer;

  private depth = 0;
  private atlasSlots = 1;
  private entryData = new Uint32Array(4);
  private entryDirty: [number, number] = [Infinity, -Infinity];
  private readonly ranges = new RangeAllocator(1024);
  private paletteData = new Uint32Array(1024);
  private paletteDirty: [number, number] = [Infinity, -Infinity];
  private readonly paramsData = new ArrayBuffer(LABEL_UNIFORMS.size);
  private paramsDirty = true;
  private disposed = false;

  constructor(private readonly device: GPUDevice, budgetBytes: number) {
    const maxSlotsPerAxis = Math.max(1, Math.floor(device.limits.maxTextureDimension3D / BRICK));
    const budgetSlots = Math.max(1, Math.floor(budgetBytes / LABEL_SLOT_BYTES));
    // Square in x and y, as few z layers as the budget needs
    this.poolGrid = Math.min(maxSlotsPerAxis, Math.max(4, Math.ceil(Math.sqrt(budgetSlots / maxSlotsPerAxis))));
    this.maxDepth = Math.max(1, Math.min(maxSlotsPerAxis, Math.ceil(budgetSlots / this.poolGrid ** 2)));
    this.pool = this.createPool(0);
    this.entries = this.createBuffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.palette = this.createBuffer(this.paletteData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.params = this.createBuffer(LABEL_UNIFORMS.size, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.pick = this.createBuffer(PICK_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  }

  /** Pool bytes allocated on the GPU now, and at most. */
  get poolBytes(): number { return this.poolGrid ** 2 * this.depth * LABEL_SLOT_BYTES; }
  get maxPoolBytes(): number { return this.poolGrid ** 2 * this.maxDepth * LABEL_SLOT_BYTES; }
  get paletteBytes(): number { return this.paletteData.byteLength; }

  /** Grow the pool by doubling its z layers (copying its slots); false at the budget. */
  growPool(): boolean {
    if (this.disposed || this.depth >= this.maxDepth) return false;
    const depth = Math.min(this.maxDepth, Math.max(1, this.depth * 2));
    const pool = this.createPool(depth);
    if (this.depth > 0) {
      const encoder = this.device.createCommandEncoder();
      const size = this.poolGrid * BRICK;
      encoder.copyTextureToTexture({ texture: this.pool }, { texture: pool }, [size, size, this.depth * BRICK]);
      this.device.queue.submit([encoder.finish()]);
    }
    this.pool.destroy();
    this.pool = pool;
    this.slots.grow((depth - this.depth) * this.poolGrid ** 2);
    this.depth = depth;
    this.version++;
    return true;
  }

  /** Free the pool texture (no layer is shown); every slot must have been released. */
  releasePool(): void {
    if (this.depth === 0) return;
    this.pool.destroy();
    this.pool = this.createPool(0);
    this.slots.reset();
    this.depth = 0;
    this.version++;
  }

  /** Upload a brick's palette indices into a pool slot. */
  writeBrick(slot: number, indices: Uint16Array): void {
    const g = this.poolGrid;
    const origin = [(slot % g) * BRICK, (Math.floor(slot / g) % g) * BRICK, Math.floor(slot / (g * g)) * BRICK];
    this.device.queue.writeTexture(
      { texture: this.pool, origin }, indices as Uint16Array<ArrayBuffer>,
      { bytesPerRow: BRICK * 2, rowsPerImage: BRICK }, [BRICK, BRICK, BRICK],
    );
  }

  /** Entries for an image atlas of `slots` slots, `grid` per axis; all start unlabelled. */
  setAtlas(slots: number, grid: number): void {
    this.atlasSlots = slots;
    this.entries.destroy();
    this.entryData = new Uint32Array(MAX_LABEL_LAYERS * slots * 4);
    this.entries = this.createBuffer(this.entryData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.entryDirty = [Infinity, -Infinity];
    const header = new Uint32Array(this.paramsData, 0, 4);
    header[1] = slots;
    header[2] = grid;
    header[3] = this.poolGrid;
    this.paramsDirty = true;
    this.version++;
  }

  writeEntry(layer: number, slot: number, x: number, y: number, z: number, w: number): void {
    const i = (layer * this.atlasSlots + slot) * 4;
    const d = this.entryData;
    if (d[i] === x && d[i + 1] === y && d[i + 2] === z && d[i + 3] === w) return;
    d[i] = x; d[i + 1] = y; d[i + 2] = z; d[i + 3] = w;
    this.entryDirty[0] = Math.min(this.entryDirty[0], i);
    this.entryDirty[1] = Math.max(this.entryDirty[1], i + 4);
  }

  /** Clear the entries of layer rows [from, MAX_LABEL_LAYERS). */
  clearRows(from: number): void {
    const start = from * this.atlasSlots * 4;
    if (start >= this.entryData.length) return;
    this.entryData.fill(0, start);
    this.entryDirty[0] = Math.min(this.entryDirty[0], start);
    this.entryDirty[1] = this.entryData.length;
  }

  /** A palette range for `entries` colours, growing the buffer as needed. */
  allocPalette(entries: number): number {
    let offset = this.ranges.alloc(entries);
    if (offset === null) {
      const capacity = this.ranges.growFor(entries);
      const data = new Uint32Array(capacity);
      data.set(this.paletteData);
      this.paletteData = data;
      this.palette.destroy();
      this.palette = this.createBuffer(data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
      this.paletteDirty = [0, data.length]; // the new buffer starts empty
      this.version++;
      offset = this.ranges.alloc(entries)!;
    }
    return offset;
  }

  freePalette(offset: number, entries: number): void {
    this.ranges.release(offset, entries);
  }

  writeColors(offset: number, colors: Uint32Array): void {
    this.paletteData.set(colors, offset);
    this.paletteDirty[0] = Math.min(this.paletteDirty[0], offset);
    this.paletteDirty[1] = Math.max(this.paletteDirty[1], offset + colors.length);
  }

  /** Styles of the shown layers, in entry row order. */
  setLayers(layers: readonly LabelLayerGpuStyle[]): void {
    new Uint32Array(this.paramsData, 0, 1)[0] = Math.min(layers.length, MAX_LABEL_LAYERS);
    const rows = new Float32Array(this.paramsData, LABEL_UNIFORMS.offsets.layers, MAX_LABEL_LAYERS * 4);
    rows.fill(0);
    layers.slice(0, MAX_LABEL_LAYERS).forEach((l, i) => rows.set([l.opacity, l.mode3d, l.slice, 0], i * 4));
    this.paramsDirty = true;
  }

  get layerCount(): number { return new Uint32Array(this.paramsData, 0, 1)[0]!; }

  /** Send pending writes to the GPU. */
  flush(): void {
    if (this.disposed) return;
    const q = this.device.queue;
    if (this.entryDirty[0] < this.entryDirty[1]) {
      const [lo, hi] = this.entryDirty;
      q.writeBuffer(this.entries, lo * 4, this.entryData as Uint32Array<ArrayBuffer>, lo, hi - lo);
      this.entryDirty = [Infinity, -Infinity];
    }
    if (this.paletteDirty[0] < this.paletteDirty[1]) {
      const [lo, hi] = this.paletteDirty;
      q.writeBuffer(this.palette, lo * 4, this.paletteData as Uint32Array<ArrayBuffer>, lo, hi - lo);
      this.paletteDirty = [Infinity, -Infinity];
    }
    if (this.paramsDirty) {
      q.writeBuffer(this.params, 0, this.paramsData);
      this.paramsDirty = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of [this.pool, this.entries, this.palette, this.params, this.pick]) r.destroy();
  }

  private createPool(depth: number): GPUTexture {
    const size = depth > 0 ? [this.poolGrid * BRICK, this.poolGrid * BRICK, depth * BRICK] : [1, 1, 1];
    return this.device.createTexture({
      size, format: 'r16uint', dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
  }

  private createBuffer(size: number, usage: number): GPUBuffer {
    return this.device.createBuffer({ size: Math.max(16, size), usage });
  }
}
