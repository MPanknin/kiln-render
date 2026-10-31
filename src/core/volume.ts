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
 * Detect best supported texture format for 16-bit data.
 * uint16 uses r16unorm only if the device validates it as a filterable 3D texture.
 * texture-formats-tier1 alone permits unfilterable r16unorm textures.
 * Otherwise, and for raw-value data (int16/float), r16float; r8unorm as a last resort.
 */
export async function detectBest16BitFormat(device: GPUDevice, isFloat = false): Promise<GPUTextureFormat> {
  const formats: GPUTextureFormat[] = !isFloat && device.features.has('texture-formats-tier1')
    ? ['r16unorm', 'r16float', 'r8unorm']
    : ['r16float', 'r8unorm'];

  for (const format of formats) {
    let testTexture: GPUTexture | undefined;
    let threw = false;
    device.pushErrorScope('validation');
    try {
      testTexture = device.createTexture({
        label: `Kiln ${format} filtering probe`,
        size: [1, 1, 1],
        format,
        dimension: '3d',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const layout = device.createBindGroupLayout({
        entries: [{
          binding: 0,
          visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '3d' },
        }],
      });
      device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: testTexture.createView() }],
      });
    } catch (_) {
      threw = true;
    }
    // Validation errors are asynchronous; try/catch alone cannot detect an invalid
    // texture or bind group. Pop before awaiting so concurrent initialisation cannot
    // interleave scopes on this shared device.
    const validation = device.popErrorScope();
    let error: GPUError | null;
    try {
      error = await validation;
    } finally {
      testTexture?.destroy();
    }
    if (!threw && !error) {
      console.log(`[Kiln] Using ${format} for 16-bit atlas texture`);
      return format;
    }
    console.info(`[Kiln] ${format} cannot be used as a filterable 3D atlas; trying next format.`);
  }

  throw new Error('[Kiln] No filterable atlas texture format is available');
}

/** Create empty volume canvas (atlas texture). Size defaults to the full ATLAS_SIZE. */
export function createVolumeCanvas(device: GPUDevice, bitDepth: BitDepth, format: GPUTextureFormat, atlasSize: number = ATLAS_SIZE): VolumeCanvas {
  const texture = device.createTexture({
    size: [atlasSize, atlasSize, atlasSize],
    format,
    dimension: '3d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  return { texture, size: atlasSize, bitDepth, format };
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
