/**
 * LocalZarrDataProvider - Load OME-Zarr from local filesystem
 */

import { open, root, Array as ZarrArray } from 'zarrita';
import type { DataType } from 'zarrita';
import { FileSystemStore } from './filesystem-store.js';
import { LOGICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE } from '../core/config.js';
import type {
  DataProvider,
  VolumeMetadata,
  LodLevel,
  BrickData,
  BrickStats,
  BitDepth,
  NetworkStats,
} from './data-provider.js';

interface OmeMultiscales {
  axes: { name: string; type: string }[];
  datasets: { path: string; coordinateTransformations?: { type: string; scale?: number[] }[] }[];
}

export class LocalZarrDataProvider implements DataProvider {
  private dirHandle: FileSystemDirectoryHandle;
  private metadata: VolumeMetadata | null = null;
  private arrays: ZarrArray<DataType, any>[] = [];
  private lodParams: {
    scaleX: number;
    scaleY: number;
    scaleZ: number;
    actualDimX: number;
    actualDimY: number;
    actualDimZ: number;
    csx: number;
    csy: number;
    csz: number;
  }[] = [];
  private statsCache = new Map<string, BrickStats>();
  private totalBytes = 0;
  private requestCount = 0;

  constructor(dirHandle: FileSystemDirectoryHandle) {
    this.dirHandle = dirHandle;
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    const store = new FileSystemStore(this.dirHandle);
    const rootGroup = await open(root(store), { kind: 'group' });

    const attrs = rootGroup.attrs as Record<string, unknown>;
    const omeAttr = attrs['ome'] as { multiscales?: OmeMultiscales[] } | undefined;
    const multiscales = omeAttr?.multiscales ?? [];

    if (multiscales.length === 0) {
      throw new Error('No OME multiscales metadata found');
    }

    const ms = multiscales[0]!;
    const numScales = ms.datasets.length;

    this.arrays = [];
    for (const ds of ms.datasets) {
      const arr = await open(rootGroup.resolve(ds.path), { kind: 'array' });
      this.arrays.push(arr);
    }

    const dtype = this.arrays[0]!.dtype;
    let bitDepth: BitDepth;
    if (dtype === 'uint8' || dtype === 'int8') {
      bitDepth = 8;
    } else if (dtype === 'uint16' || dtype === 'int16') {
      bitDepth = 16;
    } else {
      throw new Error(`Unsupported dtype: ${dtype}`);
    }

    let voxelSpacing: [number, number, number] | undefined;
    const transforms = ms.datasets[0]?.coordinateTransformations;
    if (transforms) {
      const scaleTransform = transforms.find(t => t.type === 'scale');
      if (scaleTransform?.scale) {
        const s = scaleTransform.scale;
        voxelSpacing = [s[s.length - 1]!, s[s.length - 2]!, s[s.length - 3]!];
      }
    }

    const lod0Shape = this.arrays[0]!.shape;
    const lod0Dims: [number, number, number] = [
      lod0Shape[lod0Shape.length - 1]!,
      lod0Shape[lod0Shape.length - 2]!,
      lod0Shape[lod0Shape.length - 3]!,
    ];

    const levels: LodLevel[] = [];
    for (let i = 0; i < numScales; i++) {
      const arr = this.arrays[i]!;
      const shape = arr.shape;
      const chunkShape = (arr as any).codecs?.[0]?.configuration?.chunk_shape ?? (arr as any).chunks;

      const actualDimX = shape[shape.length - 1]!;
      const actualDimY = shape[shape.length - 2]!;
      const actualDimZ = shape[shape.length - 3]!;

      const virtualDimX = Math.round(lod0Dims[0] / Math.pow(2, i));
      const virtualDimY = Math.round(lod0Dims[1] / Math.pow(2, i));
      const virtualDimZ = Math.round(lod0Dims[2] / Math.pow(2, i));

      this.lodParams.push({
        scaleX: actualDimX / virtualDimX,
        scaleY: actualDimY / virtualDimY,
        scaleZ: actualDimZ / virtualDimZ,
        actualDimX,
        actualDimY,
        actualDimZ,
        csx: chunkShape[chunkShape.length - 1]!,
        csy: chunkShape[chunkShape.length - 2]!,
        csz: chunkShape[chunkShape.length - 3]!,
      });

      const brickGrid: [number, number, number] = [
        Math.ceil(virtualDimX / LOGICAL_BRICK_SIZE),
        Math.ceil(virtualDimY / LOGICAL_BRICK_SIZE),
        Math.ceil(virtualDimZ / LOGICAL_BRICK_SIZE),
      ];

      levels.push({
        lod: i,
        dimensions: [virtualDimX, virtualDimY, virtualDimZ],
        brickGrid,
        brickCount: brickGrid[0] * brickGrid[1] * brickGrid[2],
      });
    }

    this.metadata = {
      name: this.dirHandle.name.replace(/\.ome\.zarr|\.zarr/, ''),
      dimensions: levels[0]!.dimensions,
      voxelSpacing,
      brickSize: LOGICAL_BRICK_SIZE,
      physicalBrickSize: PHYSICAL_BRICK_SIZE,
      maxLod: numScales - 1,
      levels,
      bitDepth,
    };

    return this.metadata;
  }

  getMetadata(): VolumeMetadata {
    if (!this.metadata) throw new Error('Not initialized');
    return this.metadata;
  }

  getBrickGrid(lod: number): [number, number, number] {
    const level = this.metadata?.levels.find(l => l.lod === lod);
    return level?.brickGrid ?? [0, 0, 0];
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

      const key = `${lod}:${bx}/${by}/${bz}`;
      this.statsCache.set(key, result.stats);

      this.totalBytes += result.data.byteLength;
      this.requestCount++;

      return result.data;
    } catch (e) {
      console.warn(`Failed to load brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  async isBrickEmpty(lod: number, bx: number, by: number, bz: number, maxThreshold?: number): Promise<boolean> {
    const stats = await this.getBrickStats(lod, bx, by, bz);
    if (!stats) return false;
    const threshold = maxThreshold ?? 1;
    return stats.max < threshold;
  }

  async getBrickStats(lod: number, bx: number, by: number, bz: number): Promise<BrickStats | null> {
    const key = `${lod}:${bx}/${by}/${bz}`;
    return this.statsCache.get(key) ?? null;
  }

  private async assembleBrick(lod: number, bx: number, by: number, bz: number): Promise<{ data: BrickData; stats: BrickStats }> {
    const arr = this.arrays[lod]!;
    const params = this.lodParams[lod]!;
    const { scaleX, scaleY, scaleZ, actualDimX, actualDimY, actualDimZ, csx, csy, csz } = params;
    const physSize = PHYSICAL_BRICK_SIZE;

    const vStartX = bx * LOGICAL_BRICK_SIZE - 1;
    const vStartY = by * LOGICAL_BRICK_SIZE - 1;
    const vStartZ = bz * LOGICAL_BRICK_SIZE - 1;

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

  getNetworkStats(): NetworkStats {
    return {
      totalBytesDownloaded: this.totalBytes,
      recentBytesPerSecond: 0,
      requestCount: this.requestCount,
    };
  }

  dispose(): void {
    this.statsCache.clear();
    this.arrays = [];
  }
}
