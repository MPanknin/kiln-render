import { describe, expect, it } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { RayVisibility } from '../src/streaming/ray-visibility.js';

const grid: [number, number, number] = [4, 4, 4];

/** Manager with just what ray guidance reads: two levels, LOD 1 bricks span 2³ cells. */
function manager(): any {
  const m = Object.create(StreamingManager.prototype) as any;
  m.maxLod = 2;
  m.rayGuidanceActive = true;
  m.rayVisibility = null;
  m.config = { datasetGrid: grid, levelSpanCells: (lod: number) => [2 ** lod, 2 ** lod, 2 ** lod] };
  return m;
}

function seen(cells: Array<[number, number, number]>): Uint32Array {
  const out = new Uint32Array(RayVisibility.wordCount(grid));
  for (const [x, y, z] of cells) {
    const i = (z * grid[1] + y) * grid[0] + x;
    out[i >> 5]! |= 1 << (i & 31);
  }
  return out;
}

describe('ray-guided brick selection', () => {
  it('culls nothing while the flag is off', () => {
    const m = manager();
    expect(m.rayCulls(0, 0, 0, 0)).toBe(false);
  });

  it('waits for the first readback instead of loading blind, but keeps the base level', () => {
    const m = manager();
    m.enableRayGuidance();
    expect(m.rayCulls(0, 0, 0, 0)).toBe(true);
    expect(m.rayCulls(0, 0, 0, 2)).toBe(false);
  });

  it('keeps bricks a ray reached and culls the rest, coarse bricks by any covered cell', () => {
    const m = manager();
    m.enableRayGuidance();
    m.reportRayVisibility(seen([[3, 1, 0]]));
    expect(m.rayCulls(3, 1, 0, 0)).toBe(false);
    expect(m.rayCulls(0, 0, 0, 0)).toBe(true);
    expect(m.rayCulls(1, 0, 0, 1)).toBe(false); // LOD 1 brick (1,0,0) covers cells x 2–3, y 0–1, z 0–1
    expect(m.rayCulls(0, 1, 0, 1)).toBe(true);
  });

  it('stops culling, and forgets what it saw, while no rays are marched', () => {
    const m = manager();
    m.enableRayGuidance();
    m.reportRayVisibility(seen([[0, 0, 0]]));
    m.setRayGuidanceActive(false);
    expect(m.rayCulls(3, 3, 3, 0)).toBe(false);
    m.reportRayVisibility(seen([[3, 3, 3]])); // ignored while inactive
    m.setRayGuidanceActive(true);
    expect(m.rayCulls(0, 0, 0, 0)).toBe(true); // not ready again until a fresh readback
  });
});
