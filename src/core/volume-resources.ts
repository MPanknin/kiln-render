/**
 * VolumeResources — atlas textures, indirection table, and slot allocator.
 * Shared between Renderer and StreamingManager.
 */

import { VolumeCanvas, createVolumeCanvas } from './volume.js';
import { IndirectionTable } from './indirection.js';
import { AtlasAllocator } from '../streaming/atlas-allocator.js';
import type { AtlasSlot } from '../streaming/atlas-allocator.js';
import { GRID_SIZE, PHYSICAL_BRICK_SIZE } from './config.js';
import type { DatasetConfig } from './config.js';
import type { BitDepth } from '../data/data-provider.js';

export class VolumeResources {
  readonly numChannels: number;

  /** Atlas grid dimension (slots per axis) — may be shrunk to fit a VRAM budget */
  readonly gridSize: number;

  /** Atlas texture dimension in voxels (gridSize × PHYSICAL_BRICK_SIZE) */
  readonly atlasSize: number;

  /** Per-channel atlas textures (length === numChannels) */
  readonly canvases: VolumeCanvas[];

  /** Indirection table for virtual texturing */
  readonly indirection: IndirectionTable;

  /** Atlas slot allocator (LRU with thrash guard) */
  readonly allocator: AtlasAllocator;

  /** 1×1×1 dummy texture bound to unused channel slots */
  private readonly dummyTexture: GPUTexture;

  /**
   * Labels: an r16uint atlas laid out slot for slot like the image atlas, one ready flag per
   * slot (the shader shows a slot's labels once its label brick arrived) and a 256 × 256 colour
   * table indexed by label ID. One-texel dummies until enableLabels().
   */
  labelAtlas!: GPUTexture;
  labelSlots!: GPUBuffer;
  labelColors!: GPUTexture;
  private labelsEnabled = false;
  private readonly device: GPUDevice;

  /** Channel-0 alias for single-channel callers */
  get canvas(): VolumeCanvas { return this.canvases[0]!; }

  constructor(device: GPUDevice, bitDepth: BitDepth, textureFormat: GPUTextureFormat, config: DatasetConfig, numChannels = 1, gridSize: number = GRID_SIZE) {
    this.numChannels = Math.min(Math.max(1, numChannels), 4);
    this.gridSize = gridSize;
    this.atlasSize = gridSize * PHYSICAL_BRICK_SIZE;

    this.canvases = Array.from({ length: this.numChannels }, () =>
      createVolumeCanvas(device, bitDepth, textureFormat, this.atlasSize)
    );

    this.dummyTexture = device.createTexture({
      size: [1, 1, 1],
      format: textureFormat,
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.indirection = new IndirectionTable(device, config);
    this.allocator = new AtlasAllocator(gridSize);
    this.device = device;
    this.createLabelTextures(false);
  }

  get hasLabels(): boolean { return this.labelsEnabled; }

  /** Allocate the label atlas (VRAM of one 16-bit channel); bind groups must be rebuilt after. */
  enableLabels(): void {
    if (this.labelsEnabled) return;
    this.destroyLabelTextures();
    this.createLabelTextures(true);
    console.log(`[Kiln] label atlas ${this.atlasSize}³ r16uint ≈ ${Math.round(this.atlasSize ** 3 * 2 / 1e6)} MB VRAM`);
  }

  /** Free the label atlas; bind groups must be rebuilt after. */
  disableLabels(): void {
    if (!this.labelsEnabled) return;
    this.destroyLabelTextures();
    this.createLabelTextures(false);
  }

  /** Colour table from buildLabelColorTable(). */
  writeLabelColors(table: Uint8Array): void {
    if (!this.labelsEnabled) return;
    this.device.queue.writeTexture({ texture: this.labelColors }, table.buffer, { offset: table.byteOffset, bytesPerRow: 256 * 4 }, [256, 256]);
  }

  /** Copy a 66³ label brick into an atlas slot. */
  writeLabelBrick(slot: AtlasSlot, data: Uint16Array): void {
    const size = PHYSICAL_BRICK_SIZE;
    this.device.queue.writeTexture(
      { texture: this.labelAtlas, origin: [slot.x * size, slot.y * size, slot.z * size] },
      data.buffer, { offset: data.byteOffset, bytesPerRow: size * 2, rowsPerImage: size }, [size, size, size],
    );
  }

  /** Mark a slot's labels as shown (ready) or not. */
  setLabelSlotReady(slotIndex: number, ready: boolean): void {
    this.device.queue.writeBuffer(this.labelSlots, slotIndex * 4, Uint32Array.of(ready ? 1 : 0));
  }

  private createLabelTextures(enabled: boolean): void {
    const atlas = enabled ? this.atlasSize : 1;
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    this.labelAtlas = this.device.createTexture({ size: [atlas, atlas, atlas], format: 'r16uint', dimension: '3d', usage });
    this.labelColors = this.device.createTexture({ size: enabled ? [256, 256] : [1, 1], format: 'rgba8unorm', usage });
    // Zero-initialised: no slot is ready
    this.labelSlots = this.device.createBuffer({
      size: Math.max(16, (enabled ? this.allocator.totalSlots : 1) * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.labelsEnabled = enabled;
  }

  private destroyLabelTextures(): void {
    this.labelAtlas.destroy();
    this.labelColors.destroy();
    this.labelSlots.destroy();
  }

  /** Destroy the atlas, dummy, label and indirection textures (the device is external). */
  dispose(): void {
    for (const canvas of this.canvases) canvas.texture.destroy();
    this.dummyTexture.destroy();
    this.destroyLabelTextures();
    this.indirection.dispose();
  }

  /** View for atlas channel ch (dummy if ch >= numChannels) */
  atlasView(ch: number): GPUTextureView {
    return ch < this.numChannels
      ? this.canvases[ch]!.texture.createView()
      : this.dummyTexture.createView();
  }
}
