import { describe, it, expect } from 'vitest';
import { upsampleFromAncestor } from '../src/streaming/placeholder.js';

const P = 66;
const idx = (x: number, y: number, z: number) => z * P * P + y * P + x;

/** Parent whose voxel value encodes its own physical x (+100·y, +10000·z not needed at this size). */
function encodedParent(): Uint16Array {
  const d = new Uint16Array(P * P * P);
  for (let z = 0; z < P; z++) for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) d[idx(x, y, z)] = x + 100 * (y % 10);
  return d;
}

describe('upsampleFromAncestor', () => {
  it('ratio 1 on the same brick is the identity', () => {
    const p = encodedParent();
    const out = upsampleFromAncestor(p, [0, 0, 0], [0, 0, 0], [1, 1, 1]);
    expect(out).toEqual(p);
    expect(out).toBeInstanceOf(Uint16Array);
  });

  it('maps a 2× child onto the right half of its parent, ghost border included', () => {
    const p = encodedParent();
    // child bx=1 of parent bx=0 at ratio 2 in x only
    const out = upsampleFromAncestor(p, [1, 0, 0], [0, 0, 0], [2, 1, 1]);
    // child level voxel v = 64 − 1 + i → parent voxel floor((v + 0.5)/2), physical index + 1
    for (const i of [0, 1, 2, 33, 64, 65]) {
      const expectedX = Math.min(65, Math.floor((63 + i + 0.5) / 2) + 1);
      expect(out[idx(i, 5, 7)]).toBe(expectedX + 100 * 5);
    }
  });

  it('left child starts at the parent ghost voxel and clamps inside the brick', () => {
    const p = encodedParent();
    const out = upsampleFromAncestor(p, [0, 0, 0], [0, 0, 0], [2, 2, 2]);
    expect(out[idx(0, 0, 0)]! % 100).toBe(0);          // v = −1 → parent ghost (physical 0)
    expect(out[idx(1, 0, 0)]! % 100).toBe(1);          // v = 0 → parent voxel 0 (physical 1)
    expect(out[idx(65, 0, 0)]! % 100).toBe(Math.floor((64.5) / 2) + 1); // 33
  });

  it('handles an ancestor two levels up (ratio 4)', () => {
    const p = encodedParent();
    const out = upsampleFromAncestor(p, [3, 0, 0], [0, 0, 0], [4, 1, 1]);
    const i = 10;
    expect(out[idx(i, 0, 0)]! % 100).toBe(Math.floor((3 * 64 - 1 + i + 0.5) / 4) + 1);
  });
});
