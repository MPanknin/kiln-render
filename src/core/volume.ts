/**
 * Volume canvas (atlas) and test volume generation
 */

import { ATLAS_SIZE } from './config.js';
import type { BitDepth, BrickData } from '../data/data-provider.js';

export interface VolumeCanvas {
  texture: GPUTexture;
  size: number;
  bitDepth: BitDepth;
  format: GPUTextureFormat;
}

/**
 * Detect best supported texture format for 16-bit data
 * Tries formats in order of preference: r16unorm → r16float → r8unorm (fallback)
 */
export function detectBest16BitFormat(device: GPUDevice): GPUTextureFormat {
  const formats: GPUTextureFormat[] = ['r16unorm', 'r16float'];

  for (const format of formats) {
    try {
      const testTexture = device.createTexture({
        size: [1, 1, 1],
        format,
        dimension: '3d',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      testTexture.destroy();
      console.log(`[Kiln] Using ${format} for 16-bit atlas texture`);
      return format;
    } catch (e) {
      console.warn(`[Kiln] Format ${format} not supported, trying next...`);
    }
  }

  // Eventually downgrade to 8-bit
  console.warn('[Kiln] No 16-bit formats supported, falling back to r8unorm (quality loss)');
  return 'r8unorm';
}

/**
 * Create empty volume canvas (atlas texture)
 * @param device - WebGPU device
 * @param bitDepth - Effective bit depth (8 or 16) 
 * @param format - Texture format to use (r8unorm, r16unorm, or r16float)
 */
export function createVolumeCanvas(device: GPUDevice, bitDepth: BitDepth, format: GPUTextureFormat): VolumeCanvas {
  const texture = device.createTexture({
    size: [ATLAS_SIZE, ATLAS_SIZE, ATLAS_SIZE],
    format,
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  return { texture, size: ATLAS_SIZE, bitDepth, format };
}

/**
 * Write volume data into canvas at specified offset
 * Handles both 8-bit and 16-bit data based on canvas bitDepth
  */
export function writeToCanvas(
  device: GPUDevice,
  canvas: VolumeCanvas,
  data: BrickData,
  size: [number, number, number],
  offset: [number, number, number] = [0, 0, 0]
) {
  const bytesPerVoxel = canvas.bitDepth === 16 ? 2 : 1;
  device.queue.writeTexture(
    { texture: canvas.texture, origin: offset },
    data.buffer,
    {
      offset: data.byteOffset,
      bytesPerRow: size[0] * bytesPerVoxel,
      rowsPerImage: size[1]
    },
    size
  );
}

/**
 * Generate test volume data with centered sphere
 */
export function generateSphereVolume(size: number, radius: number, intensity: number): Uint8Array {
  const data = new Uint8Array(size * size * size);

  const cx = size * 0.5;
  const cy = size * 0.5;
  const cz = size * 0.5;

  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < radius) {
          data[x + y * size + z * size * size] = intensity;
        }
      }
    }
  }

  return data;
}

/**
 * Generate solid volume with uniform intensity
 */
export function generateSolidVolume(size: [number, number, number], intensity: number): Uint8Array {
  const [w, h, d] = size;
  const data = new Uint8Array(w * h * d);
  data.fill(intensity);
  return data;
}
