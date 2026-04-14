/**
 * ZarrDataProvider - DataProvider implementation for OME-Zarr (NGFF) volumes
 *
 * Loads OME-Zarr v0.5 datasets over HTTP using zarrita.js.
 * All heavy work (fetch, decompress, re-chunk into 66³ bricks) runs in a
 * Web Worker pool — the main thread only handles metadata and GPU uploads.
 *
 * Axis convention:
 * - Zarr stores dimensions as [z, y, x] (C-order, x fastest-varying)
 * - Kiln uses [x, y, z] in metadata but identical memory layout
 * - Only metadata tuples need swapping, no data transposition
 */

import { open, root, Array as ZarrArray } from 'zarrita';
import type { DataType, Readable } from 'zarrita';
import { TolerantFetchStore } from './tolerant-fetch-store.js';
import { ZarrWorkerPool } from './zarr-worker-pool.js';
import { BaseZarrProvider } from './base-zarr-provider.js';
import type { VolumeMetadata, BrickData } from './data-provider.js';
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

    // Parse OME multiscales from group attributes
    const attrs = rootGroup.attrs as Record<string, unknown>;
    const ms = extractMultiscales(attrs);
    if (!ms) {
      throw new UnsupportedDatasetError(['No OME-NGFF multiscales metadata found']);
    }

    const arrayPaths = ms.datasets.map((ds: any) => ds.path);

    // Open arrays on main thread to read metadata (shape, chunks, dtype)
    const arrays: ZarrArray<DataType, Readable>[] = [];
    for (const ds of ms.datasets) {
      const arr = await open(rootGroup.resolve(ds.path), { kind: 'array' });
      arrays.push(arr);
    }

    // Parse metadata using base class helper
    const urlParts = this.url.split('/');
    const name = urlParts[urlParts.length - 1]?.replace(/\.ome\.zarr|\.zarr/, '') ?? 'zarr-volume';
    const { metadata, lodParams } = this.parseOmeMetadata(attrs, arrays, name);

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
    );

    return this.metadata;
  }


  /**
   * Load a fully assembled 66³ brick via the worker pool.
   * The entire pipeline (fetch + decompress + re-chunk + stats) runs off main thread.
   */
  async loadBrick(lod: number, bx: number, by: number, bz: number): Promise<BrickData | null> {
    const meta = this.getMetadata();
    const level = meta.levels.find(l => l.lod === lod);
    if (!level) return null;

    if (bx < 0 || bx >= level.brickGrid[0] ||
        by < 0 || by >= level.brickGrid[1] ||
        bz < 0 || bz >= level.brickGrid[2]) {
      return null;
    }

    try {
      const result = await this.workerPool!.loadBrick(lod, bx, by, bz);

      // Cache stats for isBrickEmpty checks
      this.cacheBrickStats(lod, bx, by, bz, {
        min: result.min,
        max: result.max,
        avg: result.avg,
      });

      // Track approximate download size
      this.recordDownload(result.data.byteLength);

      return result.data;
    } catch (e) {
      console.warn(`Failed to load brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  dispose(): void {
    this.brickStatsCache.clear();
    this.workerPool?.terminate();
    this.workerPool = null;
  }
}
