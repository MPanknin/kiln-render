/**
 * CPU brick geometry must match the shader: bricks span 64·2^lod finest voxels with
 * only the last one truncated, mapped by (voxel / dims − 0.5) · normalizedSize.
 */
import { describe, it, expect } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { DatasetConfig } from '../src/core/config.js';

type Geometry = {
  getBrickAABB(bx: number, by: number, bz: number, lod: number): { min: number[]; max: number[] };
  getVoxelWorldSize(lod: number): number;
};

function makeGeometry(dims: [number, number, number], spacing: [number, number, number] = [1, 1, 1], maxLod = 0): Geometry {
  const sm: any = Object.create(StreamingManager.prototype);
  sm.config = new DatasetConfig(dims, spacing);
  sm.levelsByLod = [];
  for (let lod = 0; lod <= maxLod; lod++) {
    const span = 64 << lod;
    sm.levelsByLod[lod] = { brickGrid: dims.map(d => Math.ceil(d / span)) };
  }
  return sm;
}

/** Reference implementation of the shader's voxelToNormalized for one axis. */
const toWorld = (voxel: number, dim: number, normalized: number) => (voxel / dim - 0.5) * normalized;

describe('getBrickAABB', () => {
  it('bricks of a 100³ volume are 64 voxels wide, the last one truncated to 36', () => {
    const g = makeGeometry([100, 100, 100]);
    const first = g.getBrickAABB(0, 0, 0, 0);
    const last = g.getBrickAABB(1, 1, 1, 0);
    expect(first.min[0]).toBeCloseTo(-0.5);
    expect(first.max[0]).toBeCloseTo(toWorld(64, 100, 1));
    expect(last.min[0]).toBeCloseTo(toWorld(64, 100, 1));
    expect(last.max[0]).toBeCloseTo(0.5);
  });

  it('adjacent bricks share a face exactly at every LOD', () => {
    const g = makeGeometry([1023, 700, 300], [1, 1, 1], 2);
    for (let lod = 0; lod <= 2; lod++) {
      const a = g.getBrickAABB(2, 1, 0, lod);
      const b = g.getBrickAABB(3, 1, 0, lod);
      expect(a.max[0]).toBeCloseTo(b.min[0]);
    }
  });

  it('a coarse brick covers exactly its 2×2×2 children', () => {
    const g = makeGeometry([1023, 1023, 1023], [1, 1, 1], 1);
    const parent = g.getBrickAABB(7, 0, 0, 1);
    const firstChild = g.getBrickAABB(14, 0, 0, 0);
    const lastChild = g.getBrickAABB(15, 0, 0, 0);
    expect(parent.min[0]).toBeCloseTo(firstChild.min[0]);
    expect(parent.max[0]).toBeCloseTo(lastChild.max[0]);
    expect(parent.max[0]).toBeCloseTo(0.5); // 1023 truncates the last child at the volume edge
  });

  it('anisotropic spacing stretches bounds along the coarse axis', () => {
    const dims: [number, number, number] = [2048, 2048, 35];
    const g = makeGeometry(dims, [1, 1, 10]);
    const normalizedZ = (35 * 10) / 2048;
    const a = g.getBrickAABB(0, 0, 0, 0);
    expect(a.min[2]).toBeCloseTo(-normalizedZ / 2);
    expect(a.max[2]).toBeCloseTo(normalizedZ / 2); // 35 < 64: the single Z brick spans the whole slab
  });

  it('returns a degenerate box for a missing LOD', () => {
    const g = makeGeometry([128, 128, 128]);
    expect(g.getBrickAABB(0, 0, 0, 5)).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
  });
});

describe('getVoxelWorldSize', () => {
  it('isotropic: one voxel of the largest axis, unchanged from the previous metric', () => {
    const g = makeGeometry([512, 256, 128]);
    expect(g.getVoxelWorldSize(0)).toBeCloseTo(1 / 512);
  });

  it('anisotropic: the largest physical voxel across axes', () => {
    const g = makeGeometry([2048, 2048, 35], [0.108335, 0.108335, 0.4]);
    const maxPhysical = 2048 * 0.108335;
    expect(g.getVoxelWorldSize(0)).toBeCloseTo(0.4 / maxPhysical);
  });

  it('doubles per LOD', () => {
    const g = makeGeometry([300, 300, 300], [1, 1, 3], 3);
    expect(g.getVoxelWorldSize(3) / g.getVoxelWorldSize(0)).toBeCloseTo(8);
  });
});
