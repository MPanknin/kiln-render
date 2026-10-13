import { describe, it, expect } from 'vitest';
import { createRawHistogram, accumulateRaw, rebinHistogram, computeHistogram } from '../src/core/histogram.js';
import { float32ToFloat16Bits } from '../src/utils/float16.js';

describe('raw histograms', () => {
  it('counts every voxel by its stored value', () => {
    const raw = createRawHistogram(false);
    accumulateRaw(raw, Uint16Array.from([0, 0, 5, 65535]));
    accumulateRaw(raw, Uint16Array.from([5]));
    expect(raw.counts[0]).toBe(2);
    expect(raw.counts[5]).toBe(2);
    expect(raw.counts[65535]).toBe(1);
    expect(raw.counts.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('rebins uint16 onto shader-space bins like computeHistogram', () => {
    const data = Uint16Array.from([0, 1000, 1500, 65535]);
    const raw = createRawHistogram(false);
    accumulateRaw(raw, data);
    const fromRaw = rebinHistogram(raw, 16, 4096);
    expect(Array.from(fromRaw)).toEqual(Array.from(computeHistogram([data], 16, 4096)));
    expect(fromRaw[Math.floor((1500 / 65535) * 4095)]).toBe(1);
    expect(fromRaw[4095]).toBe(1);
  });

  it('uses the 0–255 range for data that arrived as bytes', () => {
    const raw = createRawHistogram(true);
    accumulateRaw(raw, Uint8Array.from([255, 128]));
    const h = rebinHistogram(raw, 16, 256, false, 0, 1, 'r8unorm');
    expect(h[255]).toBe(1);
    expect(h[128]).toBe(1);
  });

  it('decodes float16 bit patterns against the data range', () => {
    const raw = createRawHistogram(false);
    accumulateRaw(raw, Uint16Array.from([-1024, 0, 1024], (v) => float32ToFloat16Bits(v)));
    expect(Array.from(rebinHistogram(raw, 16, 3, true, -1024, 1024, 'r16float'))).toEqual([1, 1, 1]);
  });
});
