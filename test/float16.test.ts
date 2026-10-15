import { describe, it, expect } from 'vitest';
import {
  float32ToFloat16Bits,
  uint16ToFloat16,
  getUint16ToFloat16Lut,
  getFloat16ToFloat32Lut,
  UINT16_FLOAT16_OFFSET,
} from '../src/utils/float16.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode a float16 bit pattern back to a float32 number for assertions. */
function float16BitsToFloat32(bits: number): number {
  const sign = (bits >> 15) & 0x1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;

  if (exp === 0x1f) {
    return frac ? NaN : (sign ? -Infinity : Infinity);
  }
  if (exp === 0) {
    // Denormal or zero
    return (sign ? -1 : 1) * frac * Math.pow(2, -24);
  }
  return (sign ? -1 : 1) * (1 + frac / 1024) * Math.pow(2, exp - 15);
}

// ---------------------------------------------------------------------------
// float32ToFloat16Bits
// ---------------------------------------------------------------------------

describe('float32ToFloat16Bits', () => {
  it('encodes 0.0 as all-zero bits', () => {
    expect(float32ToFloat16Bits(0.0)).toBe(0x0000);
  });

  it('encodes 1.0 correctly (sign=0, exp=15, frac=0)', () => {
    // float16 1.0 = 0 01111 0000000000 = 0x3c00
    expect(float32ToFloat16Bits(1.0)).toBe(0x3c00);
  });

  it('encodes 0.5 correctly', () => {
    // float16 0.5 = 0 01110 0000000000 = 0x3800
    expect(float32ToFloat16Bits(0.5)).toBe(0x3800);
  });

  it('round-trips representative values via decode helper', () => {
    const samples = [0.0, 0.25, 0.5, 0.75, 1.0];
    for (const v of samples) {
      const bits = float32ToFloat16Bits(v);
      const decoded = float16BitsToFloat32(bits);
      expect(decoded).toBeCloseTo(v, 2);
    }
  });

  it('encodes positive infinity', () => {
    expect(float32ToFloat16Bits(Infinity)).toBe(0x7c00);
  });

  it('encodes NaN as a NaN bit pattern', () => {
    const bits = float32ToFloat16Bits(NaN);
    // NaN: exponent all-ones, non-zero mantissa
    expect((bits & 0x7c00)).toBe(0x7c00);
    expect((bits & 0x03ff)).not.toBe(0);
  });

  it('saturates to infinity on overflow (value >> 65504)', () => {
    const bits = float32ToFloat16Bits(1e10);
    expect(bits).toBe(0x7c00); // +infinity
  });

  it('flushes very small values to zero (underflow)', () => {
    const bits = float32ToFloat16Bits(1e-10);
    expect(bits).toBe(0x0000);
  });
});

// ---------------------------------------------------------------------------
// uint16ToFloat16
// ---------------------------------------------------------------------------

describe('uint16ToFloat16', () => {
  it('returns same-length Uint16Array', () => {
    const input = new Uint16Array([0, 32768, 65535]);
    const output = uint16ToFloat16(input);
    expect(output).toBeInstanceOf(Uint16Array);
    expect(output.length).toBe(input.length);
  });

  /** Decode a stored texel back to the uint16 value it encodes. */
  const decode = (bits: number) => float16BitsToFloat32(bits) + UINT16_FLOAT16_OFFSET;

  it('encodes 0 as -offset', () => {
    const out = uint16ToFloat16(new Uint16Array([0]));
    expect(float16BitsToFloat32(out[0]!)).toBe(-UINT16_FLOAT16_OFFSET);
  });

  it('round-trips every value up to 4096 exactly, so 12-bit data is lossless', () => {
    const values = Uint16Array.from({ length: 4097 }, (_, i) => i);
    const out = uint16ToFloat16(values);
    for (let i = 0; i < values.length; i++) expect(decode(out[i]!)).toBe(i);
  });

  it('stays within one float16 step above 4096', () => {
    const out = uint16ToFloat16(new Uint16Array([32768, 65535]));
    expect(decode(out[0]!)).toBe(32768);
    expect(Math.abs(decode(out[1]!) - 65535)).toBeLessThanOrEqual(32);
  });

  it('preserves monotonic ordering across the full range', () => {
    // Sample 256 evenly spaced values — decoded float should be monotonically increasing
    const step = 256;
    const values: number[] = [];
    for (let i = 0; i <= 65535; i += step) values.push(i);

    const input = new Uint16Array(values);
    const output = uint16ToFloat16(input);

    for (let i = 1; i < output.length; i++) {
      const prev = float16BitsToFloat32(output[i - 1]!);
      const curr = float16BitsToFloat32(output[i]!);
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it('handles an empty array', () => {
    const out = uint16ToFloat16(new Uint16Array(0));
    expect(out.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LUTs — must be bit-identical to the scalar conversion path
// ---------------------------------------------------------------------------

describe('getUint16ToFloat16Lut', () => {
  it('matches float32ToFloat16Bits(i - offset) for all 65536 values', () => {
    const lut = getUint16ToFloat16Lut();
    for (let i = 0; i < 65536; i++) {
      expect(lut[i]).toBe(float32ToFloat16Bits(i - UINT16_FLOAT16_OFFSET));
    }
  });
});

describe('getFloat16ToFloat32Lut', () => {
  it('matches float16BitsToFloat32(i) for all 65536 bit patterns', () => {
    const lut = getFloat16ToFloat32Lut();
    for (let i = 0; i < 65536; i++) {
      const expected = float16BitsToFloat32(i);
      if (Number.isNaN(expected)) {
        expect(Number.isNaN(lut[i]!)).toBe(true);
      } else {
        expect(lut[i]).toBe(expected);
      }
    }
  });
});
