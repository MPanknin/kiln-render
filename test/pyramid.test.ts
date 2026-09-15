/**
 * Generalised pyramid model: per-axis 1×/2× steps from transforms or dims,
 * translation validation, group-level composition, and the legacy 2:1 model.
 */
import { describe, it, expect } from 'vitest';
import { buildPyramid, legacyPyramid, levelSpan } from '../src/core/pyramid.js';
import type { PyramidLevelInput, Vec3 } from '../src/core/pyramid.js';

const exps = (b: { levels: { exponent: Vec3 }[] }) => b.levels.map(l => l.exponent);

describe('buildPyramid — factors from dims (no transforms)', () => {
  it('isotropic 512³ over 4 levels is the [2,2,2] case', () => {
    const b = buildPyramid([512, 256, 128, 64].map(d => ({ dims: [d, d, d] as Vec3 })));
    expect(b.issues).toEqual([]);
    expect(exps(b)).toEqual([[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]]);
  });

  it('odd dims: 1023 → 512 → 256 is factor 2 (ceil), 1023 → 511 too (floor)', () => {
    expect(buildPyramid([{ dims: [1023, 1023, 1023] }, { dims: [512, 511, 512] }]).issues).toEqual([]);
  });

  it('XY-only pyramid keeps Z at exponent 0', () => {
    const b = buildPyramid([2048, 1024, 512].map(d => ({ dims: [d, d, 35] as Vec3 })));
    expect(b.issues).toEqual([]);
    expect(exps(b)).toEqual([[0, 0, 0], [1, 1, 0], [2, 2, 0]]);
  });

  it('rejects a factor that is neither 1 nor 2', () => {
    const b = buildPyramid([{ dims: [900, 900, 900] }, { dims: [300, 300, 300] }]);
    expect(b.issues.join()).toMatch(/level 1 x: downsampling factor/);
  });
});

describe('buildPyramid — transforms', () => {
  const level = (dims: Vec3, scale: Vec3, translation?: Vec3): PyramidLevelInput => ({ dims, scale, translation });

  it('reads scale ratios as factors and cross-checks dims', () => {
    const b = buildPyramid([
      level([2048, 2048, 25], [1, 1, 0.2]),
      level([1024, 1024, 25], [2, 2, 0.2]),
      level([512, 512, 25], [4, 4, 0.2]),
    ]);
    expect(b.issues).toEqual([]);
    expect(exps(b)).toEqual([[0, 0, 0], [1, 1, 0], [2, 2, 0]]);
    expect(b.levels[2]!.spacing).toEqual([4, 4, 0.2]);
  });

  it('mixed steps: beechnut-like Z-only halving at the last level, with box-filter translations', () => {
    const s = 2e-5;
    const t0: Vec3 = [-0.01024, -0.01024, -0.01546];
    const shift = (e: Vec3): Vec3 => t0.map((t, i) => t + ((1 << e[i]!) - 1) / 2 * s) as Vec3;
    const b = buildPyramid([
      level([1024, 1024, 1546], [s, s, s], t0),
      level([512, 512, 773], [2 * s, 2 * s, 2 * s], shift([1, 1, 1])),
      level([256, 256, 386], [4 * s, 4 * s, 4 * s], shift([2, 2, 2])),
      level([128, 128, 193], [8 * s, 8 * s, 8 * s], shift([3, 3, 3])),
      level([128, 128, 96], [8 * s, 8 * s, 16 * s], shift([3, 3, 4])),
    ]);
    expect(b.issues).toEqual([]);
    expect(b.levels[4]!.exponent).toEqual([3, 3, 4]);
  });

  it('rejects dims inconsistent with the declared scale', () => {
    const b = buildPyramid([level([1000, 1000, 1000], [1, 1, 1]), level([600, 500, 500], [2, 2, 2])]);
    expect(b.issues.join()).toMatch(/level 1 x: 600 voxels do not match factor 2/);
  });

  it('rejects a non-integer scale ratio', () => {
    const b = buildPyramid([level([1000, 1000, 1000], [1, 1, 1]), level([500, 500, 500], [2, 2, 2.5])]);
    expect(b.issues.join()).toMatch(/level 1 z: scale ratio 2.5000/);
  });

  it('rejects a translation that is neither unshifted nor the half-voxel shift', () => {
    const b = buildPyramid([level([64, 64, 64], [1, 1, 1], [0, 0, 0]), level([32, 32, 32], [2, 2, 2], [0.5, 0.5, 3])]);
    expect(b.issues).toEqual(['level 1 z: translation 3 is not a supported offset of level 0']);
  });

  it('group-level scale and translation compose after per-level transforms', () => {
    const b = buildPyramid([level([64, 64, 64], [1, 1, 1], [1, 1, 1])], [0.5, 0.5, 2], [10, 10, 10]);
    expect(b.levels[0]!.spacing).toEqual([0.5, 0.5, 2]);
    expect(b.levels[0]!.origin).toEqual([10.5, 10.5, 12]);
  });

  it('a v0.4 group-level scale alone becomes the level-0 spacing', () => {
    const b = buildPyramid([{ dims: [64, 64, 64] }, { dims: [32, 32, 32] }], [0.1, 0.1, 0.5]);
    expect(b.issues).toEqual([]);
    expect(b.levels[1]!.spacing).toEqual([0.2, 0.2, 1]);
  });
});

describe('legacyPyramid and levelSpan', () => {
  it('legacy model halves every axis with ceil, matching the historical virtual dims', () => {
    const levels = legacyPyramid([100, 100, 35], [1, 1, 1], 3);
    expect(levels.map(l => l.dims)).toEqual([[100, 100, 35], [50, 50, 18], [25, 25, 9]]);
    expect(levels[2]!.exponent).toEqual([2, 2, 2]);
  });

  it('levelSpan is brickSize << exponent per axis', () => {
    const [, l1] = buildPyramid([{ dims: [256, 256, 35] }, { dims: [128, 128, 35] }]).levels;
    expect(levelSpan(l1!, 64)).toEqual([128, 128, 64]);
  });
});
