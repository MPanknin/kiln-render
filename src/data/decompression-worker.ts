/**
 * DecompressionWorker - Web Worker for off-main-thread gzip decompression
 *
 * This worker receives compressed brick data and decompresses it using fflate,
 * keeping the main thread free for rendering at 60+ FPS.
 */

import { gunzipSync } from 'fflate';

export interface DecompressRequest {
  id: number;
  data: ArrayBuffer;
  targetBitDepth?: 8 | 16;
}

export interface DecompressResponse {
  id: number;
  data: ArrayBuffer | null;
  error?: string;
}

// Worker message handler
self.onmessage = (event: MessageEvent<DecompressRequest>) => {
  const { id, data, targetBitDepth } = event.data;

  try {
    const compressed = new Uint8Array(data);
    let decompressed = gunzipSync(compressed);

    // Handle 16-bit → 8-bit conversion if needed
    if (targetBitDepth === 8 && decompressed.byteLength % 2 === 0) {
      // Assume decompressed data is 16-bit (Uint16) if we're asked for 8-bit output
      const uint16Data = new Uint16Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength / 2);
      const uint8Data = new Uint8Array(uint16Data.length);

      for (let i = 0; i < uint16Data.length; i++) {
        uint8Data[i] = (uint16Data[i] ?? 0) >> 8;
      }

      decompressed = uint8Data;
    }

    // Get the underlying ArrayBuffer for transfer
    const buffer = decompressed.buffer as ArrayBuffer;

    // Transfer ownership back to main thread (zero-copy)
    const response: DecompressResponse = {
      id,
      data: buffer,
    };
    (self as unknown as Worker).postMessage(response, [buffer]);
  } catch (error) {
    const response: DecompressResponse = {
      id,
      data: null,
      error: error instanceof Error ? error.message : 'Decompression failed',
    };
    (self as unknown as Worker).postMessage(response);
  }
};
