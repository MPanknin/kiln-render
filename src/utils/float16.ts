/**
 * Float16 conversion utilities
 *
 * WebGPU's r16float texture format stores data as IEEE 754 half-precision floats.
 * This module converts uint16 intensity values (0-65535) to normalized float16 format.
 *
 * Used by workers to convert 16-bit volume data to r16float when the GPU doesn't
 * support r16unorm but supports r16float (Firefox, some Linux drivers).
 */

/**
 * Convert a float32 value to float16 binary representation (as uint16)
 *
 * @param f32 - Input float32 value (typically 0.0-1.0 for normalized data)
 * @returns uint16 bits containing the IEEE 754 float16 representation
 */
export function float32ToFloat16Bits(f32: number): number {
  // Use DataView to read float32 as uint32 bits
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, f32, true);
  const bits = view.getUint32(0, true);

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

/**
 * Convert a Uint16Array (0-65535 integer values) to float16 binary format
 * for use with r16float textures.
 *
 * @param uint16Data - Input data as unsigned 16-bit integers (0-65535)
 * @returns Uint16Array containing float16 binary data (normalized to 0.0-1.0)
 */
export function uint16ToFloat16(uint16Data: Uint16Array): Uint16Array {
  const float16Data = new Uint16Array(uint16Data.length);

  for (let i = 0; i < uint16Data.length; i++) {
    const normalized = uint16Data[i]! / 65535.0;
    float16Data[i] = float32ToFloat16Bits(normalized);
  }

  return float16Data;
}
