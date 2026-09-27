/** Maps shader-normalized values (0–1) back to raw data values for display. */

export interface ValueSpace {
  isFloat: boolean;
  /** Integer source on the raw-value path (int16): show whole numbers */
  integer?: boolean;
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
  if (!space.isFloat || (space.integer && Math.abs(raw) < 1e5)) return Math.round(raw).toString();
  return Math.abs(raw) >= 1e5 || (raw !== 0 && Math.abs(raw) < 1e-3)
    ? raw.toExponential(2)
    : Number(raw.toPrecision(4)).toString();
}

/** Whether a source dtype holds integers (uint8/uint16/int16…), from VolumeMetadata.dtype. */
export function isIntegerDtype(dtype: string | undefined): boolean {
  return !!dtype && /^u?int\d+$/.test(dtype);
}
