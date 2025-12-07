/**
 * Volume canvas (atlas) and test volume generation
 */

import { ATLAS_SIZE } from './config.js';

export interface VolumeCanvas {
  texture: GPUTexture;
  size: number;
}

/**
 * Create empty volume canvas (512³)
 */
export function createVolumeCanvas(device: GPUDevice): VolumeCanvas {
  const texture = device.createTexture({
    size: [ATLAS_SIZE, ATLAS_SIZE, ATLAS_SIZE], // Use 528
    format: 'r8unorm',
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  return { texture, size: ATLAS_SIZE };
}

/**
 * Write volume data into canvas at specified offset
 */
export function writeToCanvas(
  device: GPUDevice,
  canvas: VolumeCanvas,
  data: Uint8Array,
  size: [number, number, number],
  offset: [number, number, number] = [0, 0, 0]
) {
  device.queue.writeTexture(
    { texture: canvas.texture, origin: offset },
    data,
    { bytesPerRow: size[0], rowsPerImage: size[1] },
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
