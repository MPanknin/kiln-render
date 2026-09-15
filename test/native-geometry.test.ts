/**
 * Per-axis level geometry driven by DatasetConfig.levels: indirection spans,
 * brick bounds, SSE voxel size, parent lookup and traversal children when an
 * axis does not halve between levels. Legacy configs must be unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { mat4 } from 'wgpu-matrix';
import { DatasetConfig } from '../src/core/config.js';
import { buildPyramid } from '../src/core/pyramid.js';
import { IndirectionTable } from '../src/core/indirection.js';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import type { DataProvider, VolumeMetadata, NetworkStats } from '../src/data/data-provider.js';
import type { ViewParams } from '../src/core/view.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

// 128³ finest grid (2×2×2 bricks); level 1 halves X and Y only → 1×1×2 bricks.
const zKept = buildPyramid([{ dims: [128, 128, 128] }, { dims: [64, 64, 128] }]).levels;
const nativeConfig = () => new DatasetConfig([128, 128, 128], [1, 1, 1], 100, zKept);
const legacyConfig = () => new DatasetConfig([128, 128, 128]);

describe('DatasetConfig level helpers', () => {
  it('legacy default is [lod, lod, lod] with 2 children per axis', () => {
    const c = legacyConfig();
    expect(c.levelExponent(2)).toEqual([2, 2, 2]);
    expect(c.levelSpanCells(2)).toEqual([4, 4, 4]);
    expect(c.childCounts(1)).toEqual([2, 2, 2]);
  });

  it('native exposes per-axis spans, children and ratios', () => {
    const c = nativeConfig();
    expect(c.levelExponent(1)).toEqual([1, 1, 0]);
    expect(c.levelSpanCells(1)).toEqual([2, 2, 1]);
    expect(c.childCounts(1)).toEqual([2, 2, 1]);
    expect(c.levelRatio(1, 0)).toEqual([2, 2, 1]);
  });
});

describe('IndirectionTable with a per-axis level model', () => {
  const makeTable = (config: DatasetConfig) => {
    vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2 });
    const device: any = { createTexture: () => ({ destroy: vi.fn() }), queue: { writeTexture: vi.fn() } };
    return new IndirectionTable(device, config);
  };
  const w = (t: IndirectionTable, x: number, y: number, z: number) =>
    (t as unknown as { data: Uint8Array }).data[(x + y * 2 + z * 4) * 4 + 3];

  it('a level-1 brick covers 2×2×1 cells, not 2×2×2', () => {
    const t = makeTable(nativeConfig());
    t.setBrick(0, 0, 1, 5, 5, 5, 1); // brick z=1 at level 1 lives in the upper half
    expect([w(t, 0, 0, 1), w(t, 1, 1, 1)]).toEqual([2, 2]);
    expect([w(t, 0, 0, 0), w(t, 1, 1, 0)]).toEqual([0, 0]);
    vi.unstubAllGlobals();
  });

  it('legacy config still fills the full 2×2×2 block', () => {
    const t = makeTable(legacyConfig());
    t.setBrick(0, 0, 0, 5, 5, 5, 1);
    expect([w(t, 0, 0, 0), w(t, 1, 1, 1)]).toEqual([2, 2]);
    vi.unstubAllGlobals();
  });
});

describe('StreamingManager geometry with a per-axis level model', () => {
  type Geometry = {
    getBrickAABB(bx: number, by: number, bz: number, lod: number): { min: number[]; max: number[] };
    getVoxelWorldSize(lod: number): number;
    findParentBrick(bx: number, by: number, bz: number, lod: number): { lod: number } | null;
  };
  const geometry = (config: DatasetConfig, loaded: string[] = []): Geometry => {
    const sm: any = Object.create(StreamingManager.prototype);
    sm.config = config;
    sm.maxLod = 1;
    sm.levelsByLod = [{ brickGrid: [2, 2, 2] }, { brickGrid: [1, 1, 2] }];
    sm.loadedBricks = new Map(loaded.map(k => [k, { slot: { x: 0, y: 0, z: 0 } }]));
    return sm;
  };

  it('level-1 brick bounds span the whole XY extent but only half of Z', () => {
    const g = geometry(nativeConfig());
    const upper = g.getBrickAABB(0, 0, 1, 1);
    expect(upper.min).toEqual([-0.5, -0.5, 0]);
    expect(upper.max).toEqual([0.5, 0.5, 0.5]);
  });

  it('SSE voxel size ignores the axis that finer levels cannot improve', () => {
    const flat = buildPyramid([{ dims: [2048, 2048, 35] }, { dims: [1024, 1024, 35] }]).levels;
    const g = geometry(new DatasetConfig([2048, 2048, 35], [1, 1, 10], 100, flat));
    expect(g.getVoxelWorldSize(0)).toBeCloseTo(10 / 2048); // nothing improvable at 0: largest voxel
    expect(g.getVoxelWorldSize(1)).toBeCloseTo(2 / 2048);  // level 1: only XY refine, Z is native
  });

  it('parent lookup divides by the per-axis ratio', () => {
    const g = geometry(nativeConfig(), ['lod1:1/0/0']); // key = lod:z/y/x
    expect(g.findParentBrick(1, 1, 1, 0)?.lod).toBe(1); // z stays 1 (ratio 1), x/y halve
    expect(g.findParentBrick(1, 1, 0, 0)).toBeNull();
  });
});

describe('StreamingManager traversal with a per-axis level model', () => {
  const metadata: VolumeMetadata = {
    name: 'zkept', dimensions: [128, 128, 128], brickSize: 64, physicalBrickSize: 66,
    maxLod: 1, bitDepth: 8, numChannels: 1,
    levels: [
      { lod: 0, dimensions: [128, 128, 128], brickGrid: [2, 2, 2], brickCount: 8 },
      { lod: 1, dimensions: [64, 64, 128], brickGrid: [1, 1, 2], brickCount: 2 },
    ],
  };
  const provider = (): DataProvider => ({
    initialize: vi.fn().mockResolvedValue(metadata),
    getMetadata: vi.fn().mockReturnValue(metadata),
    getBrickGrid: vi.fn().mockReturnValue([1, 1, 2] as [number, number, number]),
    loadBrick: vi.fn().mockResolvedValue({ data: new Uint8Array(66 ** 3), min: 0, max: 128, avg: 64 }),
    isBrickEmpty: vi.fn().mockResolvedValue(false),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 } as NetworkStats),
    dispose: vi.fn(),
  });
  const resources = () => ({
    numChannels: 1,
    allocator: { allocate: vi.fn(() => ({ slot: { x: 0, y: 0, z: 0 }, slotIndex: 0, evicted: null })), setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(), usedCount: 0, totalSlots: 512 },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: [{ bitDepth: 8 }],
  });
  const closeView = (): ViewParams => {
    const pos: [number, number, number] = [0, 0, 0.9];
    return {
      position: new Float32Array(pos),
      view: mat4.lookAt(pos, [0, 0, 0], [0, 1, 0]) as Float32Array,
      proj: mat4.perspective(Math.PI / 4, 4 / 3, 0.01, 100) as Float32Array,
      fovY: Math.PI / 4, width: 1600, height: 1200,
    };
  };

  it('refines a level-1 brick into 2×2×1 children with the same z index', async () => {
    const sm = new StreamingManager(resources() as never, provider(), metadata, {} as GPUDevice, nativeConfig() as never, vi.fn());
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    sm.forceUpdate(closeView());
    const keys = [...(sm as unknown as { desiredKeys: Set<string> }).desiredKeys];
    const lod0 = keys.filter(k => k.startsWith('lod0:'));
    expect(lod0.length).toBeGreaterThan(0);
    // keys are lod:z/y/x — every child of the upper brick keeps z = 1, none has z = 2 or 3
    const zs = new Set(lod0.map(k => Number(/^lod0:(\d+)\//.exec(k)![1])));
    expect([...zs].every(z => z === 0 || z === 1)).toBe(true);
  });
});

describe('DatasetConfig.lodScaleTable', () => {
  it('legacy: 2^lod on every axis, padded to the table length', () => {
    const t = legacyConfig().lodScaleTable(4);
    expect(Array.from(t)).toEqual([1, 1, 1, 0, 2, 2, 2, 0, 4, 4, 4, 0, 8, 8, 8, 0]);
  });

  it('native: per-axis spans, with 1 on the axis that keeps native resolution', () => {
    const t = nativeConfig().lodScaleTable(2);
    expect(Array.from(t)).toEqual([1, 1, 1, 0, 2, 2, 1, 0]);
  });
});
