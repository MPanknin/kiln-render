/**
 * Histogram computation utilities for volume data analysis
 */

import type { BitDepth } from '../data/data-provider.js';
import { float16BitsToFloat32 } from '../utils/float16.js';

/**
 * Compute a histogram from multiple volume data arrays.
 *
 * - Standard uint8/uint16: pass nothing extra.
 * - Float32 source (r16float atlas): pass `isFloat32=true` + `floatMin`/`floatMax`
 *   so float16 bit-patterns are decoded and normalised with the correct range.
 * - Uint16 source stored as r16float: pass `targetFormat='r16float'`; float16
 *   bit-patterns encode [0,1] directly so no range remapping is needed.
 */
export function computeHistogram(
  dataArrays: (Uint8Array | Uint16Array)[],
  bitDepth: BitDepth,
  bins: number = 256,
  isFloat32 = false,
  floatMin = 0,
  floatMax = 1,
  targetFormat: GPUTextureFormat = 'r16unorm',
): Uint32Array {
  const histogram = new Uint32Array(bins);
  const floatRange = floatMax - floatMin;
  // uint16 source stored as r16float: float16 bits encode [0,1], decode directly
  const isUint16AsFloat16 = !isFloat32 && bitDepth === 16 && targetFormat === 'r16float';

  for (const data of dataArrays) {
    if (bitDepth === 16 && (isFloat32 || isUint16AsFloat16)) {
      // Decode float16 bit-patterns; for isFloat32 apply floatMin/floatMax range.
      for (let i = 0; i < data.length; i++) {
        const rawFloat = float16BitsToFloat32(data[i]!);
        if (!isFinite(rawFloat)) continue;
        const normalized = isFloat32 && floatRange > 0
          ? Math.max(0, Math.min(1, (rawFloat - floatMin) / floatRange))
          : Math.max(0, Math.min(1, rawFloat));
        const bin = Math.floor(normalized * (bins - 1));
        histogram[bin] = (histogram[bin] ?? 0) + 1;
      }
    } else {
      // Standard uint8/uint16 path
      const maxValue = bitDepth === 16 ? 65535 : 255;
      for (let i = 0; i < data.length; i++) {
        const bin = Math.floor((data[i]! / maxValue) * (bins - 1));
        if (bin >= 0 && bin < bins) {
          histogram[bin] = (histogram[bin] ?? 0) + 1;
        }
      }
    }
  }

  return histogram;
}
