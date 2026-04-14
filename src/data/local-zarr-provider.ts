/**
 * LocalZarrDataProvider - Load OME-Zarr from local filesystem
 *
 * Uses File System Access API to read local Zarr datasets.
 * Unlike ZarrDataProvider, this runs on the main thread since
 * FileSystemDirectoryHandle cannot be transferred to workers.
 */

import { open, root, Array as ZarrArray } from 'zarrita';
import type { DataType } from 'zarrita';
import { FileSystemStore } from './filesystem-store.js';
import { BaseZarrProvider, type LodParams } from './base-zarr-provider.js';
import type { VolumeMetadata, BrickData, BrickStats } from './data-provider.js';
import { UnsupportedDatasetError } from './data-provider.js';
import { extractMultiscales } from './zarr-validator.js';

export class LocalZarrDataProvider extends BaseZarrProvider {
  private dirHandle: FileSystemDirectoryHandle;
  private arrays: ZarrArray<DataType, any>[] = [];
  private lodParams: LodParams[] = [];

  constructor(dirHandle: FileSystemDirectoryHandle) {
    super();
    this.dirHandle = dirHandle;
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    const store = new FileSystemStore(this.dirHandle);
    const rootGroup = await open(root(store), { kind: 'group' });

    const attrs = rootGroup.attrs as Record<string, unknown>;
    const ms = extractMultiscales(attrs);
    if (!ms) {
      throw new UnsupportedDatasetError(['No OME-NGFF multiscales metadata found']);
    }

    // Open arrays to read metadata
    this.arrays = [];
    for (const ds of ms.datasets) {
      const arr = await open(rootGroup.resolve(ds.path), { kind: 'array' });
      this.arrays.push(arr);
    }

    // Parse metadata using base class helper
    const name = this.dirHandle.name.replace(/\.ome\.zarr|\.zarr/, '');
    const { metadata, lodParams } = this.parseOmeMetadata(attrs, this.arrays, name);

    this.metadata = metadata;
    this.lodParams = lodParams;

    return this.metadata;
  }

  async loadBrick(lod: number, bx: number, by: number, bz: number): Promise<BrickData | null> {
    const meta = this.metadata;
    if (!meta) return null;

    const level = meta.levels.find(l => l.lod === lod);
    if (!level) return null;

    if (bx < 0 || bx >= level.brickGrid[0] || by < 0 || by >= level.brickGrid[1] || bz < 0 || bz >= level.brickGrid[2]) {
      return null;
    }

    try {
      const result = await this.assembleBrick(lod, bx, by, bz);

      // Cache stats and track bytes
      this.cacheBrickStats(lod, bx, by, bz, result.stats);
      this.recordDownload(result.data.byteLength);

      return result.data;
    } catch (e) {
      console.warn(`Failed to load brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  private async assembleBrick(lod: number, bx: number, by: number, bz: number): Promise<{ data: BrickData; stats: BrickStats }> {
    const arr = this.arrays[lod]!;
    const params = this.lodParams[lod]!;
    const { scaleX, scaleY, scaleZ, actualDimX, actualDimY, actualDimZ, csx, csy, csz } = params;
    const physSize = this.metadata!.physicalBrickSize;
    const logicalSize = this.metadata!.brickSize;

    const vStartX = bx * logicalSize - 1;
    const vStartY = by * logicalSize - 1;
    const vStartZ = bz * logicalSize - 1;

    const aStartX = Math.max(0, Math.floor(Math.max(0, vStartX) * scaleX));
    const aStartY = Math.max(0, Math.floor(Math.max(0, vStartY) * scaleY));
    const aStartZ = Math.max(0, Math.floor(Math.max(0, vStartZ) * scaleZ));
    const aEndX = Math.min(actualDimX - 1, Math.floor((vStartX + physSize - 1) * scaleX));
    const aEndY = Math.min(actualDimY - 1, Math.floor((vStartY + physSize - 1) * scaleY));
    const aEndZ = Math.min(actualDimZ - 1, Math.floor((vStartZ + physSize - 1) * scaleZ));

    const minCx = Math.floor(aStartX / csx);
    const minCy = Math.floor(aStartY / csy);
    const minCz = Math.floor(aStartZ / csz);
    const maxCx = Math.floor(aEndX / csx);
    const maxCy = Math.floor(aEndY / csy);
    const maxCz = Math.floor(aEndZ / csz);

    const chunkCache = new Map<string, { data: ArrayLike<number>; shape: number[] }>();
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const chunk = await arr.getChunk([cz, cy, cx]);
          const key = `${cz}/${cy}/${cx}`;
          chunkCache.set(key, {
            data: chunk.data as unknown as ArrayLike<number>,
            shape: chunk.shape,
          });
        }
      }
    }

    const is16bit = this.metadata!.bitDepth === 16;
    const brick = is16bit
      ? new Uint16Array(physSize * physSize * physSize)
      : new Uint8Array(physSize * physSize * physSize);

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;

    for (let lz = 0; lz < physSize; lz++) {
      for (let ly = 0; ly < physSize; ly++) {
        for (let lx = 0; lx < physSize; lx++) {
          const vx = vStartX + lx;
          const vy = vStartY + ly;
          const vz = vStartZ + lz;

          const gx = Math.max(0, Math.min(actualDimX - 1, Math.round(vx * scaleX)));
          const gy = Math.max(0, Math.min(actualDimY - 1, Math.round(vy * scaleY)));
          const gz = Math.max(0, Math.min(actualDimZ - 1, Math.round(vz * scaleZ)));

          const cx = Math.floor(gx / csx);
          const cy = Math.floor(gy / csy);
          const cz = Math.floor(gz / csz);

          const lcx = gx - cx * csx;
          const lcy = gy - cy * csy;
          const lcz = gz - cz * csz;

          const key = `${cz}/${cy}/${cx}`;
          const chunk = chunkCache.get(key);
          if (chunk) {
            const chunkW = chunk.shape[chunk.shape.length - 1]!;
            const chunkH = chunk.shape[chunk.shape.length - 2]!;
            const chunkD = chunk.shape[chunk.shape.length - 3]!;

            if (lcx >= 0 && lcx < chunkW && lcy >= 0 && lcy < chunkH && lcz >= 0 && lcz < chunkD) {
              const idx = lcz * chunkH * chunkW + lcy * chunkW + lcx;
              const val = Number(chunk.data[idx]!);

              brick[lx + ly * physSize + lz * physSize * physSize] = val;
              min = Math.min(min, val);
              max = Math.max(max, val);
              sum += val;
            }
          }
        }
      }
    }

    const voxelCount = physSize * physSize * physSize;

    return {
      data: brick,
      stats: {
        min: min === Infinity ? 0 : min,
        max: max === -Infinity ? 0 : max,
        avg: sum / voxelCount,
      },
    };
  }

  dispose(): void {
    this.brickStatsCache.clear();
    this.arrays = [];
  }
}
