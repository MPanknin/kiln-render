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

import { sliderDomain, niceCeil, windowDomain } from '../examples/shared/auto-contrast.js';

const uint16 = { isFloat: false, bitDepth: 16 as const, floatMin: 0, floatMax: 1 };

describe('sliderDomain', () => {
  it('sits a little above the bulk of the data, ignoring background', () => {
    const h = new Uint32Array(4096);
    h[0] = 1_000_000;
    for (let b = 1; b <= 100; b++) h[b] = 50; // 12-bit-in-16-bit style data
    const d = sliderDomain(h);
    expect(d).toBeGreaterThan(100 / 4095);
    expect(d).toBeLessThan(200 / 4095);
  });

  it('never drops below the current window and never exceeds 1', () => {
    const h = new Uint32Array(4096);
    for (let b = 1; b <= 100; b++) h[b] = 50;
    expect(sliderDomain(h, 0.5)).toBe(0.5);
    const full = new Uint32Array(256).fill(1);
    expect(sliderDomain(full)).toBe(1);
  });

  it('falls back to the full range without data', () => {
    expect(sliderDomain(new Uint32Array(256))).toBe(1);
  });
});

describe('niceCeil', () => {
  it('rounds up to two significant digits', () => {
    expect(niceCeil(1480)).toBe(1500);
    expect(niceCeil(0.0312)).toBeCloseTo(0.032, 9);
    expect(niceCeil(1500)).toBe(1500);
    expect(niceCeil(78)).toBe(78);
  });
});

describe('windowDomain', () => {
  it('gives a round raw upper value and a fine step', () => {
    const h = new Uint32Array(4096);
    for (let b = 1; b <= 93; b++) h[b] = 50; // ≈ 1500 counts of 65535
    const d = windowDomain(h, 0.02, uint16);
    const raw = d.max * 65535;
    expect(raw).toBeCloseTo(niceCeil(raw), 6);
    expect(raw).toBeGreaterThan(1500);
    expect(raw).toBeLessThan(3000);
    expect(d.step).toBeCloseTo(d.max / 400, 12);
  });

  it('stays just above the current window until a histogram exists', () => {
    const d = windowDomain(null, 0.03, uint16);
    expect(d.max).toBeGreaterThan(0.03);
    expect(d.max).toBeLessThan(0.05);
    expect(windowDomain(null, 1, uint16).max).toBe(1);
  });
});
