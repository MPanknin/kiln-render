/**
 * Source data types Kiln can render, and how each maps onto GPU storage.
 *
 * - unorm path (isFloat false): uint8 → r8unorm, uint16 → r16float of value/65535.
 *   The shader sees the value normalised by the dtype range.
 * - raw-value path (isFloat true): the atlas stores raw values as float16 and the shader
 *   normalises with the data range (derived from the coarsest level, or OMERO). float32/float64
 *   always took this path; int16 takes it too, since unorm can't hold negative values.
 */

import type { BitDepth } from './data-provider.js';

export interface ValueType {
  /** Bit depth of the stored atlas texel (8 → r8unorm, 16 → r16float). */
  bitDepth: BitDepth;
  /** Raw-value path: float16 raw values normalised by the data range in the shader. */
  isFloat: boolean;
  /**
   * Data range used until the real one is derived from the coarsest level. It only gates
   * empty-brick culling of the base level: [dtypeMin, dtypeMin + 1] counts every value above
   * the type's minimum as signal, so negative-valued regions (fat in CT) are never culled.
   */
  provisionalRange?: [number, number];
}

const VALUE_TYPES: Record<string, ValueType> = {
  uint8: { bitDepth: 8, isFloat: false },
  uint16: { bitDepth: 16, isFloat: false },
  int16: { bitDepth: 16, isFloat: true, provisionalRange: [-32768, -32767] },
  float32: { bitDepth: 16, isFloat: true, provisionalRange: [0, 1] },
  float64: { bitDepth: 16, isFloat: true, provisionalRange: [0, 1] },
};

export const SUPPORTED_DTYPES = Object.keys(VALUE_TYPES);

/** Storage mapping for a zarrita dtype string, or null when unsupported. */
export function valueTypeFor(dtype: string): ValueType | null {
  return VALUE_TYPES[dtype] ?? null;
}

/** Range to use on the raw-value path until the real one is derived (see ValueType.provisionalRange). */
export function provisionalDataRange(dtype: string | undefined): [number, number] {
  const range = (dtype && VALUE_TYPES[dtype]?.provisionalRange) || [0, 1];
  return [range[0], range[1]];
}
