/**
 * 16-bit atlas formats: r16unorm when the device allows it, otherwise uint16 on
 * r16float stored as value - UINT16_FLOAT16_OFFSET (lossless up to 4096).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { detectBest16BitFormat } from '../src/core/volume.js';
import { computeHistogram } from '../src/core/histogram.js';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { getUint16ToFloat16Lut, uint16ToFloat16 } from '../src/utils/float16.js';

describe('detectBest16BitFormat', () => {
  beforeAll(() => vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2 }));
  afterAll(() => vi.unstubAllGlobals());

  const device = (...features: string[]) =>
    ({ features: new Set(features), createTexture: () => ({ destroy() {} }) }) as unknown as GPUDevice;

  it('uses r16unorm for uint16 when texture-formats-tier1 is enabled', () => {
    expect(detectBest16BitFormat(device('texture-formats-tier1'))).toBe('r16unorm');
  });

  it('keeps r16float without the feature, and for raw-value data', () => {
    expect(detectBest16BitFormat(device())).toBe('r16float');
    expect(detectBest16BitFormat(device('texture-formats-tier1'), true)).toBe('r16float');
  });
});

describe('uint16 on r16float', () => {
  it('histograms 12-bit data exactly like the raw values', () => {
    const values = Uint16Array.from({ length: 4097 }, (_, i) => i);
    const stored = computeHistogram([uint16ToFloat16(values)], 16, 4096, false, 0, 1, 'r16float');
    const raw = computeHistogram([values], 16, 4096, false, 0, 1, 'r16unorm');
    expect(Array.from(stored)).toEqual(Array.from(raw));
  });

  it('fills zero bricks with the stored form of 0', () => {
    const zeroBrick = (format: GPUTextureFormat, isFloat: boolean) =>
      (StreamingManager.prototype as any).getZeroBrick.call(
        { zeroBricks: new Map(), metadata: { isFloat } },
        { bitDepth: 16, format },
      ) as Uint16Array;

    expect(new Set(zeroBrick('r16float', false))).toEqual(new Set([getUint16ToFloat16Lut()[0]]));
    expect(new Set(zeroBrick('r16unorm', false))).toEqual(new Set([0]));
    expect(new Set(zeroBrick('r16float', true))).toEqual(new Set([0]));
  });
});
