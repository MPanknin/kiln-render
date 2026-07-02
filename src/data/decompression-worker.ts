/**
 * DecompressionWorker - Web Worker for off-main-thread gzip decompression
 *
 * This worker receives compressed brick data and decompresses it using fflate,
 * keeping the main thread free for rendering at 60+ FPS.
 */

import { gunzipSync } from 'fflate';
import { uint16ToFloat16 } from '../utils/float16.js';

export interface DecompressRequest {
  id: number;
  data: ArrayBuffer;
  /** Target texture format: r8unorm (8-bit), r16unorm (16-bit uint), r16float (16-bit float) */
  targetFormat?: 'r8unorm' | 'r16unorm' | 'r16float';
}

export interface DecompressResponse {
  id: number;
  data: ArrayBuffer | null;
  error?: string;
}

// Worker message handler
self.onmessage = (event: MessageEvent<DecompressRequest>) => {
  const { id, data, targetFormat } = event.data;

  try {
    const compressed = new Uint8Array(data);
    let decompressed: Uint8Array | Uint16Array = gunzipSync(compressed);

    // Handle format conversions based on targetFormat
    if (targetFormat === 'r8unorm' && decompressed.byteLength % 2 === 0) {
      // 16-bit → 8-bit conversion (downsample for r8unorm fallback)
      const uint16Data = new Uint16Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength / 2);
      const uint8Data = new Uint8Array(uint16Data.length);

      for (let i = 0; i < uint16Data.length; i++) {
        uint8Data[i] = (uint16Data[i] ?? 0) >> 8;
      }

      decompressed = uint8Data;
    } else if (targetFormat === 'r16float' && decompressed.byteLength % 2 === 0) {
      // 16-bit uint → float16 conversion (for r16float texture format)
      const uint16Data = new Uint16Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength / 2);
      const float16Data = uint16ToFloat16(uint16Data);
      decompressed = float16Data;
    }
    // else: r16unorm or already 8-bit - no conversion needed

    // Get the underlying ArrayBuffer for transfer
    const buffer = decompressed.buffer instanceof ArrayBuffer
      ? decompressed.buffer
      : decompressed.buffer.slice(0);

    // Transfer ownership back to main thread (zero-copy)
    const response: DecompressResponse = {
      id,
      data: buffer as ArrayBuffer,
    };
    (self as unknown as Worker).postMessage(response, [buffer as ArrayBuffer]);
  } catch (error) {
    const response: DecompressResponse = {
      id,
      data: null,
      error: error instanceof Error ? error.message : 'Decompression failed',
    };
    (self as unknown as Worker).postMessage(response);
  }
};
