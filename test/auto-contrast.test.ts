import { describe, it, expect } from 'vitest';
import { percentileWindow } from '../examples/shared/auto-contrast.js';

describe('percentileWindow', () => {
  it('returns null when only background (bin 0) is populated', () => {
    const h = new Uint32Array(256);
    h[0] = 1000;
    expect(percentileWindow(h)).toBeNull();
  });

  it('ignores background and wraps a narrow signal tightly', () => {
    const h = new Uint32Array(4096);
    h[0] = 1_000_000;
    for (let b = 100; b < 200; b++) h[b] = 50;
    const w = percentileWindow(h)!;
    const min = w.center - w.width / 2;
    const max = w.center + w.width / 2;
    expect(min).toBeCloseTo(100 / 4095, 3);
    expect(max).toBeCloseTo(200 / 4095, 3);
  });

  it('clips outliers beyond the percentiles', () => {
    const h = new Uint32Array(4096);
    for (let b = 1000; b < 2000; b++) h[b] = 100;
    h[4095] = 10; // a few hot voxels
    const w = percentileWindow(h)!;
    expect(w.center + w.width / 2).toBeLessThan(2100 / 4095);
  });

  it('never exceeds the 0–1 range', () => {
    const h = new Uint32Array(256).fill(1);
    const w = percentileWindow(h, 0, 1)!;
    expect(w.center - w.width / 2).toBeGreaterThanOrEqual(0);
    expect(w.center + w.width / 2).toBeLessThanOrEqual(1);
  });
});
