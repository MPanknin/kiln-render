/**
 * Histogram computation utilities for volume data analysis
 */

import type { BitDepth } from '../data/data-provider.js';
import { getFloat16ToFloat32Lut, UINT16_FLOAT16_OFFSET } from '../utils/float16.js';

/** Counts indexed by the stored voxel value: uint8, uint16, or float16 bit pattern. */
export interface RawHistogram {
  counts: Uint32Array;
  /** Data arrived as Uint8Array (0–255) rather than Uint16Array. */
  is8Bit: boolean;
}

export function createRawHistogram(is8Bit: boolean): RawHistogram {
  return { counts: new Uint32Array(is8Bit ? 256 : 65536), is8Bit };
}

/** Add every voxel of a brick to the raw counts (one increment per voxel, no decoding). */
export function accumulateRaw(hist: RawHistogram, data: Uint8Array | Uint16Array): void {
  const counts = hist.counts;
  for (let i = 0; i < data.length; i++) counts[data[i]!]!++;
}

/** Maps a stored value to shader space (0–1), or null for non-finite floats. */
function unitMapper(
  is8Bit: boolean,
  bitDepth: BitDepth,
  isFloat32: boolean,
  floatMin: number,
  floatMax: number,
  targetFormat: GPUTextureFormat,
): (raw: number) => number | null {
  // uint16 source stored as r16float: float16 bits encode value - UINT16_FLOAT16_OFFSET
  const isUint16AsFloat16 = !isFloat32 && bitDepth === 16 && targetFormat === 'r16float';
  if (!is8Bit && bitDepth === 16 && (isFloat32 || isUint16AsFloat16)) {
    const lut = getFloat16ToFloat32Lut();
    const floatRange = floatMax - floatMin;
    return (raw) => {
      const v = lut[raw]!;
      if (!isFinite(v)) return null;
      const n = !isFloat32 ? (v + UINT16_FLOAT16_OFFSET) / 65535
        : floatRange > 0 ? (v - floatMin) / floatRange : v;
      return Math.max(0, Math.min(1, n));
    };
  }
  // Integer path: the ACTUAL array type sets the range — on the r8unorm fallback
  // a 16-bit source arrives as Uint8Array in 0-255 space.
  const maxValue = is8Bit ? 255 : 65535;
  return (raw) => raw / maxValue;
}

/** Rebin raw counts onto `bins` equal shader-space (0–1) bins. */
export function rebinHistogram(
  raw: RawHistogram,
  bitDepth: BitDepth,
  bins: number = 256,
  isFloat32 = false,
  floatMin = 0,
  floatMax = 1,
  targetFormat: GPUTextureFormat = 'r16unorm',
): Uint32Array {
  const histogram = new Uint32Array(bins);
  const toUnit = unitMapper(raw.is8Bit, bitDepth, isFloat32, floatMin, floatMax, targetFormat);
  const counts = raw.counts;
  for (let v = 0; v < counts.length; v++) {
    const c = counts[v]!;
    if (c === 0) continue;
    const n = toUnit(v);
    if (n === null) continue;
    histogram[Math.floor(n * (bins - 1))]! += c;
  }
  return histogram;
}

/**
 * Compute a histogram from volume data arrays. Handles uint8/uint16 directly,
 * float32-as-r16float (with range remapping), and uint16-as-r16float.
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
  const first = dataArrays[0];
  if (!first) return new Uint32Array(bins);
  const raw = createRawHistogram(first instanceof Uint8Array);
  for (const data of dataArrays) accumulateRaw(raw, data);
  return rebinHistogram(raw, bitDepth, bins, isFloat32, floatMin, floatMax, targetFormat);
}

// Finite float16 bit patterns sorted by value; built on first use.
let float16Order: Uint16Array | null = null;
function sortedFloat16(): Uint16Array {
  if (!float16Order) {
    const lut = getFloat16ToFloat32Lut();
    const codes = Array.from({ length: 65536 }, (_, i) => i).filter(i => isFinite(lut[i]!));
    float16Order = Uint16Array.from(codes.sort((a, b) => lut[a]! - lut[b]!));
  }
  return float16Order;
}

/**
 * Values at the quantiles `lo` and `hi` (0–1) of float16 voxels, from their raw counts (see
 * accumulateRaw). Exact: every stored value is one of the 65536 bit patterns, so outliers
 * can't coarsen the result. Non-finite values are ignored; null without finite voxels.
 */
export function float16Quantiles(counts: Uint32Array, lo: number, hi: number): [number, number] | null {
  const lut = getFloat16ToFloat32Lut();
  const order = sortedFloat16();
  let total = 0;
  for (const code of order) total += counts[code]!;
  if (total === 0) return null;
  let seen = 0;
  let low = NaN;
  for (const code of order) {
    seen += counts[code]!;
    if (Number.isNaN(low) && seen > total * lo) low = lut[code]!;
    if (seen >= total * hi) return [low, lut[code]!];
  }
  return [low, lut[order[order.length - 1]!]!];
}

/** Number of distinct float16 values in [lo, hi]: how finely the atlas resolves that range. */
export function float16Levels(lo: number, hi: number): number {
  const lut = getFloat16ToFloat32Lut();
  const order = sortedFloat16();
  // Number of sorted values for which `before` holds (a prefix of the order)
  const prefix = (before: (v: number) => boolean) => {
    let a = 0, b = order.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (before(lut[order[m]!]!)) a = m + 1; else b = m;
    }
    return a;
  };
  const zeros = lo <= 0 && hi >= 0 ? 1 : 0; // +0 and -0 are one value
  return Math.max(0, prefix(v => v <= hi) - prefix(v => v < lo) - zeros);
}
