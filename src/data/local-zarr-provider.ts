/**
 * LocalZarrDataProvider - Loads OME-Zarr from local filesystem via
 * File System Access API. Runs on main thread (handles can't transfer to workers).
 */

import { open, root, Array as ZarrArray } from 'zarrita';
import type { DataType } from 'zarrita';
import { FileSystemStore } from './filesystem-store.js';
import { BaseZarrProvider, detectCompression } from './base-zarr-provider.js';
import { float32ToFloat16Bits, getUint16ToFloat16Lut } from '../utils/float16.js';
import type { TargetFormat } from './brick-convert.js';
import type { VolumeMetadata, BrickData, BrickLoadResult, BrickStats, PipelineTimings } from './data-provider.js';
import { UnsupportedDatasetError } from './data-provider.js';
import { provisionalDataRange } from './value-types.js';
import { extractMultiscales } from './zarr-validator.js';
import { RollingAvg } from './network-tracker.js';
import { labelId, parseLabelNames } from './labels.js';
import { ZarrDataProvider } from './zarr-provider.js';
import { clampedLutEntry, computeBrickChunkFootprint, chunkCoords, chunkLayout } from './chunk-math.js';

export class LocalZarrDataProvider extends BaseZarrProvider {
  private dirHandle: FileSystemDirectoryHandle;
  /** Sub-directories of dirHandle that hold the image, resolved by initialize() */
  private readonly path: string[];
  /** Image group: dirHandle, or its bioformats2raw "0" sub-group */
  private groupHandle: FileSystemDirectoryHandle;
  private arrays: ZarrArray<DataType, any>[] = [];
  private targetFormat: TargetFormat = 'r16float';

  // Per-stage rolling averages (last 32 bricks)
  private fetchAvg = new RollingAvg();
  private assemblyAvg = new RollingAvg();

  /** `labels`: a label image at `path` below dirHandle, assembled as 16-bit label IDs. */
  constructor(dirHandle: FileSystemDirectoryHandle, { labels = false, path = [] }: { labels?: boolean; path?: string[] } = {}) {
    super();
    this.dirHandle = dirHandle;
    this.groupHandle = dirHandle;
    this.path = path;
    this.labelMode = labels;
    if (labels) this.targetFormat = 'r16unorm';
  }

  async listLabels(): Promise<string[]> {
    const store = new FileSystemStore(this.groupHandle);
    for (const key of ['/labels/zarr.json', '/labels/.zattrs']) {
      const bytes = await store.get(key as never).catch(() => undefined);
      if (!bytes) continue;
      try {
        const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        return parseLabelNames((json['attributes'] as Record<string, unknown> | undefined) ?? json);
      } catch {
        return [];
      }
    }
    return [];
  }

  openLabels(source: string): ZarrDataProvider | LocalZarrDataProvider {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return new ZarrDataProvider(source, { labels: true });
    return new LocalZarrDataProvider(this.groupHandle, { labels: true, path: ['labels', source] });
  }

  // r16float: convert uint16 → float16 bit pattern. r8unorm: downsample to 8-bit. r16unorm: raw.
  setTargetFormat(format: TargetFormat): void {
    this.targetFormat = format;
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    for (const name of this.path) this.dirHandle = await this.dirHandle.getDirectoryHandle(name);
    this.groupHandle = this.dirHandle;
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
          this.groupHandle = await this.dirHandle.getDirectoryHandle('0');
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
      metadata.dataRange = provisionalDataRange(metadata.dtype);
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
      const result = await this.assembleBrick(lod, bx, by, bz, this.sourceChannelFor(channelIndex));

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
    const { scaleX, scaleY, scaleZ, actualDimX, actualDimY, actualDimZ, csx, csy, csz, shapePrefixLength, channelAxisIdx, channelChunkSize, spatialOrder, timeAxisIdx, timeChunkSize, timepoint } = params;
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
    // Per-chunk flat-index layout: real strides plus packed-channel base offset
    const chunkBase = new Int32Array(chunkCount);
    const chunkStX = new Int32Array(chunkCount);
    const chunkStY = new Int32Array(chunkCount);
    const chunkStZ = new Int32Array(chunkCount);

    const chunkFetches: Promise<void>[] = [];
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const fi = (cz - minCz) * ncy * ncx + (cy - minCy) * ncx + (cx - minCx);
          const coords = chunkCoords(shapePrefixLength, channelAxisIdx, channelChunkSize, channelIndex, cz, cy, cx, spatialOrder, timeAxisIdx, timeChunkSize, timepoint);
          chunkFetches.push(
            arr.getChunk(coords).then(chunk => {
              chunkDataArr[fi] = chunk.data as unknown as ArrayLike<number>;
              const layout = chunkLayout(chunk, channelAxisIdx, channelChunkSize, channelIndex, spatialOrder, timeAxisIdx, timeChunkSize, timepoint);
              chunkBase[fi] = layout.base;
              chunkStX[fi] = layout.strideX;
              chunkStY[fi] = layout.strideY;
              chunkStZ[fi] = layout.strideZ;
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
    const labelMode = this.labelMode;
    const floatMin = this.metadata!.dataRange?.[0] ?? 0;
    const floatMax = this.metadata!.dataRange?.[1] ?? 1;
    const brick = (is16bit && !downsampleTo8)
      ? new Uint16Array(physSize * physSize * physSize)
      : new Uint8Array(physSize * physSize * physSize);

    // uint16 → r16float bricks write float16 bits directly via the encode LUT,
    // in the same pass as the scatter — avoids a second full-brick conversion pass.
    const writeFloat16 = is16bit && !isFloat && this.targetFormat === 'r16float';
    const u16ToF16Lut = writeFloat16 ? getUint16ToFloat16Lut() : null;
    // Voxels of missing chunks read as 0, whose stored form here is not all-zero bits.
    if (u16ToF16Lut) brick.fill(u16ToF16Lut[0]!);

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
            const idx = chunkBase[fi]! + lcz * chunkStZ[fi]! + lcy * chunkStY[fi]! + lutOffX[lx]! * chunkStX[fi]!;
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
            } else if (labelMode) {
              // int64 label arrays decode to bigint
              brickVal = labelId(raw as number | bigint);
              statVal = brickVal;
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
