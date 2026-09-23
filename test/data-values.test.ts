import { describe, it, expect } from 'vitest';
import { toRawValue, formatRawValue, type ValueSpace } from '../examples/shared/data-values.js';

const u8: ValueSpace = { isFloat: false, bitDepth: 8, floatMin: 0, floatMax: 1 };
const u16: ValueSpace = { isFloat: false, bitDepth: 16, floatMin: 0, floatMax: 1 };
const f32: ValueSpace = { isFloat: true, bitDepth: 16, floatMin: -2, floatMax: 6 };

describe('toRawValue', () => {
  it('scales integer data by dtype max', () => {
    expect(toRawValue(1, u8)).toBe(255);
    expect(toRawValue(0.5, u16)).toBeCloseTo(32767.5);
  });

  it('maps float data through the float range', () => {
    expect(toRawValue(0, f32)).toBe(-2);
    expect(toRawValue(0.25, f32)).toBe(0);
    expect(toRawValue(1, f32)).toBe(6);
  });
});

describe('formatRawValue', () => {
  it('rounds integer data', () => {
    expect(formatRawValue(1234.6, u16)).toBe('1235');
  });

  it('uses 4 significant digits or exponent for floats', () => {
    expect(formatRawValue(3.14159, f32)).toBe('3.142');
    expect(formatRawValue(0, f32)).toBe('0');
    expect(formatRawValue(123456, f32)).toBe('1.23e+5');
    expect(formatRawValue(0.00012, f32)).toBe('1.20e-4');
  });
});
