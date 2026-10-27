import { describe, expect, it, vi } from 'vitest';
import { Renderer, SOFT_RESET_FRAMES } from '../src/core/renderer.js';

function renderer(softReset: boolean, counts: number[]) {
  const r: any = Object.create(Renderer.prototype);
  const sets = counts.map(accumFrameCount => ({ accumFrameCount }));
  Object.assign(r, {
    softReset, enableJitter: true, enableTAA: true,
    scaleSets: new Map(sets.map((set, i) => [i, set])), onDirty: vi.fn(),
  });
  return { r, sets };
}

describe('brick commits and accumulation (?softreset)', () => {
  it('restart accumulation by default', () => {
    const { r, sets } = renderer(false, [64, 2]);
    r.bricksCommitted();
    expect(sets.map(s => s.accumFrameCount)).toEqual([0, 0]);
    expect(r.onDirty).toHaveBeenCalled();
  });

  it('keep at most SOFT_RESET_FRAMES of history with softReset', () => {
    const { r, sets } = renderer(true, [64, 2, 0]);
    r.bricksCommitted();
    expect(sets.map(s => s.accumFrameCount)).toEqual([SOFT_RESET_FRAMES, 2, 0]);
    expect(r.onDirty).toHaveBeenCalled();
  });

  it('seed jitter per pixel only with softReset', () => {
    expect(renderer(false, []).r.jitterMode).toBe(1);
    expect(renderer(true, []).r.jitterMode).toBe(2);
    const off = renderer(true, []).r;
    off.enableTAA = false;
    expect(off.jitterMode).toBe(0);
  });
});
