import { describe, it, expect } from 'vitest';
import { float32ToFloat16Bits, uint16ToFloat16 } from '../src/utils/float16.js';

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

  it('encodes 0 as float16 0.0', () => {
    const out = uint16ToFloat16(new Uint16Array([0]));
    expect(out[0]).toBe(0x0000);
  });

  it('encodes 65535 as float16 1.0', () => {
    const out = uint16ToFloat16(new Uint16Array([65535]));
    // 65535/65535 = 1.0 → float16 0x3c00
    expect(out[0]).toBe(0x3c00);
  });

  it('encodes midpoint 32768 to approximately 0.5', () => {
    const out = uint16ToFloat16(new Uint16Array([32768]));
    const decoded = float16BitsToFloat32(out[0]!);
    expect(decoded).toBeCloseTo(32768 / 65535, 2);
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
