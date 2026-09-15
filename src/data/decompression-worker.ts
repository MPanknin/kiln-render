/** DecompressionWorker - Off-main-thread gzip decompression via fflate. */

import { gunzipSync } from 'fflate';
import { convertBrickBytes } from './brick-convert.js';
import type { SourceFormat, TargetFormat } from './brick-convert.js';

export interface DecompressRequest {
  id: number;
  data: ArrayBuffer;
  /** Source voxel dtype; without it no conversion is applied. */
  sourceFormat?: SourceFormat;
  /** Target texture format: r8unorm (8-bit), r16unorm (16-bit uint), r16float (16-bit float) */
  targetFormat?: TargetFormat;
}

export interface DecompressResponse {
  id: number;
  data: ArrayBuffer | null;
  error?: string;
}

// Worker message handler
self.onmessage = (event: MessageEvent<DecompressRequest>) => {
  const { id, data, sourceFormat, targetFormat } = event.data;

  try {
    const decompressed = gunzipSync(new Uint8Array(data));
    const converted = convertBrickBytes(decompressed, sourceFormat ?? 'uint8', targetFormat ?? 'r16unorm');

    // Get the underlying ArrayBuffer for transfer
    const buffer = converted.buffer instanceof ArrayBuffer
      ? converted.buffer
      : converted.buffer.slice(0);

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
