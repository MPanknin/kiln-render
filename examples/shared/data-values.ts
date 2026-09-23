/** Maps shader-normalized values (0–1) back to raw data values for display. */

export interface ValueSpace {
  isFloat: boolean;
  bitDepth: 8 | 16;
  /** Raw float range mapped to 0–1 (float32 sources only) */
  floatMin: number;
  floatMax: number;
}

// Integer sources are normalized by dtype max (the r8unorm fallback keeps the high byte)
export function toRawValue(n: number, space: ValueSpace): number {
  if (space.isFloat) return space.floatMin + n * (space.floatMax - space.floatMin);
  return n * (space.bitDepth === 16 ? 65535 : 255);
}

export function formatRawValue(raw: number, space: ValueSpace): string {
  if (!space.isFloat) return Math.round(raw).toString();
  return Math.abs(raw) >= 1e5 || (raw !== 0 && Math.abs(raw) < 1e-3)
    ? raw.toExponential(2)
    : Number(raw.toPrecision(4)).toString();
}
