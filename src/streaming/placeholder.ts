/**
 * Placeholder data for a partially loaded brick: an ancestor brick's region,
 * nearest-neighbour resampled into the child's physical layout (ghost border
 * included). A channel that has not arrived yet then shows exactly the coarse
 * data it showed before the child was committed, instead of zeros.
 */

import type { BrickData } from '../data/data-provider.js';

type Vec3 = [number, number, number];

/**
 * @param parent   ancestor brick data, `physSize³` voxels
 * @param child    child brick index at its level
 * @param ancestor ancestor brick index at its level
 * @param ratio    child-level voxels per ancestor-level voxel, per axis (power of two)
 */
export function upsampleFromAncestor(
  parent: BrickData,
  child: Vec3,
  ancestor: Vec3,
  ratio: Vec3,
  logicalSize = 64,
  physSize = 66,
): BrickData {
  // Per axis: child physical index i → ancestor physical index (level voxel v = b·64 − 1 + i).
  const lut = [0, 1, 2].map(a => {
    const t = new Int32Array(physSize);
    const childStart = child[a]! * logicalSize - 1;
    const ancStart = ancestor[a]! * logicalSize - 1;
    for (let i = 0; i < physSize; i++) {
      const vA = Math.floor((childStart + i + 0.5) / ratio[a]!);
      t[i] = Math.min(physSize - 1, Math.max(0, vA - ancStart));
    }
    return t;
  }) as [Int32Array, Int32Array, Int32Array];

  const out = new (parent.constructor as { new(n: number): BrickData })(physSize * physSize * physSize);
  const [lx, ly, lz] = lut;
  const plane = physSize * physSize;
  for (let z = 0; z < physSize; z++) {
    const pz = lz[z]! * plane;
    const oz = z * plane;
    for (let y = 0; y < physSize; y++) {
      const py = pz + ly[y]! * physSize;
      const oy = oz + y * physSize;
      for (let x = 0; x < physSize; x++) out[oy + x] = parent[py + lx[x]!]!;
    }
  }
  return out;
}
