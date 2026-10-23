/**
 * Label images: metadata, alignment to the image's levels, and brick assembly into palettes.
 */
import { describe, expect, it } from 'vitest';
import {
  alignLabelLevels, parseLabelColors, parseLabelNames, parseLabelProperties, readLabelImage, segmentName, toLabelId,
} from '../src/data/label-image.js';
import type { ImageGeometry, LabelImageInfo } from '../src/data/label-image.js';
import { assembleLabelBrick, labelAxisMap, palettize } from '../src/data/label-assembly.js';
import type { DecodedChunk } from '../src/data/label-assembly.js';
import type { Vec3 } from '../src/core/pyramid.js';

const N = 66 ** 3;

/** Image geometry with 2:1 levels from `dims`. */
function image(dims: Vec3, levels: number, opts: Partial<ImageGeometry> = {}): ImageGeometry {
  return {
    levels: Array.from({ length: levels }, (_, l) => ({
      dims: dims.map(d => Math.ceil(d / 2 ** l)) as Vec3, exponent: [l, l, l] as Vec3,
    })),
    timepointCount: 1,
    ...opts,
  };
}

/** Label image with arrays of the given dims (z, y, x order inside, like OME-Zarr). */
function labels(arrays: Array<{ dims: Vec3; spacing?: Vec3; origin?: Vec3 }>, opts: Partial<LabelImageInfo> = {}): LabelImageInfo {
  return {
    name: 'cells', dtype: 'uint32', rank: 3, spatialOrder: [2, 1, 0], channelAxisIdx: -1, timeAxisIdx: -1,
    timepointCount: 1, colors: [], properties: new Map(),
    arrays: arrays.map((a, i) => ({
      path: String(i), dims: a.dims, chunkShape: [64, 64, 64], chunks: [64, 64, 64], spacing: a.spacing, origin: a.origin,
      metadata: { chunk_grid: { configuration: { chunk_shape: [64, 64, 64] } } } as never,
    })),
    ...opts,
  };
}

describe('label metadata', () => {
  it('reads names, colours and properties from v0.4 and v0.5 attributes', () => {
    expect(parseLabelNames({ labels: ['cells', 7, ''] })).toEqual(['cells']);
    expect(parseLabelNames({ ome: { labels: ['a', 'b'] } })).toEqual(['a', 'b']);
    const attrs = { ome: { 'image-label': {
      colors: [{ 'label-value': 1, rgba: [255, 0, 0, 255] }, { 'label-value': 2, rgba: [0, 300, -5, 128] }, { 'label-value': 0, rgba: [1, 1, 1, 1] }],
      properties: [{ 'label-value': 1, class: 'nucleus', area: 3 }, { 'label-value': 'x' }],
    } } };
    expect(parseLabelColors(attrs)).toEqual([
      { value: 1, rgba: [255, 0, 0, 255] }, { value: 2, rgba: [0, 255, 0, 128] },
    ]);
    const props = parseLabelProperties(attrs);
    expect([...props.keys()]).toEqual([1]);
    expect(segmentName(props.get(1))).toBe('nucleus');
  });

  it('maps stored values to label IDs', () => {
    expect(toLabelId(0)).toBe(0);
    expect(toLabelId(-3)).toBe(0);
    expect(toLabelId(NaN)).toBe(0);
    expect(toLabelId(2.6)).toBe(3);
    expect(toLabelId(4_000_000_000)).toBe(4_000_000_000);
    expect(toLabelId(12345678901234n)).toBe(12345678901234);
    expect(toLabelId(true)).toBe(1);
  });

  it('reads a label image from a store', async () => {
    const files: Record<string, unknown> = {
      '/.zattrs': { multiscales: [{ version: '0.4', axes: ['z', 'y', 'x'], datasets: [
        { path: '0', coordinateTransformations: [{ type: 'scale', scale: [2, 1, 1] }] },
        { path: '1', coordinateTransformations: [{ type: 'scale', scale: [4, 2, 2] }] },
      ] }], 'image-label': { colors: [{ 'label-value': 3, rgba: [1, 2, 3, 4] }] } },
      '/0/.zarray': { shape: [10, 20, 30], chunks: [5, 10, 15], dtype: '<u2', compressor: null, fill_value: 0, zarr_format: 2 },
      '/1/.zarray': { shape: [5, 10, 15], chunks: [5, 10, 15], dtype: '<u2', compressor: null, fill_value: 0, zarr_format: 2 },
    };
    const store = { get: async (key: string) => key in files ? new TextEncoder().encode(JSON.stringify(files[key])) : undefined };
    const info = await readLabelImage(store as never, 'cells');
    expect(info.arrays.map(a => a.dims)).toEqual([[30, 20, 10], [15, 10, 5]]);
    expect(info.arrays[0]!.chunks).toEqual([15, 10, 5]);
    expect(info.arrays[1]!.spacing).toEqual([2, 2, 4]);
    expect(info.dtype).toBe('uint16');
    expect(info.colors).toEqual([{ value: 3, rgba: [1, 2, 3, 4] }]);
  });

  it('rejects label images with float data or no multiscales', async () => {
    const store = (files: Record<string, unknown>) => ({ get: async (k: string) => k in files ? new TextEncoder().encode(JSON.stringify(files[k])) : undefined });
    await expect(readLabelImage(store({}) as never, 'x')).rejects.toThrow(/multiscales/);
    await expect(readLabelImage(store({
      '/.zattrs': { multiscales: [{ datasets: [{ path: '0' }] }] },
      '/0/.zarray': { shape: [4, 4, 4], chunks: [4, 4, 4], dtype: '<c8', compressor: null, fill_value: 0 },
    }) as never, 'x')).rejects.toThrow();
  });
});

describe('aligning labels to the image levels', () => {
  it('reads each level from the matching label level', () => {
    const { levels, notes } = alignLabelLevels(image([256, 256, 128], 3), labels([
      { dims: [256, 256, 128] }, { dims: [128, 128, 64] }, { dims: [64, 64, 32] },
    ]));
    expect(levels.map(l => l?.array)).toEqual([0, 1, 2]);
    expect(levels.map(l => l?.scale)).toEqual([[1, 1, 1], [1, 1, 1], [1, 1, 1]]);
    expect(notes).toEqual([]);
  });

  it('downsamples a single-scale label image for coarse levels, up to a limit', () => {
    const { levels, notes } = alignLabelLevels(image([2048, 2048, 2048], 6), labels([{ dims: [2048, 2048, 2048] }]));
    expect(levels.map(l => l?.scale[0] ?? null)).toEqual([1, 2, 4, 8, null, null]);
    expect(notes[0]).toMatch(/2 coarsest levels/);
  });

  it('upsamples labels coarser than the finest level', () => {
    const { levels } = alignLabelLevels(image([200, 200, 100], 3), labels([{ dims: [100, 100, 50] }, { dims: [50, 50, 25] }]));
    expect(levels.map(l => l?.array)).toEqual([0, 0, 1]);
    expect(levels[0]!.scale).toEqual([0.5, 0.5, 0.5]);
    expect(levels[1]!.scale).toEqual([1, 1, 1]);
  });

  it('follows per-axis downsampling of anisotropic pyramids', () => {
    const geometry: ImageGeometry = { levels: [
      { dims: [512, 512, 64], exponent: [0, 0, 0] }, { dims: [256, 256, 64], exponent: [1, 1, 0] },
    ], timepointCount: 1 };
    const { levels } = alignLabelLevels(geometry, labels([{ dims: [512, 512, 64] }, { dims: [256, 256, 32] }]));
    // Level 1 keeps full z, so the half-z label level would be too coarse there
    expect(levels[1]).toMatchObject({ array: 0, scale: [2, 2, 1] });
  });

  it('rejects labels of another image', () => {
    expect(() => alignLabelLevels(image([100, 100, 100], 1), labels([{ dims: [70, 100, 100] }]))).toThrow(/70 × 100 × 100/);
    const placed = { spacing: [1, 1, 1] as Vec3, origin: [0, 0, 0] as Vec3 };
    expect(() => alignLabelLevels(image([100, 100, 100], 1, placed), labels([{ dims: [100, 100, 100], spacing: [2, 1, 1] }])))
      .toThrow(/belong to another image/);
    expect(() => alignLabelLevels(image([100, 100, 100], 1, placed), labels([{ dims: [100, 100, 100], spacing: [1, 1, 1], origin: [5, 0, 0] }])))
      .toThrow(/placed differently/);
    // Half resolution with the box-filter half-voxel shift still matches
    expect(alignLabelLevels(image([100, 100, 100], 1, placed), labels([{ dims: [50, 50, 50], spacing: [2, 2, 2], origin: [0.5, 0.5, 0.5] }])).levels[0]?.scale)
      .toEqual([0.5, 0.5, 0.5]);
  });

  it('needs static labels or the image timepoints', () => {
    expect(() => alignLabelLevels(image([64, 64, 64], 1, { timepointCount: 5 }), labels([{ dims: [64, 64, 64] }], { timepointCount: 3 })))
      .toThrow(/3 timepoints/);
    expect(alignLabelLevels(image([64, 64, 64], 1, { timepointCount: 5 }), labels([{ dims: [64, 64, 64] }], { timepointCount: 1 })).levels).toHaveLength(1);
  });
});

describe('label bricks', () => {
  it('maps brick voxels to label voxels, centred, background outside the image', () => {
    const same = labelAxisMap(1, 1, 100, 100);
    expect(same[0]).toBe(63);    // the border voxel before the brick
    expect(same[1]).toBe(64);
    expect(same[37]).toBe(-1);  // voxel 100 is outside the 100-voxel image
    const half = labelAxisMap(0, 0.5, 100, 50);
    expect([...half.slice(0, 6)]).toEqual([-1, 0, 0, 1, 1, 2]);
    const double = labelAxisMap(0, 2, 128, 256);
    expect([...double.slice(1, 4)]).toEqual([1, 3, 5]);
  });

  it('compresses bricks into empty, uniform and mixed palettes', () => {
    expect(palettize(emit => { for (let i = 0; i < N; i++) emit(0); }).kind).toBe('empty');
    const uniform = palettize(emit => { for (let i = 0; i < N; i++) emit(7); });
    expect(uniform.kind).toBe('uniform');
    expect([...uniform.palette]).toEqual([0, 7]);

    const mixed = palettize(emit => { for (let i = 0; i < N; i++) emit(i < 10 ? 0 : i < 20 ? 9n : 4_000_000_000); });
    expect(mixed.kind).toBe('mixed');
    expect([...mixed.palette]).toEqual([0, 9, 4_000_000_000]);
    expect(mixed.planes).toHaveLength(1);
    expect([mixed.planes[0]![0], mixed.planes[0]![15], mixed.planes[0]![25]]).toEqual([0, 1, 2]);
  });

  it('widens indices for bricks with many IDs', () => {
    const wide = palettize(emit => { for (let i = 0; i < N; i++) emit(i % 300); });
    expect(wide.planes).toHaveLength(2);
    expect(wide.palette.length).toBe(300);
    const index = (i: number) => wide.planes[0]![i]! | (wide.planes[1]![i]! << 8);
    expect(wide.palette[index(299)]).toBe(299);
    expect(index(300)).toBe(0);
    const widest = palettize(emit => { for (let i = 0; i < N; i++) emit(i); });
    expect(widest.planes).toHaveLength(3);
    const at = (i: number) => widest.planes[0]![i]! | (widest.planes[1]![i]! << 8) | (widest.planes[2]![i]! << 16);
    expect(widest.palette[at(N - 1)]).toBe(N - 1);
  });

  it('assembles a brick from chunks, missing chunks as background', async () => {
    // A 128³ label array in 64³ chunks; chunk (1, 0, 0) is missing. Voxel value = x + 1000·z.
    const level = alignLabelLevels(image([128, 128, 128], 1), labels([{ dims: [128, 128, 128] }])).levels[0]!;
    const requested: string[] = [];
    const brick = await assembleLabelBrick(level, 0, 0, 0, 0, async (_array, coords, key) => {
      requested.push(key);
      const [cz, , cx] = coords as [number, number, number];
      if (cx === 1) return null;
      const data = new Uint32Array(64 ** 3);
      for (let z = 0; z < 64; z++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        data[z * 4096 + y * 64 + x] = cx * 64 + x + 1000 * (cz * 64 + z);
      }
      return { data, shape: [64, 64, 64], stride: [4096, 64, 1] } satisfies DecodedChunk;
    });
    expect(requested).toHaveLength(8); // the border reaches into the next chunk on every axis
    expect(requested).toContain('0:t0:1/1/1');
    expect(brick.kind).toBe('mixed');
    const value = (x: number, y: number, z: number) => {
      const i = (z + 1) * 66 * 66 + (y + 1) * 66 + (x + 1);
      const index = brick.planes[0]![i]! | (brick.planes[1]?.[i] ?? 0) << 8 | (brick.planes[2]?.[i] ?? 0) << 16;
      return brick.palette[index];
    };
    expect(value(5, 3, 2)).toBe(5 + 2000);
    expect(value(-1, 0, 0)).toBe(0);  // border outside the image
    expect(value(64, 0, 0)).toBe(0);  // border voxel in the missing chunk
    expect(value(0, 0, 0)).toBe(0);   // ID 0 is background
  });
});
