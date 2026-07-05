/**
 * ZarrDataProvider - Loads OME-Zarr (NGFF) datasets over HTTP via a Web Worker pool.
 * Zarr [z,y,x] metadata is swapped to Kiln's [x,y,z]; memory layout is unchanged.
 */

import { open, root, Array as ZarrArray } from 'zarrita';
import type { DataType, Readable } from 'zarrita';
import { TolerantFetchStore } from './tolerant-fetch-store.js';
import { ZarrWorkerPool } from './zarr-worker-pool.js';
import { BaseZarrProvider, detectCompression } from './base-zarr-provider.js';
import type { VolumeMetadata, BrickLoadResult, PipelineTimings } from './data-provider.js';
import { UnsupportedDatasetError } from './data-provider.js';
import { extractMultiscales } from './zarr-validator.js';

/**
 * DataProvider implementation for OME-Zarr (NGFF v0.5) volumes over HTTP
 */
export class ZarrDataProvider extends BaseZarrProvider {
  private url: string;

  /** Worker pool for off-main-thread brick loading */
  private workerPool: ZarrWorkerPool | null = null;
  private targetFormat?: 'r8unorm' | 'r16unorm' | 'r16float';

  constructor(url: string) {
    super();
    this.url = url.replace(/\/$/, '');
  }

  /**
   * Set target texture format for worker output
   * Format determines output format: r8unorm (8-bit), r16unorm (16-bit uint), r16float (16-bit float)
   */
  async setTargetFormat(format: 'r8unorm' | 'r16unorm' | 'r16float'): Promise<void> {
    this.targetFormat = format;
    if (this.workerPool) {
      await this.workerPool.setTargetFormat(format);
    }
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    // Use zarrita on main thread for lightweight metadata reading only
    const store = new TolerantFetchStore(this.url);
    const rootGroup = await open(root(store), { kind: 'group' });

    // Parse OME multiscales — try root attrs first, then bioformats2raw sub-group "0"
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

    const arrayPaths = ms.datasets.map((ds: any) => `${subGroupPath}${ds.path}`);

    // Open arrays on main thread to read metadata (shape, chunks, dtype)
    const arrays: ZarrArray<DataType, Readable>[] = [];
    for (const ds of ms.datasets) {
      const arr = await open(baseGroup.resolve(ds.path), { kind: 'array' });
      arrays.push(arr);
    }

    // Parse metadata using base class helper
    const urlParts = this.url.split('/');
    const name = urlParts[urlParts.length - 1]?.replace(/\.ome\.zarr|\.zarr/, '') ?? 'zarr-volume';
    const { metadata, lodParams } = this.parseOmeMetadata(attrs, arrays, name);

    // Provisional dataRange for float data without OMERO window — real range
    // is derived incrementally during base LOD loading.
    if (metadata.isFloat && !metadata.dataRange) {
      metadata.dataRange = [0, 1];
    }

    metadata.compression = await detectCompression(store, arrayPaths[0] ?? '');

    this.metadata = metadata;

    // Initialize worker pool — all heavy lifting happens there
    this.workerPool = new ZarrWorkerPool();
    await this.workerPool.init(
      this.url,
      arrayPaths,
      lodParams,
      metadata.brickSize,
      metadata.physicalBrickSize,
      metadata.bitDepth === 16,
      this.targetFormat,
      metadata.isFloat ?? false,
      metadata.dataRange,
    );

    return this.metadata;
  }


  /** Load a fully assembled 66³ brick via the worker pool (fully off main thread). */
  async loadBrick(lod: number, bx: number, by: number, bz: number, channelIndex = 0, signal?: AbortSignal): Promise<BrickLoadResult | null> {
    const meta = this.getMetadata();
    const level = meta.levels.find(l => l.lod === lod);
    if (!level) return null;

    if (bx < 0 || bx >= level.brickGrid[0] ||
        by < 0 || by >= level.brickGrid[1] ||
        bz < 0 || bz >= level.brickGrid[2]) {
      return null;
    }

    try {
      const result = await this.workerPool!.loadBrick(lod, bx, by, bz, channelIndex, signal);

      // Cache stats for isBrickEmpty checks
      this.cacheBrickStats(lod, bx, by, bz, {
        min: result.min,
        max: result.max,
        avg: result.avg,
      });

      // Track approximate download size
      this.recordDownload(result.data.byteLength);

      return result;
    } catch (e) {
      // Aborted requests are expected — return null silently
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      console.warn(`Failed to load brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  /**
   * Update the float normalisation range on all workers.
   * Called after base LOD loading derives the actual data range.
   */
  async setFloatRange(min: number, max: number): Promise<void> {
    if (this.workerPool) {
      await this.workerPool.setFloatRange(min, max);
    }
  }

  getPipelineTimings(): PipelineTimings {
    return this.workerPool?.getPipelineTimings() ?? {
      avgQueueMs: 0, avgFetchMs: 0, avgAssemblyMs: 0, avgUploadMs: 0, sampleCount: 0,
    };
  }

  dispose(): void {
    this.brickStatsCache.clear();
    this.workerPool?.terminate();
    this.workerPool = null;
  }
}
