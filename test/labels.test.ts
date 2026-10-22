/**
 * Label images: IDs folded into the 16-bit label atlas, OME-Zarr label metadata, the colour
 * table, matching label levels to image levels, the layer that streams label bricks slot for
 * slot with the image, and the engine switching label images.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildLabelColorTable, labelId, matchLabelLevels, parseLabelColors, parseLabelNames } from '../src/data/labels.js';
import { UnsupportedDatasetError } from '../src/data/data-provider.js';
import type { BrickLoadResult, DataProvider, VolumeMetadata } from '../src/data/data-provider.js';
import { AtlasAllocator } from '../src/streaming/atlas-allocator.js';
import { LabelLayer } from '../src/streaming/label-layer.js';
import { KilnEngine } from '../src/engine.js';
import { LocalZarrDataProvider } from '../src/data/local-zarr-provider.js';

describe('label IDs', () => {
  it('keep 16-bit IDs, wrap larger ones into 1–65535 and treat the rest as background', () => {
    expect([0, 5, 65535].map(labelId)).toEqual([0, 5, 65535]);
    expect(labelId(65536)).toBe(1);
    expect(labelId(70000)).toBe(4465);
    expect(labelId(70000n)).toBe(4465);
    expect(labelId(12n)).toBe(12);
    expect([-3, NaN, -1n].map(labelId)).toEqual([0, 0, 0]);
  });
});

describe('label metadata', () => {
  it('reads label names from v0.4 and v0.5 labels groups', () => {
    expect(parseLabelNames({ labels: ['cells', 'nuclei'] })).toEqual(['cells', 'nuclei']);
    expect(parseLabelNames({ ome: { version: '0.5', labels: ['cells', 3] } })).toEqual(['cells']);
    expect(parseLabelNames({})).toEqual([]);
  });

  it('reads image-label colours, skipping malformed entries', () => {
    const attrs = { 'image-label': { colors: [{ 'label-value': 2, rgba: [255, 0, 300, 255] }, { rgba: [1, 2, 3, 4] }] } };
    expect(parseLabelColors(attrs)).toEqual([{ value: 2, rgba: [255, 0, 255, 255] }]);
    expect(parseLabelColors({ ome: attrs })).toEqual(parseLabelColors(attrs));
  });

  it('colours every ID, background transparent, metadata colours first', () => {
    const table = buildLabelColorTable([{ value: 1, rgba: [10, 20, 30, 40] }]);
    const color = (id: number) => [...table.slice(id * 4, id * 4 + 4)];
    expect(color(0)).toEqual([0, 0, 0, 0]);
    expect(color(1)).toEqual([10, 20, 30, 40]);
    expect(color(2)[3]).toBe(255);
    expect(color(2)).not.toEqual(color(3));
  });
});

const level = (lod: number, n: number) => ({ lod, dimensions: [n, n, n] as [number, number, number], brickGrid: [1, 1, 1] as [number, number, number], brickCount: 1 });
const meta = (sizes: number[]): VolumeMetadata => ({
  name: 'v', dimensions: [sizes[0]!, sizes[0]!, sizes[0]!], brickSize: 64, physicalBrickSize: 66,
  maxLod: sizes.length - 1, bitDepth: 16, numChannels: 1, levels: sizes.map((n, lod) => level(lod, n)),
});
/** `meta` with a multiscale pyramid: level spacing doubles, origins as given per level. */
const placed = (sizes: number[], spacing: number, origins: number[] = sizes.map(() => 0)): VolumeMetadata => ({
  ...meta(sizes),
  pyramid: sizes.map((n, lod) => ({
    lod, dims: [n, n, n], exponent: [lod, lod, lod],
    spacing: [spacing * 2 ** lod, spacing * 2 ** lod, spacing * 2 ** lod], origin: [origins[lod]!, origins[lod]!, origins[lod]!],
  })),
});
const timed = (m: VolumeMetadata, timepointCount: number, timepoint = 0): VolumeMetadata => ({ ...m, timepointCount, timepoint });

describe('label levels', () => {
  it('cover the image levels with the same dimensions', () => {
    expect(matchLabelLevels(meta([128, 64]), meta([128, 64]))).toEqual([true, true]);
    expect(matchLabelLevels(meta([128, 64, 32]), meta([128, 64]))).toEqual([true, true, false]);
  });

  it('reject labels of another size', () => {
    expect(() => matchLabelLevels(meta([128, 64]), meta([100, 50]))).toThrow(UnsupportedDatasetError);
  });

  it('need the same voxel spacing and origin where both images have transforms', () => {
    expect(matchLabelLevels(placed([128, 64], 21.6), placed([128, 64], 21.600001))).toEqual([true, true]);
    expect(() => matchLabelLevels(placed([128, 64], 21.6), placed([128, 64], 10.8))).toThrow(/placed differently/);
    expect(() => matchLabelLevels(placed([128, 64], 1), placed([128, 64], 1, [5, 5]))).toThrow(/placed differently/);
    // a coarser level placed differently is not covered
    expect(matchLabelLevels(placed([128, 64], 1, [0, 0.5]), placed([128, 64], 1))).toEqual([true, false]);
    // without transforms on one side, dimensions decide
    expect(matchLabelLevels(placed([128, 64], 21.6), meta([128, 64]))).toEqual([true, true]);
  });

  it('need the image’s timepoints when they vary over time', () => {
    expect(matchLabelLevels(timed(meta([128]), 5), timed(meta([128]), 5))).toEqual([true]);
    expect(matchLabelLevels(timed(meta([128]), 5), meta([128]))).toEqual([true]); // static labels
    expect(() => matchLabelLevels(timed(meta([128]), 5), timed(meta([128]), 3))).toThrow(/3 timepoints, the image 5/);
  });
});

function deferred() {
  let resolve!: (r: BrickLoadResult | null) => void;
  const promise = new Promise<BrickLoadResult | null>(r => { resolve = r; });
  return { promise, resolve };
}

function setup(levels = [true, true]) {
  const allocator = new AtlasAllocator(2);
  const resources: any = {
    allocator,
    indirection: { onBrickMapped: undefined },
    writeLabelBrick: vi.fn(),
    setLabelSlotReady: vi.fn(),
  };
  const loads: Array<{ args: unknown[]; signal: AbortSignal; done: ReturnType<typeof deferred> }> = [];
  const provider = {
    loadBrick: vi.fn((...args: unknown[]) => {
      const done = deferred();
      loads.push({ args: args.slice(0, 4), signal: args[5] as AbortSignal, done });
      return done.promise;
    }),
  } as unknown as DataProvider;
  const onCommit = vi.fn();
  const map = (lod: number, bx: number, slot: number) => {
    const { x, y, z } = allocator.indexToSlot(slot);
    resources.indirection.onBrickMapped(lod, bx, 0, 0, x, y, z);
  };
  const brick = (): BrickLoadResult => ({ data: new Uint16Array(66 ** 3), min: 0, max: 0, avg: 0 });
  const flush = () => new Promise(r => setTimeout(r, 0));
  return { allocator, resources, provider, loads, onCommit, map, brick, flush, levels };
}

describe('label layer', () => {
  it('loads the labels of each brick mapped to a slot and shows them once they land', async () => {
    const t = setup();
    new LabelLayer(t.resources, t.provider, t.levels, t.onCommit);
    t.map(1, 0, 1);
    expect(t.loads.map(l => l.args)).toEqual([[1, 0, 0, 0]]);
    t.loads[0]!.done.resolve(t.brick());
    await t.flush();
    expect(t.resources.writeLabelBrick).toHaveBeenCalledWith({ x: 1, y: 0, z: 0 }, expect.any(Uint16Array));
    expect(t.resources.setLabelSlotReady).toHaveBeenCalledWith(1, true);
    expect(t.onCommit).toHaveBeenCalledOnce();
  });

  it('drops labels that arrive after their slot took another brick', async () => {
    const t = setup();
    new LabelLayer(t.resources, t.provider, t.levels, t.onCommit);
    t.map(0, 0, 0);
    t.map(0, 1, 0);
    expect(t.loads[0]!.signal.aborted).toBe(true);
    t.loads[0]!.done.resolve(t.brick());
    await t.flush();
    expect(t.resources.writeLabelBrick).not.toHaveBeenCalled();
    t.loads[1]!.done.resolve(t.brick());
    await t.flush();
    expect(t.resources.writeLabelBrick).toHaveBeenCalledOnce();
  });

  it('hides a slot’s labels as soon as it takes another brick', async () => {
    const t = setup();
    new LabelLayer(t.resources, t.provider, t.levels, t.onCommit);
    t.map(0, 0, 0);
    t.loads[0]!.done.resolve(t.brick());
    await t.flush();
    t.map(0, 1, 0);
    expect(t.resources.setLabelSlotReady).toHaveBeenLastCalledWith(0, false);
  });

  it('starts with the bricks already in the atlas, coarsest first', () => {
    const t = setup();
    for (const [lod, bx] of [[0, 3], [1, 1]] as const) {
      const { slotIndex } = t.allocator.allocate()!;
      t.allocator.setMetadata(slotIndex, { lod, bx, by: 0, bz: 0, key: '' });
    }
    new LabelLayer(t.resources, t.provider, t.levels, t.onCommit);
    expect(t.loads.map(l => l.args)).toEqual([[1, 1, 0, 0], [0, 3, 0, 0]]);
  });

  it('skips levels the labels do not cover', () => {
    const t = setup([true, false]);
    new LabelLayer(t.resources, t.provider, t.levels, t.onCommit);
    t.map(1, 0, 0);
    expect(t.provider.loadBrick).not.toHaveBeenCalled();
  });

  it('reloads every slot, e.g. for another timepoint', async () => {
    const t = setup();
    const layer = new LabelLayer(t.resources, t.provider, t.levels, t.onCommit);
    const { slotIndex } = t.allocator.allocate()!;
    t.allocator.setMetadata(slotIndex, { lod: 0, bx: 0, by: 0, bz: 0, key: '' });
    t.map(0, 0, slotIndex);
    t.loads[0]!.done.resolve(t.brick());
    await t.flush();
    layer.reload();
    expect(t.resources.setLabelSlotReady).toHaveBeenLastCalledWith(slotIndex, false);
    expect(t.loads).toHaveLength(2);
  });

  it('stops following the atlas when disposed', () => {
    const t = setup();
    new LabelLayer(t.resources, t.provider, t.levels, t.onCommit).dispose();
    expect(t.resources.indirection.onBrickMapped).toBeUndefined();
  });

  it('tells whether a brick has labels, reading each brick once', async () => {
    const t = setup([true, false]);
    (t.provider as any).getMetadata = () => ({ timepoint: 0 });
    const layer = new LabelLayer(t.resources, t.provider, t.levels, t.onCommit);
    expect(await layer.hasLabels(1, 0, 0, 0)).toBe(false); // level not covered: not read
    expect(t.loads).toHaveLength(0);

    const first = layer.hasLabels(0, 0, 0, 0);
    const again = layer.hasLabels(0, 0, 0, 0);
    t.loads[0]!.done.resolve({ ...t.brick(), max: 7 });
    expect([await first, await again]).toEqual([true, true]);
    expect(t.loads).toHaveLength(1);

    const empty = layer.hasLabels(0, 1, 0, 0);
    t.loads[1]!.done.resolve(t.brick());
    expect(await empty).toBe(false);

    (t.provider.loadBrick as any).mockRejectedValueOnce(new Error('offline'));
    expect(await layer.hasLabels(0, 2, 0, 0)).toBe(true); // unknown counts as labelled
  });
});

describe('engine label images', () => {
  function engine(labels: VolumeMetadata | Promise<VolumeMetadata>) {
    const e: any = Object.create(KilnEngine.prototype);
    const labelProvider = { initialize: vi.fn(() => Promise.resolve(labels)), getMetadata: () => labels, dispose: vi.fn() };
    Object.assign(e, {
      disposed: false, labelSource: null, labelRequest: 0, labelProvider: null, labelLayer: null, labelColorTable: null, labelLevels: [],
      metadata: meta([128, 64]),
      gpu: { textureFormat: 'r16float', labels: false },
      dataProvider: { openLabels: vi.fn(() => labelProvider) },
      _resources: {
        gridSize: 10,
        hasLabels: false,
        enableLabels: vi.fn(function (this: any) { this.hasLabels = true; }),
        disableLabels: vi.fn(function (this: any) { this.hasLabels = false; }),
        writeLabelColors: vi.fn(),
        allocator: new AtlasAllocator(2), indirection: {},
      },
      _streamingManager: { notifyContentChanged: vi.fn(), setLabelCheck: vi.fn() },
      views: [{ renderer: { rebind: vi.fn() } }],
      rebuildGpu: vi.fn(function (this: any) { this.attachLabels(); }),
    });
    return { e, labelProvider };
  }

  it('shows a label image and hides it again', async () => {
    const { e } = engine(meta([128, 64]));
    await e.setLabels('cells');
    expect(e.labels).toBe('cells');
    expect(e._resources.hasLabels).toBe(true);
    expect(e.views[0].renderer.rebind).toHaveBeenCalled();
    expect(e._streamingManager.setLabelCheck).toHaveBeenLastCalledWith(expect.any(Function));
    await e.setLabels(null);
    expect(e.labels).toBeNull();
    expect(e._resources.hasLabels).toBe(false);
    expect(e._streamingManager.setLabelCheck).toHaveBeenLastCalledWith(null);
  });

  it('keeps only the latest request when a label image is chosen again while opening', async () => {
    const { e } = engine(meta([128, 64]));
    const opening: Array<{ open: (m: VolumeMetadata) => void; dispose: ReturnType<typeof vi.fn> }> = [];
    e.dataProvider.openLabels = vi.fn(() => {
      const provider = {
        initialize: () => new Promise<VolumeMetadata>(open => { provider.open = open; }),
        getMetadata: () => meta([128, 64]), dispose: vi.fn(), open: (_: VolumeMetadata) => {},
      };
      opening.push(provider as any);
      return provider;
    });
    const a = e.setLabels('a');
    const b = e.setLabels('b');
    const latest = e.setLabels('a');
    opening[0]!.open(meta([128, 64])); // the first "a" arrives after the second was requested
    await a;
    expect(e._resources.enableLabels).not.toHaveBeenCalled();
    opening[2]!.open(meta([128, 64]));
    opening[1]!.open(meta([128, 64]));
    await Promise.all([b, latest]);
    expect(e.labels).toBe('a');
    expect(e.labelProvider).toBe(opening[2]);
    expect(e._resources.enableLabels).toHaveBeenCalledOnce();
    expect(opening[0]!.dispose).toHaveBeenCalled();
    expect(opening[1]!.dispose).toHaveBeenCalled();
    expect(opening[2]!.dispose).not.toHaveBeenCalled();
  });

  it('makes room for the label atlas in the atlas budget', async () => {
    const one = engine(meta([128, 64])).e;
    await one.setLabels('cells');
    expect(one.gpu.labels).toBe(true);
    expect(one.rebuildGpu).not.toHaveBeenCalled(); // one 16-bit channel and labels fit the full atlas

    const two = engine(meta([128, 64])).e;
    two.metadata = { ...meta([128, 64]), numChannels: 2 };
    await two.setLabels('cells');
    expect(two.rebuildGpu).toHaveBeenCalledOnce(); // two channels and labels need a smaller atlas
    expect(two._resources.hasLabels).toBe(true);
  });

  it('rejects labels when the coarsest level would no longer fit the atlas', async () => {
    const { e, labelProvider } = engine(meta([128, 64]));
    const base = { ...level(1, 64), brickGrid: [7, 7, 6] as [number, number, number] }; // 294 pinned bricks
    e.metadata = { ...meta([128, 64]), levels: [level(0, 128), base] };
    e.gpu.atlasBudgetBytes = 2e8; // 7³ slots without labels, 6³ with them
    await expect(e.setLabels('cells')).rejects.toThrow(/with labels/);
    expect(e.labels).toBeNull();
    expect(e.gpu.labels).toBe(false);
    expect(e._resources.hasLabels).toBe(false);
    expect(labelProvider.dispose).toHaveBeenCalled();
  });

  it('shows static labels at every timepoint and moves time-varying ones along', () => {
    const { e } = engine(meta([128]));
    e.metadata = timed(meta([128]), 5, 3);
    const setSourceSelection = vi.fn();
    e.labelProvider = { getMetadata: () => meta([128]), setSourceSelection };
    expect(e.selectLabelTimepoint()).toBe(false);
    e.labelProvider = { getMetadata: () => timed(meta([128]), 5, 0), setSourceSelection };
    expect(e.selectLabelTimepoint()).toBe(true);
    expect(setSourceSelection).toHaveBeenCalledWith({ timepoint: 3 });
  });

  it('shows nothing for labels of another size', async () => {
    const { e, labelProvider } = engine(meta([100, 50]));
    await expect(e.setLabels('cells')).rejects.toThrow(UnsupportedDatasetError);
    expect(e.labels).toBeNull();
    expect(e._resources.hasLabels).toBe(false);
    expect(labelProvider.dispose).toHaveBeenCalled();
  });

  it('drops a label image replaced while it was opening', async () => {
    let open!: (m: VolumeMetadata) => void;
    const { e, labelProvider } = engine(new Promise<VolumeMetadata>(r => { open = r; }));
    const first = e.setLabels('cells');
    await e.setLabels(null);
    open(meta([128, 64]));
    await first;
    expect(e._resources.hasLabels).toBe(false);
    expect(labelProvider.dispose).toHaveBeenCalled();
  });
});

/** A File System Access directory handle over a real directory. */
function dirHandle(path: string): FileSystemDirectoryHandle {
  return {
    name: basename(path),
    getDirectoryHandle: async (name: string) => {
      if (!statSync(join(path, name)).isDirectory()) throw new Error('not a directory');
      return dirHandle(join(path, name));
    },
    getFileHandle: async (name: string) => {
      const bytes = readFileSync(join(path, name));
      return { getFile: async () => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }) };
    },
  } as unknown as FileSystemDirectoryHandle;
}

/** 8³ uint8 OME-Zarr v0.4 image whose labels group holds one int64 label image, "cells". */
function writeLocalDataset(): string {
  const root = mkdtempSync(join(tmpdir(), 'kiln-labels-'));
  const json = (path: string, value: unknown) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  const multiscales = [{ version: '0.4', axes: ['z', 'y', 'x'].map(name => ({ name, type: 'space' })), datasets: [{ path: '0' }] }];
  const array = (path: string, dtype: string, data: ArrayBufferView) => {
    json(`${path}/.zarray`, { zarr_format: 2, shape: [8, 8, 8], chunks: [8, 8, 8], dtype, compressor: null, fill_value: 0, order: 'C', filters: null });
    writeFileSync(join(root, path, '0.0.0'), new Uint8Array(data.buffer));
  };
  json('.zgroup', { zarr_format: 2 });
  json('.zattrs', { multiscales });
  array('0', '|u1', new Uint8Array(512).fill(9));
  json('labels/.zgroup', { zarr_format: 2 });
  json('labels/.zattrs', { labels: ['cells'] });
  json('labels/cells/.zgroup', { zarr_format: 2 });
  json('labels/cells/.zattrs', { multiscales, 'image-label': { colors: [{ 'label-value': 3, rgba: [1, 2, 3, 4] }] } });
  const ids = new BigInt64Array(512);
  ids[0] = 3n; // x = y = z = 0
  ids[7] = 70000n; // x = 7
  array('labels/cells/0', '<i8', ids);
  return root;
}

describe('local label images', () => {
  it('are listed, opened and assembled as 16-bit label IDs', async () => {
    const image = new LocalZarrDataProvider(dirHandle(writeLocalDataset()));
    await image.initialize();
    expect(await image.listLabels()).toEqual(['cells']);

    const labels = image.openLabels('cells');
    const meta = await labels.initialize();
    expect(meta.labelColors).toEqual([{ value: 3, rgba: [1, 2, 3, 4] }]);
    const brick = await labels.loadBrick(0, 0, 0, 0);
    const at = (x: number) => brick!.data[(x + 1) + 66 * (1 + 66 * 1)]; // one-voxel border
    expect(brick!.data).toBeInstanceOf(Uint16Array);
    expect([at(0), at(1), at(7)]).toEqual([3, 0, 4465]);
  });
});
