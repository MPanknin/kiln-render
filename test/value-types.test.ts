import { describe, it, expect } from 'vitest';
import { valueTypeFor, provisionalDataRange, SUPPORTED_DTYPES } from '../src/data/value-types.js';
import { float32ToFloat16Bits, float16BitsToFloat32 } from '../src/utils/float16.js';
import { computeHistogram } from '../src/core/histogram.js';
import { formatRawValue, isIntegerDtype } from '../examples/shared/data-values.js';

/** What the atlas holds for a raw value on the raw-value path, decoded back. */
const roundTrip = (raw: number) => float16BitsToFloat32(float32ToFloat16Bits(Math.max(-65504, Math.min(65504, raw))));

describe('value types', () => {
  it('supports int16 alongside the existing types', () => {
    expect([...SUPPORTED_DTYPES].sort()).toEqual(['float32', 'float64', 'int16', 'uint16', 'uint8']);
    expect(valueTypeFor('uint32')).toBeNull();
    expect(valueTypeFor('int8')).toBeNull();
  });

  it('keeps uint8/uint16 on the unorm path and puts int16 on the raw-value path', () => {
    expect(valueTypeFor('uint8')).toMatchObject({ bitDepth: 8, isFloat: false });
    expect(valueTypeFor('uint16')).toMatchObject({ bitDepth: 16, isFloat: false });
    expect(valueTypeFor('int16')).toMatchObject({ bitDepth: 16, isFloat: true });
  });

  it('starts int16 with a provisional range that culls nothing above the type minimum', () => {
    expect(provisionalDataRange('int16')).toEqual([-32768, -32767]);
    expect(provisionalDataRange('float32')).toEqual([0, 1]);
    expect(provisionalDataRange(undefined)).toEqual([0, 1]);
  });

  it('stores int16 CT values exactly up to ±2048 and within float16 steps above', () => {
    for (const hu of [-2048, -1024, -1000, -100, -1, 0, 1, 40, 400, 2047, 2048]) expect(roundTrip(hu)).toBe(hu);
    expect(Math.abs(roundTrip(3071) - 3071)).toBeLessThanOrEqual(2);
    expect(Math.abs(roundTrip(-32768) + 32768)).toBeLessThanOrEqual(32);
  });
});

describe('histogram on the raw-value path', () => {
  it('bins int16 raw values across a negative range', () => {
    const brick = Uint16Array.from([-1024, 0, 1024], v => float32ToFloat16Bits(v));
    const h = computeHistogram([brick], 16, 3, true, -1024, 1024, 'r16float');
    expect(Array.from(h)).toEqual([1, 1, 1]);
  });
});

describe('raw value display', () => {
  it('recognises integer dtypes', () => {
    expect(['uint8', 'uint16', 'int16'].every(isIntegerDtype)).toBe(true);
    expect(['float32', 'float64', undefined].some(isIntegerDtype)).toBe(false);
  });

  it('shows whole numbers for integer sources on the raw-value path', () => {
    const space = { isFloat: true, integer: true, bitDepth: 16 as const, floatMin: -1024, floatMax: 3071 };
    expect(formatRawValue(-1023.6, space)).toBe('-1024');
    expect(formatRawValue(40.2, space)).toBe('40');
    expect(formatRawValue(0.123, { ...space, integer: false })).toBe('0.123');
  });
});
