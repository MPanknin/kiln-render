/**
 * Histogram computation utilities for volume data analysis
 */

import type { BitDepth } from '../data/data-provider.js';

/**
 * Compute a histogram from multiple volume data arrays
 *
 * @param dataArrays - Array of volume data arrays to combine
 * @param bitDepth - Bit depth of the data (8 or 16)
 * @param bins - Number of histogram bins (default: 256)
 * @returns Histogram as Uint32Array with bin counts
 */
export function computeHistogram(
  dataArrays: (Uint8Array | Uint16Array)[],
  bitDepth: BitDepth,
  bins: number = 256
): Uint32Array {
  const histogram = new Uint32Array(bins);
  const maxValue = bitDepth === 16 ? 65535 : 255;

  // Accumulate histogram from all data arrays
  for (const data of dataArrays) {
    for (let i = 0; i < data.length; i++) {
      const value = data[i]!;
      const bin = Math.floor((value / maxValue) * (bins - 1));
      if (bin >= 0 && bin < bins) {
        histogram[bin] = (histogram[bin] ?? 0) + 1;
      }
    }
  }

  return histogram;
}
