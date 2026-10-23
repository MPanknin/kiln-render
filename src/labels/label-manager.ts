/**
 * LabelManager: label layers over the image, streamed brick for brick alongside it.
 *
 * Every image atlas slot is labelled per shown layer by the label brick at the same address
 * (bindings). Bricks that are background only or one ID need no GPU memory: the entry holds
 * the colour. Mixed bricks go into the shared pool (LabelGpu) and stay there, unused ones
 * evicted first when space runs out. While a brick loads, its slot shows the nearest loaded
 * ancestor, so labels sharpen as the image refines instead of disappearing. Image bricks the
 * image leaves empty still load where a shown layer has labels (StreamingManager label check).
 */

import type { DataProvider, VolumeMetadata } from '../data/data-provider.js';
import type { DatasetConfig } from '../core/config.js';
import type { VolumeResources } from '../core/volume-resources.js';
import type { StreamingManager } from '../streaming/streaming-manager.js';
import type { BrickMetadata } from '../streaming/atlas-allocator.js';
import type { Vec3 } from '../core/pyramid.js';
import type { ImageGeometry, LabelLevelParams } from '../data/label-image.js';
import type { LabelBrickData } from '../data/label-assembly.js';
import { LabelWorkerPool, openLabelImage } from '../data/label-reader.js';
import { MAX_LABEL_LAYERS } from '../shaders/uniform-layout.js';
import { ENTRY_MIXED, ENTRY_UNIFORM, PICK_BYTES } from './label-gpu.js';
import type { LabelGpu } from './label-gpu.js';
import { LabelLayer } from './label-layer.js';
import type { LabelBinding, LabelBound, LabelLayerHost, LabelLayerOptions, ResidentLabelBrick } from './label-layer.js';
import { resolveColor, unpackRgba } from './label-colors.js';

/** Label bricks loading at once, across layers; they share the network with the image. */
const MAX_IN_FLIGHT = 8;
/** Brick summaries kept per layer (a few bytes each); the oldest tenth goes when full. */
const MAX_SUMMARIES = 200_000;
/** Recently loaded bricks kept on the CPU for slots that bind them soon after (label checks, a full pool). */
const MAX_RECENT = 32;
/** A failed brick isn't requested again for this long. */
const RETRY_MS = 10_000;

/** Default upper bound of the label pool's GPU memory. */
export const DEFAULT_LABEL_BUDGET_BYTES = 512 * 1024 * 1024;

/** What the manager needs from the engine. */
export interface LabelHost {
  readonly provider: DataProvider;
  readonly metadata: VolumeMetadata;
  readonly config: DatasetConfig;
  resources(): VolumeResources;
  streaming(): StreamingManager;
  /** Content changed: every view re-renders and restarts accumulation */
  redraw(): void;
}

/** A segment under the cursor. */
export interface LabelHit {
  layer: LabelLayer;
  id: number;
  /** Name from the segment's properties, if any */
  name?: string;
  /** Drawn colour, 0–255 RGBA */
  color: [number, number, number, number];
}

/** What a pick found: the finest-level voxel it hit (if any) and the segments there, top layer first. */
export interface LabelPick {
  voxel: Vec3 | null;
  hits: LabelHit[];
}

export interface LabelStats {
  layers: number;
  shown: number;
  /** Label pool GPU memory now and at most */
  poolBytes: number;
  maxPoolBytes: number;
  paletteBytes: number;
  /** Mixed bricks in the pool: labelling a slot, and kept for later */
  bricksInUse: number;
  bricksCached: number;
  /** Label bricks loading or waiting to */
  loading: number;
  bytesFetched: number;
}

interface Load {
  key: string;
  layer: LabelLayer;
  lod: number;
  bx: number;
  by: number;
  bz: number;
  timepoint: number;
  /** Image atlas slots that will show the brick */
  waiters: Set<number>;
  /** Label checks waiting for whether the brick has labels */
  checks: Array<(labelled: boolean) => void>;
  controller: AbortController | null;
}

export class LabelManager implements LabelLayerHost {
  readonly gpu: LabelGpu;
  /** Label images in the dataset's `labels` group */
  available: readonly string[] = [];
  /** Layers were added, removed, reordered, shown or hidden: for UIs */
  onChange?: () => void;

  private readonly _layers: LabelLayer[] = [];
  private readonly resident = new Map<string, ResidentLabelBrick>();
  /** Resident bricks labelling nothing, oldest first: evicted first */
  private readonly unused = new Set<ResidentLabelBrick>();
  private readonly loads = new Map<string, Load>();
  private queue: Load[] = [];
  private inFlight = 0;
  /** Bricks that found the pool full, waiting for a brick to become unused */
  private readonly starved = new Map<string, Load>();
  private readonly recent = new Map<string, LabelBrickData>();
  private workers: LabelWorkerPool | null = null;
  private resources: VolumeResources | null = null;
  private timepoint = 0;
  private nextUid = 1;
  private layoutDirty = false;
  private readonly recolor = new Set<LabelLayer>();
  private disposed = false;

  constructor(gpu: LabelGpu, private readonly host: LabelHost) {
    this.gpu = gpu;
    this.timepoint = host.metadata.timepoint ?? 0;
  }

  /** Layers in drawing priority: the first is on top where layers overlap. */
  get layers(): readonly LabelLayer[] { return this._layers; }

  /** Layers shown, in entry row order. */
  get shown(): LabelLayer[] { return this._layers.filter(l => l.row >= 0); }

  /**
   * Open label image `source` (a name from `available` or an OME-Zarr URL) as a new layer, or
   * return the layer already showing it. Rejects when it can't be opened or doesn't fit the image.
   */
  async add(source: string, options: LabelLayerOptions = {}): Promise<LabelLayer> {
    if (this.disposed) throw new Error('Labels are disposed');
    const existing = this._layers.find(l => l.source === source);
    if (existing) return existing;
    const location = this.host.provider.labelLocation?.(source);
    if (!location) throw new Error('This dataset does not support labels');
    const name = this.available.includes(source) ? source : source.replace(/\/+$/, '').split('/').pop() ?? source;
    const opened = await openLabelImage(location, name, this.imageGeometry(), () => this.workers ??= new LabelWorkerPool());
    if (this.disposed) {
      opened.reader.dispose();
      throw new Error('Labels are disposed');
    }
    const again = this._layers.find(l => l.source === source); // added while opening
    if (again) {
      opened.reader.dispose();
      return again;
    }
    const layer = new LabelLayer(this, this.nextUid++, source, opened, options);
    if (layer.visible && this.shown.length >= MAX_LABEL_LAYERS) {
      console.warn(`[Kiln] labels "${name}" hidden: at most ${MAX_LABEL_LAYERS} label layers are shown at once`);
      layer.visible = false;
    }
    for (const note of layer.notes) console.warn(`[Kiln] labels "${name}": ${note}`);
    this._layers.push(layer);
    this.layout();
    this.onChange?.();
    return layer;
  }

  /** Remove a layer and free everything it holds. */
  remove(layer: LabelLayer): void {
    const i = this._layers.indexOf(layer);
    if (i < 0) return;
    layer.bindings.forEach((b, slot) => { if (b) this.unbind(layer, slot, b); });
    layer.bindings = [];
    layer.row = -1;
    this._layers.splice(i, 1);
    layer.disposed = true;
    for (const load of [...this.loads.values()]) if (load.layer === layer) this.dropLoad(load);
    for (const [key, load] of this.starved) if (load.layer === layer) this.starved.delete(key);
    for (const brick of [...this.resident.values()]) if (brick.layer === layer) this.evict(brick);
    for (const key of [...this.recent.keys()]) if (key.startsWith(`${layer.uid}/`)) this.recent.delete(key);
    this.layout();
    layer.reader.dispose();
    this.host.redraw();
    this.onChange?.();
  }

  /**
   * Add several layers in order (e.g. from a share URL); each is a source or a source with
   * options. Layers that fail are skipped with a warning.
   */
  async addAll(layers: ReadonlyArray<string | (LabelLayerOptions & { source: string })>): Promise<LabelLayer[]> {
    const added: LabelLayer[] = [];
    for (const l of layers) {
      const { source, ...options } = typeof l === 'string' ? { source: l } : l;
      try {
        added.push(await this.add(source, options));
      } catch (e) {
        console.warn(`[Kiln] labels "${source}" not shown:`, e);
      }
    }
    return added;
  }

  /** Move a layer to `index` in the drawing priority. */
  move(layer: LabelLayer, index: number): void {
    const from = this._layers.indexOf(layer);
    if (from < 0) return;
    this._layers.splice(from, 1);
    this._layers.splice(Math.max(0, Math.min(index, this._layers.length)), 0, layer);
    this.layout();
    this.onChange?.();
  }

  /** @internal LabelLayerHost: a layer's visibility, style or colours changed. */
  layerChanged(layer: LabelLayer, what: 'visible' | 'style' | 'colors'): void {
    if (layer.disposed || !this._layers.includes(layer)) return;
    if (what === 'visible') {
      if (layer.visible && layer.row < 0 && this.shown.length >= MAX_LABEL_LAYERS) {
        layer.visible = false; // re-enters with false, which changes nothing
        throw new Error(`At most ${MAX_LABEL_LAYERS} label layers can be shown at once`);
      }
      this.layout();
      this.onChange?.();
    } else if (what === 'style') {
      this.layoutDirty = true;
    } else {
      this.recolor.add(layer);
    }
    this.host.redraw();
  }

  /** Follow a new image atlas (engine creation, channel count change): bind its slots afresh. */
  attach(resources: VolumeResources): void {
    if (this.disposed) return;
    for (const layer of this._layers) {
      layer.bindings.forEach((b, slot) => { if (b) this.unbind(layer, slot, b); });
      layer.bindings = [];
    }
    if (this.resources && this.resources !== resources) this.resources.allocator.onSlotChange = undefined;
    this.resources = resources;
    this.gpu.setAtlas(resources.allocator.totalSlots, resources.gridSize);
    resources.allocator.onSlotChange = (slot, meta) => this.slotChanged(slot, meta);
    const shown = this.shown;
    this.layoutRows();
    for (const layer of shown) this.bindAll(layer);
    if (shown.length > 0) this.host.streaming().setLabelCheck(this.check);
  }

  /** The image switched timepoint: layers with one per timepoint load that one. */
  setTimepoint(timepoint: number): void {
    if (timepoint === this.timepoint) return;
    this.timepoint = timepoint;
    for (const layer of this.shown) if (layer.timeVarying) this.bindAll(layer);
  }

  /** Per frame: apply style and colour changes, start loads, send writes to the GPU. */
  update(): void {
    if (this.disposed) return;
    if (this.layoutDirty) this.layoutRows();
    for (const layer of this.recolor) this.applyColors(layer);
    this.recolor.clear();
    this.pump();
    this.gpu.flush();
  }

  /** Label check for the image streaming: whether a shown layer has labels in an image brick. */
  private readonly check = (lod: number, bx: number, by: number, bz: number): Promise<boolean> => {
    const layers = this.shown;
    if (layers.length === 0) return Promise.resolve(false);
    return Promise.all(layers.map(l => this.layerHasLabels(l, lod, bx, by, bz))).then(r => r.some(Boolean));
  };

  /**
   * Resolve a pick record the shaders wrote (see LabelGpu.pick): the hit voxel and, per shown
   * layer, the slot and palette index there. Segments are looked up in the CPU-side palettes.
   */
  resolvePick(record: ArrayBuffer): LabelPick {
    const hit = new Float32Array(record, 0, 4);
    const rows = new Uint32Array(record, 16, (PICK_BYTES - 16) / 4);
    if (hit[3]! < 0.5) return { voxel: null, hits: [] };
    const hits: LabelHit[] = [];
    this.shown.forEach((layer, row) => {
      const slotPlus1 = rows[row * 4]!;
      const index = rows[row * 4 + 1]!;
      if (slotPlus1 === 0) return;
      const bound = layer.bindings[slotPlus1 - 1]?.bound;
      const id = !bound ? 0 : bound.kind === 'uniform' ? bound.id : bound.brick.palette[index] ?? 0;
      if (id === 0) return;
      const color = unpackRgba(resolveColor(id, layer.segmentStyle()));
      if (color[3] === 0) return;
      hits.push({ layer, id, name: layer.segment(id).name, color });
    });
    return { voxel: [hit[0]!, hit[1]!, hit[2]!], hits };
  }

  /** IDs of a layer's segments in the bricks loaded now (at most `limit`; `more` when there are others). */
  loadedSegments(layer: LabelLayer, limit = 256): { ids: number[]; more: boolean } {
    const ids = new Set<number>();
    const add = (id: number) => { if (id > 0) ids.add(id); return ids.size > limit; };
    for (const brick of this.resident.values()) {
      if (brick.layer !== layer || brick.refs === 0) continue;
      for (let i = 1; i < brick.palette.length; i++) if (add(brick.palette[i]!)) return { ids: [...ids].slice(0, limit).sort((a, b) => a - b), more: true };
    }
    for (const b of layer.bindings) if (b?.bound?.kind === 'uniform' && add(b.bound.id)) break;
    const sorted = [...ids].sort((a, b) => a - b);
    return { ids: sorted.slice(0, limit), more: sorted.length > limit };
  }

  get stats(): LabelStats {
    let inUse = 0;
    for (const b of this.resident.values()) if (b.refs > 0) inUse++;
    return {
      layers: this._layers.length,
      shown: this.shown.length,
      poolBytes: this.gpu.poolBytes,
      maxPoolBytes: this.gpu.maxPoolBytes,
      paletteBytes: this.gpu.paletteBytes,
      bricksInUse: inUse,
      bricksCached: this.resident.size - inUse,
      loading: this.loads.size,
      bytesFetched: this._layers.reduce((sum, l) => sum + l.reader.bytesFetched, 0),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const load of this.loads.values()) load.controller?.abort();
    this.loads.clear();
    this.queue = [];
    for (const layer of this._layers) {
      layer.disposed = true;
      layer.reader.dispose();
    }
    if (this.resources?.allocator.onSlotChange) this.resources.allocator.onSlotChange = undefined;
    this.workers?.dispose();
    this.gpu.dispose();
  }

  // ---------------------------------------------------------------------------------------------
  // Layout: which layers are shown, in which entry rows

  /** Shown layers get rows in list order; newly shown ones bind every slot, hidden ones unbind. */
  private layout(): void {
    if (this.disposed) return;
    const before = new Set(this.shown);
    let row = 0;
    for (const layer of this._layers) layer.row = layer.visible && row < MAX_LABEL_LAYERS ? row++ : -1;
    const after = this.shown;
    for (const layer of before) {
      if (layer.row >= 0) continue;
      layer.bindings.forEach((b, slot) => { if (b) this.unbind(layer, slot, b); });
      layer.bindings = [];
    }
    this.layoutRows();
    const added = after.filter(l => !before.has(l));
    for (const layer of added) this.bindAll(layer);
    if (after.length === 0 && this.resources) {
      this.host.streaming().setLabelCheck(null);
      // Nothing shown: give the pool's memory back
      for (const brick of [...this.resident.values()]) this.evict(brick);
      this.starved.clear();
      this.gpu.releasePool();
    } else if (added.length > 0 && this.resources) {
      // Empty-brick decisions made without these labels are taken again
      this.host.streaming().setLabelCheck(this.check);
    }
  }

  /** Rewrite every entry row and the layer styles. */
  private layoutRows(): void {
    this.layoutDirty = false;
    this.gpu.clearRows(0);
    const shown = this.shown;
    for (const layer of shown) {
      layer.bindings.forEach((b, slot) => { if (b) this.writeEntry(layer, slot, b.bound); });
    }
    this.gpu.setLayers(shown.map(l => ({
      opacity: l.opacity,
      mode3d: { off: 0, surface: 1, tint: 2 }[l.style3d],
      slice: { off: 0, fill: 1, outline: 2, both: 3 }[l.slice],
    })));
  }

  // ---------------------------------------------------------------------------------------------
  // Bindings: image atlas slot → label brick

  private slotChanged(slot: number, meta: BrickMetadata | null): void {
    for (const layer of this.shown) this.bindSlot(layer, slot, meta);
  }

  /** Bind every occupied image slot, coarsest bricks first so the overview labels first. */
  private bindAll(layer: LabelLayer): void {
    const allocator = this.resources?.allocator;
    if (!allocator) return;
    const occupied: Array<[number, BrickMetadata]> = [];
    for (let slot = 0; slot < allocator.totalSlots; slot++) {
      const meta = allocator.getMetadata(slot);
      if (meta) occupied.push([slot, meta]);
    }
    occupied.sort((a, b) => b[1].lod - a[1].lod);
    for (const [slot, meta] of occupied) this.bindSlot(layer, slot, meta);
  }

  private bindSlot(layer: LabelLayer, slot: number, meta: BrickMetadata | null): void {
    const old = layer.bindings[slot];
    const key = meta && this.key(layer, meta.lod, meta.bx, meta.by, meta.bz);
    if (old && old.key === key) return;
    if (old) this.unbind(layer, slot, old);
    if (!meta || !key) {
      layer.bindings[slot] = undefined;
      this.writeEntry(layer, slot, null);
      return;
    }
    const binding: LabelBinding = { lod: meta.lod, bx: meta.bx, by: meta.by, bz: meta.bz, key, bound: null, exact: false };
    layer.bindings[slot] = binding;
    this.resolve(layer, slot, binding);
  }

  /** Bind the slot's own brick if it is known, else the nearest known ancestor and load it. */
  private resolve(layer: LabelLayer, slot: number, b: LabelBinding): void {
    const own = this.lookup(layer, b.key, b.lod);
    if (own !== undefined) {
      this.setBound(layer, slot, b, own, true);
      return;
    }
    this.setBound(layer, slot, b, this.ancestor(layer, b), false);
    if (layer.summaries.get(b.key) === -1 && this.recent.has(b.key)) {
      // Loaded, but the pool is full of bricks in use: wait until one becomes unused
      let wait = this.starved.get(b.key);
      if (!wait) {
        wait = { key: b.key, layer, lod: b.lod, bx: b.bx, by: b.by, bz: b.bz, timepoint: 0, waiters: new Set(), checks: [], controller: null };
        this.starved.set(b.key, wait);
      }
      wait.waiters.add(slot);
    } else if (!this.recentlyFailed(layer, b.key)) {
      this.request(layer, b.key, b.lod, b.bx, b.by, b.bz).waiters.add(slot);
    }
  }

  /** What labels the brick `key` of level `lod`, or undefined while it isn't loaded. */
  private lookup(layer: LabelLayer, key: string, lod: number): LabelBound | undefined {
    if (!layer.levels[lod]) return null; // no labels at this level
    const summary = layer.summaries.get(key);
    if (summary === 0) return null;
    if (summary !== undefined && summary > 0) return { kind: 'uniform', id: summary };
    const brick = this.resident.get(key);
    if (brick) return { kind: 'mixed', brick };
    const data = this.recent.get(key);
    if (data && summary === -1) {
      const uploaded = this.upload(layer, key, lod, data);
      if (uploaded) return { kind: 'mixed', brick: uploaded };
    }
    return undefined;
  }

  /** The nearest coarser brick that is known, as a stand-in while the slot's own one loads. */
  private ancestor(layer: LabelLayer, b: LabelBinding): LabelBound {
    for (let lod = b.lod + 1; lod < layer.levels.length; lod++) {
      const ratio = this.host.config.levelRatio(lod, b.lod);
      const ax = Math.floor(b.bx / ratio[0]), ay = Math.floor(b.by / ratio[1]), az = Math.floor(b.bz / ratio[2]);
      const found = this.lookup(layer, this.key(layer, lod, ax, ay, az), lod);
      if (found !== undefined) return found;
    }
    return null;
  }

  private setBound(layer: LabelLayer, slot: number, b: LabelBinding, bound: LabelBound, exact: boolean): void {
    if (bound?.kind === 'mixed') this.retain(bound.brick);
    this.release(b.bound);
    b.bound = bound;
    b.exact = exact;
    this.writeEntry(layer, slot, bound);
  }

  private unbind(layer: LabelLayer, slot: number, b: LabelBinding): void {
    this.release(b.bound);
    b.bound = null;
    for (const load of [this.loads.get(b.key), this.starved.get(b.key)]) {
      if (!load) continue;
      load.waiters.delete(slot);
      if (load.waiters.size === 0 && load.checks.length === 0) this.dropLoad(load);
    }
    this.writeEntry(layer, slot, null);
  }

  private retain(brick: ResidentLabelBrick): void {
    if (brick.refs++ === 0) this.unused.delete(brick);
  }

  private release(bound: LabelBound): void {
    if (bound?.kind !== 'mixed') return;
    const brick = bound.brick;
    if (--brick.refs > 0) return;
    this.unused.add(brick);
    // Room for a brick that found the pool full
    const [key, load] = this.starved.entries().next().value ?? [];
    if (key && load) {
      this.starved.delete(key);
      queueMicrotask(() => this.retryStarved(load));
    }
  }

  private retryStarved(load: Load): void {
    if (this.disposed || load.layer.disposed) return;
    for (const slot of load.waiters) {
      const b = load.layer.bindings[slot];
      if (b && b.key === load.key && !b.exact) this.resolve(load.layer, slot, b);
    }
  }

  private writeEntry(layer: LabelLayer, slot: number, bound: LabelBound): void {
    if (layer.row < 0) return;
    if (!bound) {
      this.gpu.writeEntry(layer.row, slot, 0, 0, 0, 0);
    } else if (bound.kind === 'uniform') {
      this.gpu.writeEntry(layer.row, slot, ENTRY_UNIFORM, resolveColor(bound.id, layer.segmentStyle()), 0, 0);
    } else {
      const { slots, lod, paletteOffset } = bound.brick;
      this.gpu.writeEntry(layer.row, slot, ENTRY_MIXED | (slots.length << 2) | (lod << 4), paletteOffset,
        (slots[0]! | ((slots[1] ?? 0) << 16)) >>> 0, slots[2] ?? 0);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Loading

  private key(layer: LabelLayer, lod: number, bx: number, by: number, bz: number): string {
    return `${layer.uid}/${layer.timeVarying ? this.timepoint : 0}/${lod}/${bx}/${by}/${bz}`;
  }

  private recentlyFailed(layer: LabelLayer, key: string): boolean {
    const at = layer.failed.get(key);
    if (at === undefined) return false;
    if (performance.now() - at < RETRY_MS) return true;
    layer.failed.delete(key);
    return false;
  }

  private request(layer: LabelLayer, key: string, lod: number, bx: number, by: number, bz: number): Load {
    let load = this.loads.get(key);
    if (!load) {
      load = { key, layer, lod, bx, by, bz, timepoint: layer.timeVarying ? this.timepoint : 0, waiters: new Set(), checks: [], controller: null };
      this.loads.set(key, load);
      // Coarser first: one coarse brick labels what many fine ones would
      const at = this.queue.findIndex(q => q.lod < lod);
      if (at < 0) this.queue.push(load);
      else this.queue.splice(at, 0, load);
    }
    return load;
  }

  private layerHasLabels(layer: LabelLayer, lod: number, bx: number, by: number, bz: number): Promise<boolean> {
    if (!layer.levels[lod]) return Promise.resolve(false);
    const key = this.key(layer, lod, bx, by, bz);
    const summary = layer.summaries.get(key);
    if (summary !== undefined) return Promise.resolve(summary !== 0);
    if (this.recentlyFailed(layer, key)) return Promise.resolve(true); // unknown: keep the image brick
    return new Promise(resolve => {
      this.request(layer, key, lod, bx, by, bz).checks.push(resolve);
      this.pump();
    });
  }

  private pump(): void {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
      const load = this.queue.shift()!;
      if (load.waiters.size === 0 && load.checks.length === 0) {
        this.loads.delete(load.key);
        continue;
      }
      this.start(load);
    }
  }

  private start(load: Load): void {
    const level = load.layer.levels[load.lod] as LabelLevelParams;
    const controller = new AbortController();
    load.controller = controller;
    this.inFlight++;
    load.layer.reader.load(level, load.bx, load.by, load.bz, load.timepoint, controller.signal)
      .then(data => { if (!controller.signal.aborted) this.loaded(load, data); })
      .catch((e: unknown) => {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        console.warn(`[Kiln] label brick ${load.key} failed:`, e);
        this.failed(load);
      })
      .finally(() => {
        this.inFlight--;
        if (this.loads.get(load.key) === load) this.loads.delete(load.key);
        if (!this.disposed) this.pump();
      });
  }

  private dropLoad(load: Load): void {
    if (this.loads.get(load.key) === load) this.loads.delete(load.key);
    if (this.starved.get(load.key) === load) this.starved.delete(load.key);
    load.controller?.abort();
    const i = this.queue.indexOf(load);
    if (i >= 0) this.queue.splice(i, 1);
    for (const check of load.checks) check(true);
    load.checks = [];
  }

  private loaded(load: Load, data: LabelBrickData): void {
    const { layer, key } = load;
    if (this.disposed || layer.disposed) return;
    this.loads.delete(key);
    this.setSummary(layer, key, data.kind === 'empty' ? 0 : data.kind === 'uniform' ? data.palette[1]! : -1);
    if (data.kind === 'mixed') this.remember(key, data);
    for (const check of load.checks) check(data.kind !== 'empty');
    load.checks = [];
    for (const slot of load.waiters) {
      const b = layer.bindings[slot];
      if (b && b.key === key && !b.exact) this.resolve(layer, slot, b);
    }
    this.host.redraw();
  }

  private failed(load: Load): void {
    load.layer.failed.set(load.key, performance.now());
    for (const check of load.checks) check(true);
    load.checks = [];
  }

  private setSummary(layer: LabelLayer, key: string, value: number): void {
    const summaries = layer.summaries;
    if (summaries.size >= MAX_SUMMARIES) {
      let drop = MAX_SUMMARIES / 10;
      for (const k of summaries.keys()) {
        summaries.delete(k);
        if (--drop <= 0) break;
      }
    }
    summaries.set(key, value);
  }

  private remember(key: string, data: LabelBrickData): void {
    this.recent.delete(key);
    this.recent.set(key, data);
    if (this.recent.size > MAX_RECENT) this.recent.delete(this.recent.keys().next().value!);
  }

  // ---------------------------------------------------------------------------------------------
  // Pool

  /** Put a mixed brick into the pool (evicting unused bricks or growing it); null when full. */
  private upload(layer: LabelLayer, key: string, lod: number, data: LabelBrickData): ResidentLabelBrick | null {
    let slots = this.gpu.slots.alloc(data.planes.length);
    while (!slots) {
      const victim = this.unused.values().next().value;
      if (victim) this.evict(victim);
      else if (!this.gpu.growPool()) return null;
      slots = this.gpu.slots.alloc(data.planes.length);
    }
    const brick: ResidentLabelBrick = {
      key, layer, lod, palette: data.palette, slots, paletteOffset: this.gpu.allocPalette(data.palette.length), refs: 0,
    };
    data.planes.forEach((plane, i) => this.gpu.writePlane(slots![i]!, plane));
    this.writeColors(brick);
    this.resident.set(key, brick);
    this.unused.add(brick);
    this.recent.delete(key);
    return brick;
  }

  private evict(brick: ResidentLabelBrick): void {
    this.resident.delete(brick.key);
    this.unused.delete(brick);
    this.gpu.slots.release(brick.slots);
    this.gpu.freePalette(brick.paletteOffset, brick.palette.length);
  }

  private writeColors(brick: ResidentLabelBrick): void {
    const style = brick.layer.segmentStyle();
    const colors = new Uint32Array(brick.palette.length);
    for (let i = 1; i < colors.length; i++) colors[i] = resolveColor(brick.palette[i]!, style);
    this.gpu.writeColors(brick.paletteOffset, colors);
  }

  /** Colours changed: rewrite the layer's palettes and its single-ID entries. */
  private applyColors(layer: LabelLayer): void {
    for (const brick of this.resident.values()) if (brick.layer === layer) this.writeColors(brick);
    layer.bindings.forEach((b, slot) => { if (b?.bound?.kind === 'uniform') this.writeEntry(layer, slot, b.bound); });
  }

  private imageGeometry(): ImageGeometry {
    const { metadata, config } = this.host;
    const placed = metadata.pyramid?.[0] && (metadata.pyramidIssues?.length ?? 0) === 0 ? metadata.pyramid[0] : undefined;
    return {
      levels: metadata.levels.map(l => ({ dims: [...l.dimensions] as Vec3, exponent: config.levelExponent(l.lod) })),
      spacing: placed?.spacing ?? (metadata.voxelSpacing && [...metadata.voxelSpacing] as Vec3),
      origin: placed?.origin,
      timepointCount: metadata.timepointCount ?? 1,
    };
  }
}
