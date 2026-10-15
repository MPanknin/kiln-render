/**
 * Float16 conversion utilities — converts uint16 intensity values (0-65535)
 * to IEEE 754 half-precision for WebGPU's r16float texture format.
 */

/**
 * uint16 data on an r16float atlas is stored as `value - UINT16_FLOAT16_OFFSET`.
 * Half floats hold every integer in [-2048, 2048] exactly, so values 0–4096
 * (all of 12-bit data) survive bit-exact; above that, precision is at least that
 * of a plain value/65535 encoding. The shader maps texels back to value/65535
 * (see Renderer.texelScale/texelBias).
 */
export const UINT16_FLOAT16_OFFSET = 2048;

// Module-level scratch buffers — shared across all calls to avoid per-call allocation
const _f32Scratch = new Float32Array(1);
const _u32Scratch = new Uint32Array(_f32Scratch.buffer);

/**
 * Convert a float32 value to float16 bits (as uint16), rounding to nearest even (the IEEE
 * default). Values below 2^-14 become subnormals, values from 65520 up become infinity.
 */
export function float32ToFloat16Bits(f32: number): number {
  // Write float32 into the shared scratch buffer and read back as uint32 bits.
  // Avoids allocating a new ArrayBuffer + DataView on every call (287k calls per brick).
  _f32Scratch[0] = f32;
  const bits = _u32Scratch[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const abs = bits & 0x7fffffff;

  if (abs >= 0x47800000) {
    // 2^16 and above, Infinity or NaN
    return sign | (abs > 0x7f800000 ? 0x7e00 : 0x7c00);
  }

  if (abs < 0x38800000) {
    // Below 2^-14: subnormal or zero. Adding 0.5 puts the 10 subnormal mantissa bits at the
    // bottom of the float32 mantissa, and the float32 store rounds to nearest even.
    _f32Scratch[0] = Math.abs(_f32Scratch[0]!) + 0.5;
    return sign | (_u32Scratch[0]! - 0x3f000000);
  }

  // Normal: rebias the exponent (127 → 15) and round the dropped 13 bits to nearest even.
  // A carry out of the mantissa bumps the exponent, up to infinity from 65520.
  const mantOdd = (abs >>> 13) & 1;
  return sign | ((abs - 0x38000000 + 0xfff + mantOdd) >>> 13);
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

// Encode LUT: uint16 intensity (0-65535) → float16 bits of (value - offset). 128 KB.
let _u16ToF16Lut: Uint16Array | null = null;

/** Lazily-built LUT mapping a raw uint16 intensity to its stored r16float bit pattern. */
export function getUint16ToFloat16Lut(): Uint16Array {
  if (!_u16ToF16Lut) {
    _u16ToF16Lut = new Uint16Array(65536);
    for (let i = 0; i < 65536; i++) _u16ToF16Lut[i] = float32ToFloat16Bits(i - UINT16_FLOAT16_OFFSET);
  }
  return _u16ToF16Lut;
}

// Decode LUT: float16 bit pattern → float32. 256 KB.
let _f16ToF32Lut: Float32Array | null = null;

/** Lazily-built LUT mapping every float16 bit pattern to its decoded float32 value. */
export function getFloat16ToFloat32Lut(): Float32Array {
  if (!_f16ToF32Lut) {
    _f16ToF32Lut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) _f16ToF32Lut[i] = float16BitsToFloat32(i);
  }
  return _f16ToF32Lut;
}

/** Convert a Uint16Array (0-65535) to its stored r16float bit patterns (value - offset). */
export function uint16ToFloat16(uint16Data: Uint16Array): Uint16Array {
  const lut = getUint16ToFloat16Lut();
  const float16Data = new Uint16Array(uint16Data.length);

  for (let i = 0; i < uint16Data.length; i++) {
    float16Data[i] = lut[uint16Data[i]!]!;
  }

  return float16Data;
}
