/**
 * Demand-aware desired set (?p30 slice, ?p31 clip): bricks that cannot
 * contribute to the current view are not requested; the base level always is.
 * Exercises the real computeDesiredSet traversal with a stub camera.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mat4 } from 'wgpu-matrix';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { DatasetConfig } from '../src/core/config.js';
import type { DataProvider, VolumeMetadata, NetworkStats } from '../src/data/data-provider.js';
import type { ViewParams } from '../src/core/view.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));
const flags = new Set<string>();
vi.mock('../src/core/feature-flags.js', () => ({
  isFlagEnabled: (name: string) => flags.has(name),
  activeFlags: () => [...flags],
}));

function makeMetadata(): VolumeMetadata {
  return {
    name: 'demand', dimensions: [512, 512, 512], brickSize: 64, physicalBrickSize: 66,
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
    getNetworkStats: vi.fn().mockReturnValue({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 } as NetworkStats),
    dispose: vi.fn(),
  };
}
function makeResources() {
  return {
    numChannels: 1,
    allocator: { allocate: vi.fn().mockReturnValue({ slot: { x: 0, y: 0, z: 0 }, slotIndex: 0, evicted: null }), setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(), usedCount: 0, totalSlots: 512 },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: [{ bitDepth: 8 }],
  };
}
function stubView(pos: [number, number, number]): ViewParams {
  const width = 800, height = 600, fovY = Math.PI / 4;
  return {
    position: new Float32Array(pos),
    view: mat4.lookAt(pos, [0, 0, 0], [0, 1, 0]) as Float32Array,
    proj: mat4.perspective(fovY, width / height, 0.01, 100) as Float32Array,
    fovY, width, height,
  };
}
async function freshSM(): Promise<StreamingManager> {
  const sm = new StreamingManager(makeResources() as never, makeProvider(), makeMetadata(), {} as GPUDevice, new DatasetConfig([512, 512, 512], [1, 1, 1]) as never, vi.fn());
  await vi.waitFor(() => { expect(sm.baseLodLoaded).toBe(true); });
  return sm;
}
/** Desired keys parsed into {lod, bx, by, bz}. */
function desired(sm: StreamingManager) {
  return [...(sm as unknown as { desiredKeys: Set<string> }).desiredKeys].map(k => {
    const m = /^lod(\d+):(\d+)\/(\d+)\/(\d+)$/.exec(k)!;
    return { lod: Number(m[1]), bz: Number(m[2]), by: Number(m[3]), bx: Number(m[4]) };
  });
}
const fullDemand = { mode: 'dvr', clipMin: [0, 0, 0] as [number, number, number], clipMax: [1, 1, 1] as [number, number, number], slices: [0.5, 0.5, 0.5] as [number, number, number], showSlice: [true, true, true] as [boolean, boolean, boolean] };

beforeEach(() => { flags.clear(); vi.clearAllMocks(); });

describe('clip-aware demand (?p31)', () => {
  it('drops refinement bricks entirely outside the clip box; the pinned base is untouched', async () => {
    flags.add('p31');
    const sm = await freshSM();
    // Only the upper half in z is visible; a whole-voxel margin means bricks touching z=0.5 may stay.
    sm.setRenderDemand({ ...fullDemand, clipMin: [0, 0, 0.5] });
    sm.forceUpdate(stubView([0, 0, 0.9]));
    const d = desired(sm);
    const fine = d.filter(b => b.lod < 3);
    expect(fine.length).toBeGreaterThan(0);
    for (const b of fine) {
      const cells = 1 << b.lod;             // bricks per axis at this lod = 8 / 2^lod; brick span in voxels
      const spanVox = 64 * cells;
      const zMaxVox = Math.min((b.bz + 1) * spanVox, 512);
      // brick must reach into the clipped-in half (z voxel ≥ 256) minus one voxel margin
      expect(zMaxVox).toBeGreaterThanOrEqual(256 - cells);
    }
    // the base level is pinned rather than desired, so it is unaffected by culling
    expect((sm as unknown as { pinnedBricks: Set<string> }).pinnedBricks.size).toBe(1);
  });

  it('flag off: the same clip box does not change the desired set', async () => {
    const sm = await freshSM();
    sm.setRenderDemand({ ...fullDemand, clipMin: [0, 0, 0.5] });
    sm.forceUpdate(stubView([0, 0, 0.9]));
    const withClip = desired(sm).length;
    const sm2 = await freshSM();
    sm2.forceUpdate(stubView([0, 0, 0.9]));
    expect(withClip).toBe(desired(sm2).length);
  });
});

describe('slice-aware demand (?p30)', () => {
  it('in slice mode only bricks intersecting a visible plane are requested', async () => {
    flags.add('p30');
    const sm = await freshSM();
    sm.setRenderDemand({ ...fullDemand, mode: 'slice', slices: [0.5, 0.5, 0.5], showSlice: [true, false, false] });
    sm.forceUpdate(stubView([0, 0, 0.9]));
    const fine = desired(sm).filter(b => b.lod < 3);
    expect(fine.length).toBeGreaterThan(0);
    for (const b of fine) {
      const spanVox = 64 * (1 << b.lod);
      const x0 = b.bx * spanVox, x1 = Math.min(x0 + spanVox, 512);
      // plane at voxel 256 (x = 0.5) with a one-voxel margin
      expect(x0 - (1 << b.lod)).toBeLessThanOrEqual(256);
      expect(x1 + (1 << b.lod)).toBeGreaterThanOrEqual(256);
    }
  });

  it('non-slice modes ignore the slice planes', async () => {
    flags.add('p30');
    const sm = await freshSM();
    sm.setRenderDemand({ ...fullDemand, mode: 'dvr', showSlice: [true, false, false] });
    sm.forceUpdate(stubView([0, 0, 0.9]));
    const sm2 = await freshSM();
    sm2.forceUpdate(stubView([0, 0, 0.9]));
    expect(desired(sm).length).toBe(desired(sm2).length);
  });
});
