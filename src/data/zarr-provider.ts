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
import { LOGICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE } from '../core/config.js';
import { ZarrWorkerPool } from './zarr-worker-pool.js';
import type {
  DataProvider,
  VolumeMetadata,
  LodLevel,
  BrickData,
  BrickStats,
  BitDepth,
  NetworkStats,
} from './data-provider.js';

/** OME-NGFF multiscales metadata (from group attributes) */
interface OmeMultiscales {
  axes: { name: string; type: string; unit?: string }[];
  datasets: { path: string; coordinateTransformations?: { type: string; scale?: number[] }[] }[];
  name?: string;
  version?: string;
}

/**
 * DataProvider implementation for OME-Zarr (NGFF v0.5) volumes
 */
export class ZarrDataProvider implements DataProvider {
  private url: string;
  private metadata: VolumeMetadata | null = null;
  private brickStatsCache = new Map<string, BrickStats>();

  /** Worker pool for off-main-thread brick loading */
  private workerPool: ZarrWorkerPool | null = null;

  // Network tracking (approximate — workers do the actual fetching)
  private totalBytesDownloaded = 0;
  private requestCount = 0;
  private recentDownloads: { timestamp: number; bytes: number }[] = [];

  constructor(url: string) {
    this.url = url.replace(/\/$/, '');
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    // Use zarrita on main thread for lightweight metadata reading only
    const store = new TolerantFetchStore(this.url);
    const rootGroup = await open(root(store), { kind: 'group' });

    // Parse OME multiscales from group attributes
    const attrs = rootGroup.attrs as Record<string, unknown>;
    const omeAttr = attrs['ome'] as { multiscales?: OmeMultiscales[] } | undefined;
    const multiscales: OmeMultiscales[] =
      omeAttr?.multiscales ??
      (attrs['multiscales'] as OmeMultiscales[] | undefined) ??
      [];

    if (multiscales.length === 0) {
      throw new Error('No OME multiscales metadata found in Zarr group attributes');
    }

    const ms = multiscales[0]!;
    const numScales = ms.datasets.length;
    const arrayPaths = ms.datasets.map(ds => ds.path);

    // Open arrays on main thread to read metadata (shape, chunks, dtype)
    const arrays: ZarrArray<DataType, Readable>[] = [];
    for (const ds of ms.datasets) {
      const arr = await open(rootGroup.resolve(ds.path), { kind: 'array' });
      arrays.push(arr);
    }

    // Determine bit depth
    const dtype = arrays[0]!.dtype;
    let bitDepth: BitDepth;
    if (dtype === 'uint8' || dtype === 'int8') {
      bitDepth = 8;
    } else if (dtype === 'uint16' || dtype === 'int16') {
      bitDepth = 16;
    } else {
      console.warn(`Unsupported dtype "${dtype}", falling back to 8-bit`);
      bitDepth = 8;
    }

    // Compute voxel spacing from coordinateTransformations if available
    let voxelSpacing: [number, number, number] | undefined;
    const transforms = ms.datasets[0]?.coordinateTransformations;
    if (transforms) {
      const scaleTransform = transforms.find(t => t.type === 'scale');
      if (scaleTransform?.scale) {
        const s = scaleTransform.scale;
        voxelSpacing = [s[s.length - 1]!, s[s.length - 2]!, s[s.length - 3]!];
      }
    }

    // Build LOD levels with virtual dimensions for uniform 2:1 downsampling.
    // The renderer assumes lodScale = 2^lod (uniform). OME-Zarr may not
    // downsample uniformly, so we compute virtual dims and per-axis scale factors.
    const lod0Shape = arrays[0]!.shape; // [z, y, x]
    const lod0Dims: [number, number, number] = [
      lod0Shape[lod0Shape.length - 1]!,
      lod0Shape[lod0Shape.length - 2]!,
      lod0Shape[lod0Shape.length - 3]!,
    ];

    // Build lodParams for the workers (per-axis scale + chunk info)
    const lodParams: {
      scaleX: number; scaleY: number; scaleZ: number;
      actualDimX: number; actualDimY: number; actualDimZ: number;
      csx: number; csy: number; csz: number;
    }[] = [];

    const levels: LodLevel[] = arrays.map((arr, i) => {
      const shape = arr.shape;
      const actualDimX = shape[shape.length - 1]!;
      const actualDimY = shape[shape.length - 2]!;
      const actualDimZ = shape[shape.length - 3]!;

      const virtualDimX = Math.ceil(lod0Dims[0] / (1 << i));
      const virtualDimY = Math.ceil(lod0Dims[1] / (1 << i));
      const virtualDimZ = Math.ceil(lod0Dims[2] / (1 << i));

      const chunkShape = arr.chunks;
      lodParams.push({
        scaleX: actualDimX / virtualDimX,
        scaleY: actualDimY / virtualDimY,
        scaleZ: actualDimZ / virtualDimZ,
        actualDimX, actualDimY, actualDimZ,
        csx: chunkShape[chunkShape.length - 1]!,
        csy: chunkShape[chunkShape.length - 2]!,
        csz: chunkShape[chunkShape.length - 3]!,
      });

      const brickGrid: [number, number, number] = [
        Math.ceil(virtualDimX / LOGICAL_BRICK_SIZE),
        Math.ceil(virtualDimY / LOGICAL_BRICK_SIZE),
        Math.ceil(virtualDimZ / LOGICAL_BRICK_SIZE),
      ];
      return {
        lod: i,
        dimensions: [virtualDimX, virtualDimY, virtualDimZ] as [number, number, number],
        brickGrid,
        brickCount: brickGrid[0] * brickGrid[1] * brickGrid[2],
      };
    });

    const urlParts = this.url.split('/');
    const name = urlParts[urlParts.length - 1]?.replace(/\.ome\.zarr|\.zarr/, '') ?? 'zarr-volume';

    this.metadata = {
      name,
      dimensions: levels[0]!.dimensions,
      voxelSpacing,
      brickSize: LOGICAL_BRICK_SIZE,
      physicalBrickSize: PHYSICAL_BRICK_SIZE,
      maxLod: numScales - 1,
      levels,
      bitDepth,
    };


    // Initialize worker pool — all heavy lifting happens there
    this.workerPool = new ZarrWorkerPool();
    await this.workerPool.init(
      this.url, arrayPaths, lodParams,
      LOGICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE,
      bitDepth === 16,
    );

    return this.metadata;
  }

  getMetadata(): VolumeMetadata {
    if (!this.metadata) throw new Error('Metadata not loaded. Call initialize() first.');
    return this.metadata;
  }

  getBitDepth(): BitDepth {
    return this.metadata?.bitDepth ?? 8;
  }

  getBrickGrid(lod: number): [number, number, number] {
    const meta = this.getMetadata();
    const level = meta.levels.find(l => l.lod === lod);
    if (!level) throw new Error(`LOD level ${lod} not found`);
    return level.brickGrid;
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
      const statsKey = `${lod}:${bx}/${by}/${bz}`;
      this.brickStatsCache.set(statsKey, {
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

  async isBrickEmpty(lod: number, bx: number, by: number, bz: number, maxThreshold?: number): Promise<boolean> {
    const stats = await this.getBrickStats(lod, bx, by, bz);
    if (!stats) return false;
    const threshold = maxThreshold ?? 1;
    return stats.max < threshold;
  }

  async getBrickStats(lod: number, bx: number, by: number, bz: number): Promise<BrickStats | null> {
    const key = `${lod}:${bx}/${by}/${bz}`;
    return this.brickStatsCache.get(key) ?? null;
  }

  private recordDownload(bytes: number): void {
    this.totalBytesDownloaded += bytes;
    this.requestCount++;
    this.recentDownloads.push({ timestamp: performance.now(), bytes });
  }

  getNetworkStats(): NetworkStats {
    const now = performance.now();
    const windowMs = 2000;
    const cutoff = now - windowMs;
    this.recentDownloads = this.recentDownloads.filter(d => d.timestamp > cutoff);
    const recentBytes = this.recentDownloads.reduce((sum, d) => sum + d.bytes, 0);
    return {
      totalBytesDownloaded: this.totalBytesDownloaded,
      recentBytesPerSecond: (recentBytes / windowMs) * 1000,
      requestCount: this.requestCount,
    };
  }

  dispose(): void {
    this.brickStatsCache.clear();
    this.workerPool?.terminate();
    this.workerPool = null;
  }
}
