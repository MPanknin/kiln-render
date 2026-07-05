/**
 * Float16 conversion utilities — converts uint16 intensity values (0-65535)
 * to IEEE 754 half-precision for WebGPU's r16float texture format.
 */

/** Convert a float32 value to float16 binary representation (as uint16). */
// Module-level scratch buffers — shared across all calls to avoid per-call allocation
const _f32Scratch = new Float32Array(1);
const _u32Scratch = new Uint32Array(_f32Scratch.buffer);

export function float32ToFloat16Bits(f32: number): number {
  // Write float32 into the shared scratch buffer and read back as uint32 bits.
  // Avoids allocating a new ArrayBuffer + DataView on every call (287k calls per brick).
  _f32Scratch[0] = f32;
  const bits = _u32Scratch[0]!;

  // Extract IEEE 754 float32 components
  const sign = (bits >> 31) & 0x1;
  let exp = (bits >> 23) & 0xff;
  let frac = bits & 0x7fffff;

  // Handle special cases
  if (exp === 0xff) {
    // Infinity or NaN
    return (sign << 15) | 0x7c00 | (frac ? 1 : 0);
  }

  if (exp === 0) {
    // Zero or denormal
    return sign << 15;
  }

  // Rebias exponent: float32 bias=127, float16 bias=15
  exp = exp - 127 + 15;

  if (exp >= 0x1f) {
    // Overflow to infinity
    return (sign << 15) | 0x7c00;
  }

  if (exp <= 0) {
    // Underflow to zero
    return sign << 15;
  }

  // Normal case: pack into float16 format
  // Sign (1 bit) | Exponent (5 bits) | Mantissa (10 bits)
  frac = frac >> 13; // Keep top 10 bits of mantissa
  return (sign << 15) | (exp << 10) | frac;
}

/** Decode a uint16 float16 bit pattern to a JavaScript number. */
export function float16BitsToFloat32(bits: number): number {
  const sign = (bits >> 15) & 0x1;
  const exp  = (bits >> 10) & 0x1f;
  const mant =  bits        & 0x3ff;

  if (exp === 0) {
    // Subnormal: (-1)^s * 2^-14 * (mant / 1024)
    return (sign ? -1 : 1) * Math.pow(2, -14) * (mant / 1024);
  }
  if (exp === 31) {
    // Infinity or NaN
    return mant ? NaN : (sign ? -Infinity : Infinity);
  }
  // Normal: (-1)^s * 2^(exp-15) * (1 + mant/1024)
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + mant / 1024);
}

/** Convert a Uint16Array (0-65535) to float16 binary format for r16float textures. */
export function uint16ToFloat16(uint16Data: Uint16Array): Uint16Array {
  const float16Data = new Uint16Array(uint16Data.length);

  for (let i = 0; i < uint16Data.length; i++) {
    const normalized = uint16Data[i]! / 65535.0;
    float16Data[i] = float32ToFloat16Bits(normalized);
  }

  return float16Data;
}
