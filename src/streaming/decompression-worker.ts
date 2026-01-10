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
}

export interface DecompressResponse {
  id: number;
  data: ArrayBuffer | null;
  error?: string;
}

// Worker message handler
self.onmessage = (event: MessageEvent<DecompressRequest>) => {
  const { id, data } = event.data;

  try {
    const compressed = new Uint8Array(data);
    const decompressed = gunzipSync(compressed);

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
