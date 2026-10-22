/**
 * Float data range: exact float16 quantiles for the derived range, float16 limits, unusable
 * OMERO windows, NaN voxels and brick stats normalised to the provisional range.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { float16Levels, float16Quantiles } from '../src/core/histogram.js';
import { float32ToFloat16Bits, getFloat16ToFloat32Lut } from '../src/utils/float16.js';
import { usableFloatWindow } from '../src/data/base-zarr-provider.js';
import { LocalZarrDataProvider } from '../src/data/local-zarr-provider.js';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import type { BrickLoadResult, DataProvider, NetworkStats, VolumeMetadata } from '../src/data/data-provider.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

/** Raw float16 counts of `values`, as the streaming manager accumulates them. */
function counts(values: number[]): Uint32Array {
  const c = new Uint32Array(65536);
  for (const v of values) c[float32ToFloat16Bits(v)]!++;
  return c;
}

describe('float16 quantiles', () => {
  it('find p0.1 / p99.9 exactly, whatever the outliers', () => {
    const values = Array.from({ length: 10000 }, (_, i) => -3 + (6 * i) / 9999);
    values.push(60000, -60000, NaN, Infinity);
    const [lo, hi] = float16Quantiles(counts(values), 0.001, 0.999)!;
    expect(lo).toBeCloseTo(-2.99, 2);
    expect(hi).toBeCloseTo(2.99, 2);
  });

  it('are null without finite voxels', () => {
    expect(float16Quantiles(counts([NaN]), 0.001, 0.999)).toBeNull();
  });
});

describe('float16 levels', () => {
  const bruteForce = (lo: number, hi: number) =>
    new Set([...getFloat16ToFloat32Lut()].filter(v => v >= lo && v <= hi).map(v => v + 0)).size;

  it('count the distinct values the atlas stores in a range', () => {
    for (const [lo, hi] of [[0, 1], [-3, 3], [30000, 30100], [0.5, 0.5001]] as const) {
      expect(float16Levels(lo, hi)).toBe(bruteForce(lo, hi));
    }
    expect(float16Levels(30000, 30100)).toBeLessThan(10); // a large offset leaves few levels
  });
});

describe('OMERO windows of float data', () => {
  it('serve as the data range only when finite, ordered and storable', () => {
    expect(usableFloatWindow({ start: -1, end: 2, min: -3, max: 3 })).toBe(true);
    expect(usableFloatWindow({ start: 0, end: 1, min: -3.4e38, max: 3.4e38 })).toBe(false);
    expect(usableFloatWindow({ start: 0, end: 1, min: 3, max: -3 })).toBe(false);
    expect(usableFloatWindow({ start: NaN, end: 1, min: 0, max: 1 })).toBe(false);
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

/** 8³ float32 OME-Zarr v0.4 store holding `data`. */
function writeFloatDataset(data: Float32Array): string {
  const root = mkdtempSync(join(tmpdir(), 'kiln-float-'));
  mkdirSync(join(root, '0'));
  writeFileSync(join(root, '.zgroup'), JSON.stringify({ zarr_format: 2 }));
  writeFileSync(join(root, '.zattrs'), JSON.stringify({
    multiscales: [{ version: '0.4', axes: ['z', 'y', 'x'].map(name => ({ name, type: 'space' })), datasets: [{ path: '0' }] }],
  }));
  writeFileSync(join(root, '0', '.zarray'), JSON.stringify({
    zarr_format: 2, shape: [8, 8, 8], chunks: [8, 8, 8], dtype: '<f4', compressor: null, fill_value: 0, order: 'C', filters: null,
  }));
  writeFileSync(join(root, '0', '0.0.0'), new Uint8Array(data.buffer));
  return root;
}

describe('float bricks', () => {
  it('store NaN voxels as 0', async () => {
    const data = new Float32Array(512).fill(-2);
    data[0] = NaN;
    const provider = new LocalZarrDataProvider(dirHandle(writeFloatDataset(data)));
    await provider.initialize();
    const brick = await provider.loadBrick(0, 0, 0, 0);
    const lut = getFloat16ToFloat32Lut();
    expect(lut[brick!.data[1 + 66 * (1 + 66)]!]).toBe(0); // voxel 0, past the one-voxel border
    expect(lut[brick!.data[2 + 66 * (1 + 66)]!]).toBe(-2);
  });

  it('forget stats normalised to the provisional range once the real range is known', async () => {
    // Every value is below the provisional [0, 1], so the brick looks empty until then
    const provider = new LocalZarrDataProvider(dirHandle(writeFloatDataset(new Float32Array(512).fill(-2))));
    await provider.initialize();
    await provider.loadBrick(0, 0, 0, 0);
    expect(await provider.isBrickEmpty(0, 0, 0, 0, 100)).toBe(true);
    await provider.setFloatRange(-3, -1);
    expect(await provider.isBrickEmpty(0, 0, 0, 0, 100)).toBe(false);
  });
});

describe('derived float range', () => {
  it('is the p0.1 / p99.9 of the stored base level, not its extremes', async () => {
    const meta: VolumeMetadata = {
      name: 'f', dimensions: [64, 64, 64], brickSize: 64, physicalBrickSize: 66, maxLod: 0, bitDepth: 16,
      numChannels: 1, isFloat: true, dataRange: [0, 1],
      levels: [{ lod: 0, dimensions: [64, 64, 64], brickGrid: [1, 1, 1], brickCount: 1 }],
    };
    const data = new Uint16Array(66 ** 3);
    for (let i = 0; i < data.length; i++) data[i] = float32ToFloat16Bits(-3 + (6 * i) / data.length);
    data[0] = float32ToFloat16Bits(60000); // one hot voxel
    const brick: BrickLoadResult = { data, min: 0, max: 65535, avg: 0, rawMin: -3, rawMax: 1e30 };
    const provider = {
      initialize: vi.fn(), getMetadata: () => meta, getBrickGrid: () => [1, 1, 1],
      loadBrick: vi.fn(async () => brick), isBrickEmpty: vi.fn(async () => false), getBrickStats: vi.fn(async () => null),
      getNetworkStats: () => ({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 }) as NetworkStats,
      setFloatRange: vi.fn(async () => {}), dispose: vi.fn(),
    } as unknown as DataProvider;
    const resources = {
      numChannels: 1,
      allocator: {
        allocate: vi.fn(() => ({ slot: { x: 0, y: 0, z: 0 }, slotIndex: 0, evicted: null })),
        setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(), usedCount: 0, totalSlots: 8,
      },
      indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
      canvases: [{ bitDepth: 16, format: 'r16float' }],
    };
    const config = { normalizedSize: [1, 1, 1], emptyBrickThreshold: 100 };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sm = new StreamingManager(resources as never, provider, meta, {} as GPUDevice, config as never, vi.fn());
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));

    const [lo, hi] = meta.dataRange!;
    expect(lo).toBeCloseTo(-2.99, 2);
    expect(hi).toBeCloseTo(2.99, 2);
    expect(provider.setFloatRange).toHaveBeenCalledWith(lo, hi);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('clamped')); // raw max 1e30
    warn.mockRestore();
  });
});
