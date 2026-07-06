/**
 * Screen-Space Error (SSE) LOD selection — exercises the REAL StreamingManager
 * traversal, not a reimplemented formula. A stub camera (view/proj matrices) and
 * mocked resources are supplied as inputs; the class's own computeDesiredSet →
 * traverse → SSE + hysteresis logic decides which LODs land in the desired set.
 *
 * Covered:
 *  - getVoxelWorldSize scales 2^lod (real private method)
 *  - closer camera selects finer LODs; distant camera stays coarse (monotonic)
 *  - hysteresis band: a brick only splits when finer children are already resident
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mat4 } from 'wgpu-matrix';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { DatasetConfig } from '../src/core/config.js';
import type { DataProvider, VolumeMetadata, NetworkStats } from '../src/data/data-provider.js';

// Only WebGPU-touching call during base LOD loading.
vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

// 512³ volume, 4 LOD levels (brick grids 8 → 4 → 2 → 1).
function makeMetadata(): VolumeMetadata {
  return {
    name: 'sse', dimensions: [512, 512, 512], brickSize: 64, physicalBrickSize: 66,
    maxLod: 3, bitDepth: 8, numChannels: 1,
    levels: [
      { lod: 0, dimensions: [512, 512, 512], brickGrid: [8, 8, 8], brickCount: 512 },
      { lod: 1, dimensions: [256, 256, 256], brickGrid: [4, 4, 4], brickCount: 64 },
      { lod: 2, dimensions: [128, 128, 128], brickGrid: [2, 2, 2], brickCount: 8 },
      { lod: 3, dimensions: [64, 64, 64], brickGrid: [1, 1, 1], brickCount: 1 },
    ],
  };
}

function makeProvider(): DataProvider {
  const brick = new Uint8Array(66 * 66 * 66);
  return {
    initialize: vi.fn().mockResolvedValue(makeMetadata()),
    getMetadata: vi.fn().mockReturnValue(makeMetadata()),
    getBrickGrid: vi.fn().mockReturnValue([1, 1, 1] as [number, number, number]),
    loadBrick: vi.fn().mockResolvedValue({ data: brick, min: 0, max: 128, avg: 64 }),
    isBrickEmpty: vi.fn().mockResolvedValue(false),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({
      totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0,
    } as NetworkStats),
    dispose: vi.fn(),
  };
}

function makeResources() {
  return {
    numChannels: 1,
    allocator: {
      allocate: vi.fn().mockReturnValue({ slot: { x: 0, y: 0, z: 0 }, slotIndex: 0, evicted: null }),
      setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(),
      usedCount: 0, totalSlots: 512,
    },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: [{ bitDepth: 8 }],
  };
}

// Camera test double: supplies exactly the matrices/position computeDesiredSet
// reads. Not the logic under test — just an input fixture.
function stubCamera(pos: [number, number, number]) {
  const view = mat4.lookAt(pos, [0, 0, 0], [0, 1, 0]);
  return {
    position: new Float32Array(pos),
    getViewMatrix: () => view,
    getProjectionMatrix: (aspect: number) => mat4.perspective(Math.PI / 4, aspect, 0.01, 100),
  };
}

const canvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;

// Construct an SM, wait for the constructor's base-LOD load, then wipe the
// residual base-load state so each SSE scenario starts from a clean slate.
async function freshSM(): Promise<StreamingManager> {
  const sm = new StreamingManager(
    makeResources() as never, makeProvider(), makeMetadata(),
    {} as GPUDevice, new DatasetConfig([512, 512, 512], [1, 1, 1]) as never, vi.fn(),
  );
  await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });
  const priv = sm as unknown as { loadedBricks: Map<string, unknown>; emptyBricks: Set<string>; pinnedBricks: Set<string> };
  priv.loadedBricks.clear();
  priv.emptyBricks.clear();
  priv.pinnedBricks.clear();
  return sm;
}

// LODs present in the real desired set after a forceUpdate.
function desiredLods(sm: StreamingManager): number[] {
  const keys = (sm as unknown as { desiredKeys: Set<string> }).desiredKeys;
  return [...keys].map(k => Number(/^lod(\d+):/.exec(k)![1]));
}

beforeEach(() => { vi.clearAllMocks(); });

describe('SSE — voxel world size', () => {
  it('doubles per LOD level (real getVoxelWorldSize)', async () => {
    const sm = await freshSM();
    const g = (lod: number) => (sm as unknown as { getVoxelWorldSize(l: number): number }).getVoxelWorldSize(lod);
    expect(g(1) / g(0)).toBeCloseTo(2);
    expect(g(2) / g(1)).toBeCloseTo(2);
    expect(g(3) / g(0)).toBeCloseTo(8); // 2^3
  });
});

describe('SSE — LOD selection vs. camera distance', () => {
  async function minLodAt(dist: number): Promise<number> {
    const sm = await freshSM();
    sm.forceUpdate(stubCamera([0, 0, dist]), canvas);
    return Math.min(...desiredLods(sm));
  }

  it('keeps the coarsest LOD when the camera is far away', async () => {
    expect(await minLodAt(8)).toBe(3); // maxLod — nothing splits
  });

  it('selects finer LODs as the camera moves closer', async () => {
    expect(await minLodAt(0.6)).toBeLessThan(3);
  });

  it('is monotonic: nearer never selects a coarser floor than farther', async () => {
    const near = await minLodAt(0.6);
    const mid = await minLodAt(2);
    const far = await minLodAt(8);
    expect(near).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(far);
  });
});

describe('SSE — hysteresis band', () => {
  it('detects resident children (real hasResidentChildren)', async () => {
    const sm = await freshSM();
    const priv = sm as unknown as {
      hasResidentChildren(bx: number, by: number, bz: number, lod: number): boolean;
      loadedBricks: Map<string, unknown>;
    };
    expect(priv.hasResidentChildren(0, 0, 0, 3)).toBe(false);
    priv.loadedBricks.set('lod2:0/0/0', { slot: { x: 0, y: 0, z: 0 }, slotIndex: 0 });
    expect(priv.hasResidentChildren(0, 0, 0, 3)).toBe(true);
  });

  it('within the band, only splits when a finer child is already resident', async () => {
    // dist ≈ 1.7 puts the LOD-3 root's projected error inside the hysteresis
    // band (0.7·maxPixelError, maxPixelError].
    const DIST = 1.7;

    const without = await freshSM();
    without.forceUpdate(stubCamera([0, 0, DIST]), canvas);
    expect(Math.min(...desiredLods(without))).toBe(3); // no resident child → stays coarse

    const withChild = await freshSM();
    (withChild as unknown as { loadedBricks: Map<string, unknown> })
      .loadedBricks.set('lod2:0/0/0', { slot: { x: 0, y: 0, z: 0 }, slotIndex: 0 });
    withChild.forceUpdate(stubCamera([0, 0, DIST]), canvas);
    expect(Math.min(...desiredLods(withChild))).toBeLessThan(3); // resident child → splits
  });
});
