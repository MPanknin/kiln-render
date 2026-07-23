/**
 * LocalZarrDataProvider - Loads OME-Zarr from local filesystem via
 * File System Access API. Runs on main thread (handles can't transfer to workers).
 */

import { open, root, Array as ZarrArray } from 'zarrita';
import type { DataType } from 'zarrita';
import { FileSystemStore } from './filesystem-store.js';
import { BaseZarrProvider, detectCompression, type LodParams } from './base-zarr-provider.js';
import { float32ToFloat16Bits, getUint16ToFloat16Lut } from '../utils/float16.js';
import type { VolumeMetadata, BrickData, BrickLoadResult, BrickStats, PipelineTimings } from './data-provider.js';
import { UnsupportedDatasetError } from './data-provider.js';
import { extractMultiscales } from './zarr-validator.js';
import { RollingAvg } from './network-tracker.js';
import { clampedLutEntry, computeBrickChunkFootprint } from './chunk-math.js';

export class LocalZarrDataProvider extends BaseZarrProvider {
  private dirHandle: FileSystemDirectoryHandle;
  private arrays: ZarrArray<DataType, any>[] = [];
  private lodParams: LodParams[] = [];
  private targetFormat: 'r8unorm' | 'r16float' = 'r16float';

  // Per-stage rolling averages (last 32 bricks)
  private fetchAvg = new RollingAvg();
  private assemblyAvg = new RollingAvg();

  constructor(dirHandle: FileSystemDirectoryHandle) {
    super();
    this.dirHandle = dirHandle;
  }

  // r16float: convert uint16 → float16 bit pattern. r8unorm: downsample to 8-bit.
  setTargetFormat(format: 'r8unorm' | 'r16float'): void {
    this.targetFormat = format;
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    const store = new FileSystemStore(this.dirHandle);
    const rootGroup = await open(root(store), { kind: 'group' });

    // Try root attrs first; fall back to bioformats2raw sub-group "0"
    let attrs = rootGroup.attrs as Record<string, unknown>;
    let ms = extractMultiscales(attrs);
    let baseGroup: typeof rootGroup = rootGroup;
    let subGroupPath = '';
    if (!ms) {
      try {
        const subGroup = await open(rootGroup.resolve('0'), { kind: 'group' });
        const subAttrs = subGroup.attrs as Record<string, unknown>;
        const subMs = extractMultiscales(subAttrs);
        if (subMs) {
          baseGroup = subGroup as typeof rootGroup;
          attrs = subAttrs;
          ms = subMs;
          subGroupPath = '0/';
        }
      } catch {
        // sub-group doesn't exist
      }
    }
    if (!ms) {
      throw new UnsupportedDatasetError(['No OME-NGFF multiscales metadata found']);
    }

    // Open arrays to read metadata
    this.arrays = [];
    for (const ds of ms.datasets) {
      const arr = await open(baseGroup.resolve(ds.path), { kind: 'array' });
      this.arrays.push(arr);
    }

    // Parse metadata using base class helper
    const name = this.dirHandle.name.replace(/\.ome\.zarr|\.zarr/, '');
    const { metadata, lodParams } = this.parseOmeMetadata(attrs, this.arrays, name);

    // Provisional dataRange — real range derived during base LOD loading
    if (metadata.isFloat && !metadata.dataRange) {
      metadata.dataRange = [0, 1];
    }

    metadata.compression = await detectCompression(store, `${subGroupPath}${ms.datasets[0]!.path}`);

    this.metadata = metadata;
    this.lodParams = lodParams;

    return this.metadata;
  }

  async loadBrick(lod: number, bx: number, by: number, bz: number, channelIndex = 0): Promise<BrickLoadResult | null> {
    const meta = this.metadata;
    if (!meta) return null;

    const level = meta.levels.find(l => l.lod === lod);
    if (!level) return null;

    if (bx < 0 || bx >= level.brickGrid[0] || by < 0 || by >= level.brickGrid[1] || bz < 0 || bz >= level.brickGrid[2]) {
      return null;
    }

    try {
      const result = await this.assembleBrick(lod, bx, by, bz, channelIndex);

      // Cache stats and track bytes
      this.cacheBrickStats(lod, bx, by, bz, result.stats);
      this.recordDownload(result.data.byteLength);

      return {
        data: result.data,
        min: result.stats.min,
        max: result.stats.max,
        avg: result.stats.avg,
        rawMin: result.rawMin,
        rawMax: result.rawMax,
      };
    } catch (e) {
      console.warn(`Failed to load brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  getPipelineTimings(): PipelineTimings {
    return {
      avgQueueMs: 0, // no worker queue in local provider
      avgFetchMs: this.fetchAvg.value,
      avgAssemblyMs: this.assemblyAvg.value,
      avgUploadMs: 0, // measured in StreamingManager
      sampleCount: this.fetchAvg.count,
    };
  }


  private async assembleBrick(lod: number, bx: number, by: number, bz: number, channelIndex = 0): Promise<{ data: BrickData; stats: BrickStats; rawMin?: number; rawMax?: number }> {
    const arr = this.arrays[lod]!;
    const params = this.lodParams[lod]!;
    const { scaleX, scaleY, scaleZ, actualDimX, actualDimY, actualDimZ, csx, csy, csz, shapePrefixLength, channelAxisIdx } = params;
    const physSize = this.metadata!.physicalBrickSize;
    const logicalSize = this.metadata!.brickSize;

    const {
      vStartX, vStartY, vStartZ,
      minCx, minCy, minCz,
      maxCx, maxCy, maxCz,
    } = computeBrickChunkFootprint(
      { scaleX, scaleY, scaleZ, actualDimX, actualDimY, actualDimZ, csx, csy, csz },
      bx,
      by,
      bz,
      logicalSize,
      physSize,
    );

    // --- Stage 1: chunk fetch (filesystem I/O + zarr decompression) ---
    const t0 = performance.now();
    // Flat chunk lookup: direct integer indexing replaces Map<string> + per-voxel
    // string allocation in the assembly loop.
    const ncx = maxCx - minCx + 1;
    const ncy = maxCy - minCy + 1;
    const chunkCount = ncx * ncy * (maxCz - minCz + 1);
    const chunkDataArr: (ArrayLike<number> | null)[] = new Array(chunkCount).fill(null);
    const chunkStY = new Int32Array(chunkCount);  // per-chunk width (stride for Y)
    const chunkStZ = new Int32Array(chunkCount);  // per-chunk W*H (stride for Z)

    const chunkFetches: Promise<void>[] = [];
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const fi = (cz - minCz) * ncy * ncx + (cy - minCy) * ncx + (cx - minCx);
          const prefix = new Array(shapePrefixLength).fill(0);
          if (channelAxisIdx >= 0 && channelAxisIdx < shapePrefixLength) {
            prefix[channelAxisIdx] = channelIndex;
          }
          chunkFetches.push(
            arr.getChunk([...prefix, cz, cy, cx]).then(chunk => {
              const data = chunk.data as unknown as ArrayLike<number>;
              const w = chunk.shape[chunk.shape.length - 1]!;
              const h = chunk.shape[chunk.shape.length - 2]!;
              chunkDataArr[fi] = data;
              chunkStY[fi] = w;
              chunkStZ[fi] = w * h;
            })
          );
        }
      }
    }
    await Promise.all(chunkFetches);
    this.fetchAvg.add(performance.now() - t0);

    // --- Stage 2: brick assembly (LUT-based voxel scatter + format conversion) ---
    // Precompute per-axis LUTs: local brick coord → (chunk index, intra-chunk offset).
    // Eliminates ~287k string allocations + Map.get calls per 66³ brick.
    const lutChunkX = new Int32Array(physSize);
    const lutChunkY = new Int32Array(physSize);
    const lutChunkZ = new Int32Array(physSize);
    const lutOffX = new Int32Array(physSize);
    const lutOffY = new Int32Array(physSize);
    const lutOffZ = new Int32Array(physSize);

    // clampedLutEntry clamps into the fetched chunk range — round-vs-floor
    // mismatch can otherwise index outside it on non-integer scales.
    for (let i = 0; i < physSize; i++) {
      const ex = clampedLutEntry(vStartX + i, scaleX, actualDimX, csx, minCx, maxCx);
      lutChunkX[i] = ex.chunkIdx;
      lutOffX[i] = ex.offset;

      const ey = clampedLutEntry(vStartY + i, scaleY, actualDimY, csy, minCy, maxCy);
      lutChunkY[i] = ey.chunkIdx;
      lutOffY[i] = ey.offset;

      const ez = clampedLutEntry(vStartZ + i, scaleZ, actualDimZ, csz, minCz, maxCz);
      lutChunkZ[i] = ez.chunkIdx;
      lutOffZ[i] = ez.offset;
    }

    const t1 = performance.now();
    const is16bit = this.metadata!.bitDepth === 16;
    const isFloat = this.metadata!.isFloat ?? false;
    const downsampleTo8 = is16bit && !isFloat && this.targetFormat === 'r8unorm';
    const floatMin = this.metadata!.dataRange?.[0] ?? 0;
    const floatMax = this.metadata!.dataRange?.[1] ?? 1;
    const brick = (is16bit && !downsampleTo8)
      ? new Uint16Array(physSize * physSize * physSize)
      : new Uint8Array(physSize * physSize * physSize);

    // uint16 → r16float bricks write float16 bits directly via the encode LUT,
    // in the same pass as the scatter — avoids a second full-brick conversion pass.
    const writeFloat16 = is16bit && !isFloat && !downsampleTo8;
    const u16ToF16Lut = writeFloat16 ? getUint16ToFloat16Lut() : null;

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let rawMinVal = Infinity;
    let rawMaxVal = -Infinity;

    for (let lz = 0; lz < physSize; lz++) {
      const czi = lutChunkZ[lz]!;
      const lcz = lutOffZ[lz]!;
      const zBase = czi * ncy * ncx;
      const brickZBase = lz * physSize * physSize;

      for (let ly = 0; ly < physSize; ly++) {
        const cyi = lutChunkY[ly]!;
        const lcy = lutOffY[ly]!;
        const yzBase = zBase + cyi * ncx;
        const brickYZBase = brickZBase + ly * physSize;

        for (let lx = 0; lx < physSize; lx++) {
          const fi = yzBase + lutChunkX[lx]!;
          const data = chunkDataArr[fi];
          if (data) {
            const idx = lcz * chunkStZ[fi]! + lcy * chunkStY[fi]! + lutOffX[lx]!;
            const raw = data[idx]!;

            let brickVal: number;
            let statVal: number;
            if (isFloat) {
              const range = floatMax - floatMin;
              const normalizedVal = range > 0
                ? Math.max(0, Math.min(1, (raw - floatMin) / range))
                : 0;
              statVal = Math.round(normalizedVal * 65535);
              // Store raw float value as float16 bits — shader normalises using uniforms
              brickVal = float32ToFloat16Bits(Math.max(-65504, Math.min(65504, raw)));
              if (isFinite(raw)) {
                if (raw < rawMinVal) rawMinVal = raw;
                if (raw > rawMaxVal) rawMaxVal = raw;
              }
            } else if (downsampleTo8) {
              brickVal = raw >> 8;
              statVal = raw;
            } else if (u16ToF16Lut) {
              // Stats stay in raw uint16 space; only the stored voxel is float16-encoded.
              brickVal = u16ToF16Lut[raw]!;
              statVal = raw;
            } else {
              brickVal = raw;
              statVal = raw;
            }

            brick[brickYZBase + lx] = brickVal;
            if (statVal < min) min = statVal;
            if (statVal > max) max = statVal;
            sum += statVal;
          }
        }
      }
    }
    this.assemblyAvg.add(performance.now() - t1);

    // uint16 → r16float bricks already have float16 bits written per-voxel above.
    const voxelCount = physSize * physSize * physSize;

    return {
      data: brick,
      stats: {
        min: min === Infinity ? 0 : min,
        max: max === -Infinity ? 0 : max,
        avg: sum / voxelCount,
      },
      rawMin: isFloat && isFinite(rawMinVal) ? rawMinVal : undefined,
      rawMax: isFloat && isFinite(rawMaxVal) ? rawMaxVal : undefined,
    };
  }

  dispose(): void {
    this.brickStatsCache.clear();
    this.arrays = [];
  }
}
