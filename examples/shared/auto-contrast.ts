/** Percentile-based auto-contrast over a normalized (0–1) histogram. */

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
