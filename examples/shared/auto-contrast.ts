/** Percentile-based auto-contrast over a normalized (0–1) histogram. */

import { toRawValue, type ValueSpace } from './data-values.js';

// Fine enough that 12-bit data stored in 16-bit still gets a tight window
export const AUTO_CONTRAST_BINS = 4096;

/** Window spanning the lo..hi percentiles of the histogram; null if nothing to measure. */
export function percentileWindow(
  histogram: Uint32Array,
  lo = 0.005,
  hi = 0.995,
): { center: number; width: number } | null {
  const bins = histogram.length;
  // Bin 0 is skipped so zero padding and empty background don't drag the lower bound down
  let total = 0;
  for (let i = 1; i < bins; i++) total += histogram[i]!;
  if (total === 0) return null;

  let loBin = -1;
  let hiBin = bins - 1;
  let count = 0;
  for (let i = 1; i < bins; i++) {
    count += histogram[i]!;
    if (loBin < 0 && count >= total * lo) loBin = i;
    if (count >= total * hi) { hiBin = i; break; }
  }

  // Bin b holds values in [b, b+1) / (bins - 1), matching computeHistogram
  const min = loBin / (bins - 1);
  const max = Math.min(1, (hiBin + 1) / (bins - 1));
  const width = Math.max(0.001, max - min);
  return { center: min + width / 2, width };
}

/**
 * Upper bound for window sliders, in shader units: just above the bulk of the data
 * (p99.95 with headroom), never below `atLeast` so current handles stay reachable.
 */
export function sliderDomain(histogram: Uint32Array, atLeast = 0): number {
  const bins = histogram.length;
  let total = 0;
  for (let i = 1; i < bins; i++) total += histogram[i]!;
  if (total === 0) return 1;
  let hiBin = bins - 1;
  let count = 0;
  for (let i = 1; i < bins; i++) {
    count += histogram[i]!;
    if (count >= total * 0.9995) { hiBin = i; break; }
  }
  const hi = (hiBin + 1) / (bins - 1);
  return Math.min(1, Math.max(atLeast, hi * 1.5));
}

/** Round up to two significant digits (1480 → 1500, 0.0312 → 0.032). */
export function niceCeil(x: number): number {
  if (!(x > 0) || !isFinite(x)) return x;
  const step = 10 ** (Math.floor(Math.log10(x)) - 1);
  return Math.ceil(x / step - 1e-9) * step;
}

/**
 * Slider range for window controls: tight around the data when a histogram is known,
 * otherwise a little above the current window; the raw upper value is a round number.
 */
export function windowDomain(
  histogram: Uint32Array | null,
  atLeast: number,
  space: ValueSpace,
): { max: number; step: number } {
  const target = histogram ? sliderDomain(histogram, atLeast) : Math.min(1, atLeast * 1.25);
  const span = toRawValue(1, space) - toRawValue(0, space);
  const max = target > 0 && span > 0 ? Math.min(1, niceCeil(target * span) / span) : 1;
  return { max, step: max / 400 };
}
