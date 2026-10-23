/**
 * Label layers streamed slot for slot with the image atlas: sparse pool, ancestors while bricks
 * load, eviction and waiting when the pool is full, colours, picking and the label check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LabelManager } from '../src/labels/label-manager.js';
import { ENTRY_MIXED, ENTRY_UNIFORM, LABEL_SLOT_BYTES, LabelGpu, PICK_BYTES } from '../src/labels/label-gpu.js';
import { AtlasAllocator } from '../src/streaming/atlas-allocator.js';
import { DatasetConfig } from '../src/core/config.js';
import { resolveColor } from '../src/labels/label-colors.js';
import type { LabelBrickData } from '../src/data/label-assembly.js';
import type { LabelImageInfo, LabelLevelParams } from '../src/data/label-image.js';

/** Contents of label bricks by `${lod}/${bx}/${by}/${bz}` (default: empty); loads wait for release(). */
let bricks: Map<string, LabelBrickData>;
let pending: Array<{ key: string; resolve: () => void; signal?: AbortSignal }>;
let opened: { timepointCount: number };

vi.mock('../src/data/label-reader.js', () => ({
  LabelWorkerPool: class {},
  openLabelImage: async () => ({
    info: { name: 'cells', dtype: 'uint32', colors: [], properties: new Map(), timepointCount: opened.timepointCount } as unknown as LabelImageInfo,
    levels: [{ lod: 0 }, { lod: 1 }] as unknown as LabelLevelParams[],
    notes: [],
    reader: {
      bytesFetched: 0,
      dispose: vi.fn(),
      load: (level: { lod: number }, bx: number, by: number, bz: number, _t: number, signal?: AbortSignal) => new Promise<LabelBrickData>((resolve) => {
        const key = `${level.lod}/${bx}/${by}/${bz}`;
        pending.push({ key, resolve: () => resolve(bricks.get(key) ?? empty()), signal });
      }),
    },
  }),
}));

const empty = (): LabelBrickData => ({ kind: 'empty', palette: Float64Array.of(0), planes: [] });
const uniform = (id: number): LabelBrickData => ({ kind: 'uniform', palette: Float64Array.of(0, id), planes: [] });
const mixed = (...ids: number[]): LabelBrickData => ({
  kind: 'mixed', palette: Float64Array.of(0, ...ids), planes: [new Uint8Array(66 ** 3).fill(1)],
});

function device(maxTextureDimension3D = 2048) {
  return {
    limits: { maxTextureDimension3D },
    createTexture: vi.fn((d: GPUTextureDescriptor) => ({ size: d.size, destroy: vi.fn(), createView: () => ({}) })),
    createBuffer: vi.fn((d: GPUBufferDescriptor) => ({ size: d.size, destroy: vi.fn() })),
    createCommandEncoder: () => ({ copyTextureToTexture: vi.fn(), finish: () => ({}) }),
    queue: { writeTexture: vi.fn(), writeBuffer: vi.fn(), submit: vi.fn() },
  } as unknown as GPUDevice;
}

/** A 2-level image (128³ → 64³), an atlas of 2³ slots, and labels over it. */
function setup({ budget = 64 * LABEL_SLOT_BYTES, timepoints = 1 } = {}) {
  opened = { timepointCount: timepoints };
  const config = new DatasetConfig([128, 128, 128]);
  const metadata = {
    dimensions: [128, 128, 128], timepoint: 0, timepointCount: timepoints,
    levels: [{ lod: 0, dimensions: [128, 128, 128] }, { lod: 1, dimensions: [64, 64, 64] }],
  };
  const allocator = new AtlasAllocator(2);
  const streaming = { setLabelCheck: vi.fn() };
  const redraw = vi.fn();
  const gpu = new LabelGpu(device(), budget);
  const labels = new LabelManager(gpu, {
    provider: { labelLocation: () => ({ kind: 'url', url: 'https://x/labels/cells' }) } as never,
    metadata: metadata as never,
    config,
    resources: () => ({ allocator, gridSize: 2 }) as never,
    streaming: () => streaming as never,
    redraw,
  });
  labels.attach({ allocator, gridSize: 2 } as never);
  const entry = (slot: number, row = 0) => Array.from((gpu as unknown as { entryData: Uint32Array }).entryData.slice((row * 8 + slot) * 4, (row * 8 + slot) * 4 + 4));
  /** Put image brick (lod, b) into atlas slot `slot`, as the streaming manager does. */
  const place = (slot: number, lod: number, bx = 0, by = 0, bz = 0) => {
    (allocator as unknown as { used: Set<number> }).used.add(slot); // as allocate() would
    allocator.setMetadata(slot, { lod, bx, by, bz, key: `lod${lod}:${bz}/${by}/${bx}` });
  };
  /** Start queued loads (as a frame does) and finish them. */
  const settle = async () => {
    labels.update();
    while (pending.length > 0) {
      for (const p of pending.splice(0)) if (!p.signal?.aborted) p.resolve();
      await new Promise(r => setTimeout(r, 0));
      labels.update();
    }
  };
  return { labels, gpu, allocator, streaming, redraw, entry, place, settle };
}

beforeEach(() => {
  bricks = new Map();
  pending = [];
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2, COPY_SRC: 1 });
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, UNIFORM: 64 });
});

describe('label bricks in the atlas', () => {
  it('needs no pool memory for background-only and single-ID bricks', async () => {
    const t = setup();
    const layer = await t.labels.add('cells');
    bricks.set('1/0/0/0', uniform(7));
    t.place(0, 1);
    await t.settle();
    expect(t.entry(0)).toEqual([ENTRY_UNIFORM, resolveColor(7, layer.segmentStyle()), 0, 0]);
    t.place(1, 0, 1, 0, 0); // background only
    await t.settle();
    expect(t.entry(1)).toEqual([0, 0, 0, 0]);
    expect(t.gpu.poolBytes).toBe(0);
  });

  it('puts mixed bricks into the pool, shared by slots that show them', async () => {
    const t = setup();
    await t.labels.add('cells');
    bricks.set('1/0/0/0', mixed(5, 4_000_000_000));
    t.place(0, 1);
    await t.settle();
    const [x, paletteOffset, slots] = t.entry(0);
    expect(x! & 3).toBe(ENTRY_MIXED);
    expect((x! >> 2) & 3).toBe(1);   // one byte plane
    expect((x! >> 4) & 15).toBe(1);  // level 1
    expect(slots).toBe(0);
    expect(t.gpu.poolBytes).toBeGreaterThan(0);
    expect(t.labels.stats.bricksInUse).toBe(1);
    // Picking finds the exact ID through the CPU copy of the palette
    const record = new ArrayBuffer(PICK_BYTES);
    new Float32Array(record, 0, 4).set([1, 2, 3, 1]);
    new Uint32Array(record, 16, 4).set([1, 2, 99, ENTRY_MIXED]);
    const pick = t.labels.resolvePick(record);
    expect(pick.voxel).toEqual([1, 2, 3]);
    expect(pick.hits.map(h => h.id)).toEqual([4_000_000_000]);
    expect(paletteOffset).toBeGreaterThanOrEqual(0);
  });

  it('shows the ancestor while a finer brick loads, then the brick itself', async () => {
    const t = setup();
    await t.labels.add('cells');
    bricks.set('1/0/0/0', mixed(3));
    t.place(0, 1);
    await t.settle();
    bricks.set('0/1/1/1', mixed(3, 9));
    t.place(1, 0, 1, 1, 1);
    expect((t.entry(1)[0]! >> 4) & 15).toBe(1); // the level-1 ancestor stands in
    await t.settle();
    expect((t.entry(1)[0]! >> 4) & 15).toBe(0);
    expect(t.labels.stats.bricksInUse).toBe(2);
  });

  it('keeps unused bricks for later and evicts them when space runs out', async () => {
    const t = setup({ budget: 16 * LABEL_SLOT_BYTES }); // a 4 × 4 × 1 pool
    await t.labels.add('cells');
    for (let i = 0; i < 16; i++) bricks.set(`0/${i}/0/0`, mixed(i + 1));
    t.place(0, 0, 0);
    await t.settle();
    t.allocator.free(t.allocator.indexToSlot(0));
    expect(t.labels.stats).toMatchObject({ bricksInUse: 0, bricksCached: 1 });
    for (let i = 1; i < 17; i++) {
      bricks.set(`0/${i}/0/0`, mixed(i + 1));
      t.place(i % 8, 0, i);
      await t.settle();
    }
    expect(t.gpu.poolBytes).toBe(16 * LABEL_SLOT_BYTES);
    expect(t.labels.stats.bricksInUse).toBe(8);
  });

  it('waits for a free pool slot when every brick is in use', async () => {
    const t = setup({ budget: 16 * LABEL_SLOT_BYTES }); // 16 pool slots
    await t.labels.add('cells');
    // Bricks with more than 65536 IDs take three slots each: five fill 15 of 16
    const huge = (first: number): LabelBrickData => ({
      kind: 'mixed', palette: Float64Array.from({ length: 65_538 }, (_, i) => i === 0 ? 0 : first + i),
      planes: [new Uint8Array(66 ** 3), new Uint8Array(66 ** 3), new Uint8Array(66 ** 3)],
    });
    for (let i = 0; i < 6; i++) bricks.set(`0/${i}/0/0`, huge(i * 100_000));
    for (let i = 0; i < 5; i++) t.place(i, 0, i);
    await t.settle();
    expect(t.labels.stats.bricksInUse).toBe(5);
    t.place(5, 0, 5);
    await t.settle();
    expect(t.entry(5)).toEqual([0, 0, 0, 0]); // waiting: no room, nothing unused
    t.allocator.free(t.allocator.indexToSlot(0));
    await t.settle();
    expect(t.entry(5)[0]! & 3).toBe(ENTRY_MIXED);
    expect(t.labels.stats.bricksInUse).toBe(5);
  });

  it('answers the label check from brick summaries', async () => {
    const t = setup();
    await t.labels.add('cells');
    expect(t.streaming.setLabelCheck).toHaveBeenCalled();
    const check = t.streaming.setLabelCheck.mock.calls.at(-1)![0] as (lod: number, bx: number, by: number, bz: number) => Promise<boolean>;
    bricks.set('0/1/0/0', uniform(2));
    const labelled = check(0, 1, 0, 0);
    await t.settle();
    expect(await labelled).toBe(true);
    const unlabelled = check(0, 0, 1, 0);
    await t.settle();
    expect(await unlabelled).toBe(false);
    expect(await check(0, 1, 0, 0)).toBe(true); // cached: no load
    expect(pending).toHaveLength(0);
  });
});

describe('label styles', () => {
  it('recolours palettes and single-ID entries when segments are hidden or selected', async () => {
    const t = setup();
    const layer = await t.labels.add('cells');
    bricks.set('1/0/0/0', uniform(7));
    t.place(0, 1);
    await t.settle();
    layer.setHidden(7, true);
    t.labels.update();
    expect(t.entry(0)[1]).toBe(0);
    layer.showAll();
    layer.select(7);
    t.labels.update();
    expect(t.entry(0)[1]! >>> 24).toBe(255);
    expect(t.redraw).toHaveBeenCalled();
  });

  it('frees the pool and stops the label check when no layer is shown', async () => {
    const t = setup();
    const layer = await t.labels.add('cells');
    bricks.set('1/0/0/0', mixed(1));
    t.place(0, 1);
    await t.settle();
    layer.visible = false;
    expect(t.gpu.poolBytes).toBe(0);
    expect(t.entry(0)).toEqual([0, 0, 0, 0]);
    expect(t.streaming.setLabelCheck).toHaveBeenLastCalledWith(null);
    layer.visible = true;
    await t.settle();
    expect(t.entry(0)[0]! & 3).toBe(ENTRY_MIXED);
  });

  it('loads the matching timepoint of time-varying labels', async () => {
    const t = setup({ timepoints: 3 });
    await t.labels.add('cells');
    bricks.set('1/0/0/0', uniform(1));
    t.place(0, 1);
    await t.settle();
    const color1 = t.entry(0)[1];
    bricks.set('1/0/0/0', uniform(2));
    t.labels.setTimepoint(2);
    await t.settle();
    expect(t.entry(0)[1]).not.toBe(color1);
  });

  it('shows at most eight layers at once', async () => {
    const t = setup();
    const added = [];
    for (let i = 0; i < 9; i++) added.push(await t.labels.add(`layer${i}`));
    expect(added.filter(l => l.visible)).toHaveLength(8);
    expect(() => { added[8]!.visible = true; }).toThrow(/At most 8/);
    expect(added[8]!.visible).toBe(false);
    t.labels.remove(added[0]!);
    added[8]!.visible = true;
    expect(t.labels.shown).toHaveLength(8);
  });
});
