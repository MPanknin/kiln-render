/**
 * ZarrDataProvider - Loads OME-Zarr (NGFF) datasets over HTTP via a Web Worker pool.
 * Zarr [z,y,x] metadata is swapped to Kiln's [x,y,z]; memory layout is unchanged.
 */

import { open, root, Array as ZarrArray } from 'zarrita';
import type { DataType, Readable, ArrayMetadata, AbsolutePath } from 'zarrita';
import { TolerantFetchStore } from './tolerant-fetch-store.js';
import { ZarrWorkerPool } from './zarr-worker-pool.js';
import { BaseZarrProvider, detectCompression } from './base-zarr-provider.js';
import type { OmeMultiscales } from './base-zarr-provider.js';
import type { VolumeMetadata, BrickLoadResult, PipelineTimings } from './data-provider.js';
import { UnsupportedDatasetError } from './data-provider.js';
import { extractMultiscales } from './zarr-validator.js';
import { v2ToV3ArrayMetadata, compressionLabel } from './zarr-v2-metadata.js';
import type { ZarrV2ArrayJson } from './zarr-v2-metadata.js';
import { isFlagEnabled, flagNumber } from '../core/feature-flags.js';
import { ChunkFetchBroker } from './chunk-fetch-broker.js';

/** Everything initialize() needs, opened in two round trips (see openV2Fast). */
interface FastOpen {
  attrs: Record<string, unknown>;
  ms: OmeMultiscales;
  arrays: ZarrArray<DataType, Readable>[];
  arrayPaths: string[];
  arrayMetadata: ArrayMetadata<DataType>[];
  compression: string | undefined;
}

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

  /**
   * ?p22=1 — open a Zarr v2 OME dataset in two round trips: group attrs (root
   * and bioformats2raw "0" speculatively together), then every level's .zarray
   * in parallel. Arrays are built from that JSON, and the same metadata is
   * handed to the workers so they start without touching the network.
   * Returns null when the store is not v2 (caller falls back to zarrita probing).
   */
  private async openV2Fast(store: TolerantFetchStore): Promise<FastOpen | null> {
    const getJson = async <T,>(key: string): Promise<T | null> => {
      const bytes = await store.get(key as AbsolutePath).catch(() => undefined);
      return bytes ? JSON.parse(new TextDecoder().decode(bytes)) as T : null;
    };
    const [rootAttrs, subAttrs] = await Promise.all([
      getJson<Record<string, unknown>>('/.zattrs'),
      getJson<Record<string, unknown>>('/0/.zattrs'),
    ]);
    if (!rootAttrs && !subAttrs) return null;

    let attrs = rootAttrs ?? {};
    let ms = extractMultiscales(attrs) as OmeMultiscales | null;
    let subGroupPath = '';
    if (!ms && subAttrs) {
      const subMs = extractMultiscales(subAttrs) as OmeMultiscales | null;
      if (subMs) { attrs = subAttrs; ms = subMs; subGroupPath = '0/'; }
    }
    if (!ms) return null;

    const arrayPaths = ms.datasets.map(ds => `${subGroupPath}${ds.path}`);
    const zarrays = await Promise.all(arrayPaths.map(p => getJson<ZarrV2ArrayJson>(`/${p}/.zarray`)));
    if (zarrays.some(z => !z)) return null;

    const arrayMetadata = zarrays.map(z => v2ToV3ArrayMetadata(z!));
    const arrays = arrayPaths.map((p, i) => new ZarrArray(store, `/${p}` as AbsolutePath, arrayMetadata[i]!));
    return { attrs, ms, arrays, arrayPaths, arrayMetadata, compression: compressionLabel(zarrays[0]!.compressor) };
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    // Use zarrita on main thread for lightweight metadata reading only
    const store = new TolerantFetchStore(this.url);
    const fast = isFlagEnabled('p22') ? await this.openV2Fast(store) : null;

    let attrs: Record<string, unknown>;
    let arrays: ZarrArray<DataType, Readable>[];
    let arrayPaths: string[];
    let arrayMetadata: ArrayMetadata<DataType>[] | undefined;
    let compression: string | undefined;

    if (fast) {
      ({ attrs, arrays, arrayPaths, arrayMetadata, compression } = fast);
    } else {
      const rootGroup = await open(root(store), { kind: 'group' });

      // Parse OME multiscales — try root attrs first, then bioformats2raw sub-group "0"
      attrs = rootGroup.attrs as Record<string, unknown>;
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

      arrayPaths = ms.datasets.map((ds: any) => `${subGroupPath}${ds.path}`);

      // Open arrays on main thread to read metadata (shape, chunks, dtype)
      arrays = [];
      for (const ds of ms.datasets) {
        const arr = await open(baseGroup.resolve(ds.path), { kind: 'array' });
        arrays.push(arr);
      }
      compression = await detectCompression(store, arrayPaths[0] ?? '');
    }

    // Parse metadata using base class helper
    const urlParts = this.url.split('/');
    const name = urlParts[urlParts.length - 1]?.replace(/\.ome\.zarr|\.zarr/, '') ?? 'zarr-volume';
    const { metadata, lodParams } = this.parseOmeMetadata(attrs, arrays, name);
    this.lodParams = lodParams;

    // Provisional dataRange for float data without OMERO window — real range
    // is derived incrementally during base LOD loading.
    if (metadata.isFloat && !metadata.dataRange) {
      metadata.dataRange = [0, 1];
    }

    metadata.compression = compression;

    // Backfill the metadata reads made above (group/array opens, compression
    // probe) — small, but real network activity that should count too.
    this.recordDownload(store.bytesFetched, store.requestCount);

    this.metadata = metadata;

    // ?p23=1 — workers fetch through one main-thread broker (dedupe + bounded in-flight)
    const broker = isFlagEnabled('p23') ? new ChunkFetchBroker(store, flagNumber('p23n', 16)) : undefined;

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
      arrayMetadata,
      broker,
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

      // Real network bytes/requests for this brick's chunks, reported by the
      // worker's store. Falls back to the assembled-buffer size only if a
      // worker didn't report it (shouldn't happen once initialized).
      this.recordDownload(
        result.chunkBytesFetched ?? result.data.byteLength,
        result.chunkRequestsIssued ?? 1,
      );

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
