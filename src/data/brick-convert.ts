/** Source-dtype-aware conversion of raw brick bytes to the atlas texture format. */

import { uint16ToFloat16 } from '../utils/float16.js';

export type SourceFormat = 'uint8' | 'uint16';
export type TargetFormat = 'r8unorm' | 'r16unorm' | 'r16float';

/** Convert raw bytes of `source` dtype to the element type the `target` texture expects. */
export function convertBrickBytes(raw: Uint8Array, source: SourceFormat, target: TargetFormat): Uint8Array | Uint16Array {
  if (source === 'uint8') return raw;
  const u16 = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
  if (target === 'r8unorm') {
    const out = new Uint8Array(u16.length);
    for (let i = 0; i < u16.length; i++) out[i] = u16[i]! >> 8;
    return out;
  }
  if (target === 'r16float') return uint16ToFloat16(u16);
  return u16;
}

/** Re-view already converted bytes with the element size the conversion produced. */
export function brickElementView(bytes: Uint8Array, source: SourceFormat, target: TargetFormat): Uint8Array | Uint16Array {
  const is16 = source === 'uint16' && target !== 'r8unorm';
  return is16 ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1) : bytes;
}
