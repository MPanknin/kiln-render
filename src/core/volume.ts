/**
 * Volume canvas (atlas) and test volume generation
 */

import { ATLAS_SIZE } from './config.js';
import type { BitDepth, BrickData } from '../data/data-provider.js';

export interface VolumeCanvas {
  texture: GPUTexture;
  size: number;
  bitDepth: BitDepth;
}

/**
 * Create empty volume canvas (atlas texture)
 * @param device - WebGPU device
 * @param bitDepth - 8 for uint8/r8unorm, 16 for uint16/r16unorm
 */
export function createVolumeCanvas(device: GPUDevice, bitDepth: BitDepth = 8): VolumeCanvas {
  const format: GPUTextureFormat = bitDepth === 16 ? 'r16unorm' : 'r8unorm';
  const texture = device.createTexture({
    size: [ATLAS_SIZE, ATLAS_SIZE, ATLAS_SIZE],
    format,
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  return { texture, size: ATLAS_SIZE, bitDepth };
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
