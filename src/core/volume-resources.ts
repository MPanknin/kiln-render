/**
 * VolumeResources — atlas textures, indirection table, and slot allocator.
 * Shared between Renderer and StreamingManager.
 */

import { VolumeCanvas, createVolumeCanvas } from './volume.js';
import { IndirectionTable } from './indirection.js';
import { AtlasAllocator } from '../streaming/atlas-allocator.js';
import type { DatasetConfig } from './config.js';
import type { BitDepth } from '../data/data-provider.js';

export class VolumeResources {
  readonly numChannels: number;

  /** Per-channel atlas textures (length === numChannels) */
  readonly canvases: VolumeCanvas[];

  /** Indirection table for virtual texturing */
  readonly indirection: IndirectionTable;

  /** Atlas slot allocator (LRU with thrash guard) */
  readonly allocator: AtlasAllocator;

  /** 1×1×1 dummy texture bound to unused channel slots */
  private readonly dummyTexture: GPUTexture;

  /** Channel-0 alias for single-channel callers */
  get canvas(): VolumeCanvas { return this.canvases[0]!; }

  constructor(device: GPUDevice, bitDepth: BitDepth, textureFormat: GPUTextureFormat, config: DatasetConfig, numChannels = 1) {
    this.numChannels = Math.min(Math.max(1, numChannels), 4);

    this.canvases = Array.from({ length: this.numChannels }, () =>
      createVolumeCanvas(device, bitDepth, textureFormat)
    );

    this.dummyTexture = device.createTexture({
      size: [1, 1, 1],
      format: textureFormat,
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.indirection = new IndirectionTable(device, config);
    this.allocator = new AtlasAllocator();
  }

  /** View for atlas channel ch (dummy if ch >= numChannels) */
  atlasView(ch: number): GPUTextureView {
    return ch < this.numChannels
      ? this.canvases[ch]!.texture.createView()
      : this.dummyTexture.createView();
  }
}
