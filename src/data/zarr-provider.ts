/**
 * ZarrDataProvider - DataProvider implementation for OME-Zarr (NGFF) volumes
 *
 * Loads OME-Zarr v0.5 datasets over HTTP using zarrita.js.
 * Handles re-chunking from arbitrary Zarr chunk sizes to Kiln's fixed 66³ bricks,
 * including 1-voxel ghost borders via coordinate clamping.
 *
 * Axis convention:
 * - Zarr stores dimensions as [z, y, x] (C-order, x fastest-varying)
 * - Kiln uses [x, y, z] in metadata but identical memory layout
 * - Only metadata tuples need swapping, no data transposition
 */

import { FetchStore, open, root, Array as ZarrArray } from 'zarrita';
import type { DataType, Readable } from 'zarrita';
import { LOGICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE } from '../core/config.js';
import { ZarrChunkCache } from './zarr-chunk-cache.js';
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
  private arrays: ZarrArray<DataType, Readable>[] = [];
  private chunkCache = new ZarrChunkCache(256);
  private brickStatsCache = new Map<string, BrickStats>();

  // Network tracking
  private totalBytesDownloaded = 0;
  private requestCount = 0;
  private recentDownloads: { timestamp: number; bytes: number }[] = [];

  constructor(url: string) {
    // Remove trailing slash for consistency
    this.url = url.replace(/\/$/, '');
  }

  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    const store = new FetchStore(this.url);
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

    // Open each scale array
    this.arrays = [];
    for (const ds of ms.datasets) {
      const arr = await open(rootGroup.resolve(ds.path), { kind: 'array' });
      this.arrays.push(arr);
    }

    // Determine bit depth from first array's dtype
    const dtype = this.arrays[0]!.dtype;
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
        // Swap ZYX -> XYZ
        voxelSpacing = [s[s.length - 1]!, s[s.length - 2]!, s[s.length - 3]!];
      }
    }

    // Build LOD levels (swap ZYX → XYZ for all dimension tuples)
    const levels: LodLevel[] = this.arrays.map((arr, i) => {
      const shape = arr.shape; // [z, y, x]
      const dimX = shape[shape.length - 1]!;
      const dimY = shape[shape.length - 2]!;
      const dimZ = shape[shape.length - 3]!;
      const brickGrid: [number, number, number] = [
        Math.ceil(dimX / LOGICAL_BRICK_SIZE),
        Math.ceil(dimY / LOGICAL_BRICK_SIZE),
        Math.ceil(dimZ / LOGICAL_BRICK_SIZE),
      ];
      return {
        lod: i,
        dimensions: [dimX, dimY, dimZ] as [number, number, number],
        brickGrid,
        brickCount: brickGrid[0] * brickGrid[1] * brickGrid[2],
      };
    });

    // Extract name from URL (last path segment before .zarr or .ome.zarr)
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

    console.log(`Zarr volume: ${this.metadata.name}`);
    console.log(`  Scales: ${numScales}, dtype: ${dtype}`);
    for (const level of levels) {
      console.log(`  LOD ${level.lod}: ${level.dimensions.join('x')} → ${level.brickGrid.join('x')} bricks`);
    }

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
   * Load a single 66³ brick by fetching overlapping Zarr chunks
   *
   * The brick covers voxels [bx*64-1 .. bx*64+64] (66 voxels including ghost border).
   * We determine which Zarr chunks overlap this region, fetch them (with caching),
   * and assemble the brick by reading from the cached chunks.
   */
  async loadBrick(lod: number, bx: number, by: number, bz: number): Promise<BrickData | null> {
    const arr = this.arrays[lod];
    if (!arr) return null;

    const meta = this.getMetadata();
    const level = meta.levels.find(l => l.lod === lod);
    if (!level) return null;

    // Validate coordinates
    if (bx < 0 || bx >= level.brickGrid[0] ||
        by < 0 || by >= level.brickGrid[1] ||
        bz < 0 || bz >= level.brickGrid[2]) {
      return null;
    }

    const shape = arr.shape;       // [z, y, x] in Zarr order
    const chunkShape = arr.chunks;  // [cz, cy, cx] in Zarr order
    const dimX = shape[shape.length - 1]!;
    const dimY = shape[shape.length - 2]!;
    const dimZ = shape[shape.length - 3]!;
    const csx = chunkShape[chunkShape.length - 1]!;
    const csy = chunkShape[chunkShape.length - 2]!;
    const csz = chunkShape[chunkShape.length - 3]!;

    // Brick voxel range in volume space (Kiln XYZ)
    // Ghost border: starts 1 voxel before the logical brick
    const startX = bx * LOGICAL_BRICK_SIZE - 1;
    const startY = by * LOGICAL_BRICK_SIZE - 1;
    const startZ = bz * LOGICAL_BRICK_SIZE - 1;

    // Determine which Zarr chunks overlap this brick's voxel range
    const minCx = Math.max(0, Math.floor(Math.max(0, startX) / csx));
    const minCy = Math.max(0, Math.floor(Math.max(0, startY) / csy));
    const minCz = Math.max(0, Math.floor(Math.max(0, startZ) / csz));
    const maxCx = Math.floor(Math.min(dimX - 1, startX + PHYSICAL_BRICK_SIZE - 1) / csx);
    const maxCy = Math.floor(Math.min(dimY - 1, startY + PHYSICAL_BRICK_SIZE - 1) / csy);
    const maxCz = Math.floor(Math.min(dimZ - 1, startZ + PHYSICAL_BRICK_SIZE - 1) / csz);

    // Fetch all overlapping chunks in parallel (with cache)
    const chunkPromises: Promise<void>[] = [];
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const key = ZarrChunkCache.key(lod, cz, cy, cx);
          if (!this.chunkCache.has(key)) {
            chunkPromises.push(this.fetchChunk(arr, lod, cz, cy, cx));
          }
        }
      }
    }

    if (chunkPromises.length > 0) {
      await Promise.all(chunkPromises);
    }

    // Assemble 66³ brick from cached chunks
    const physSize = PHYSICAL_BRICK_SIZE;
    const is16bit = meta.bitDepth === 16;
    const brick: BrickData = is16bit
      ? new Uint16Array(physSize * physSize * physSize)
      : new Uint8Array(physSize * physSize * physSize);

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;

    for (let lz = 0; lz < physSize; lz++) {
      for (let ly = 0; ly < physSize; ly++) {
        for (let lx = 0; lx < physSize; lx++) {
          // Global voxel coordinate with clamping at boundaries
          const gx = Math.max(0, Math.min(dimX - 1, startX + lx));
          const gy = Math.max(0, Math.min(dimY - 1, startY + ly));
          const gz = Math.max(0, Math.min(dimZ - 1, startZ + lz));

          // Which chunk does this voxel belong to?
          const cx = Math.floor(gx / csx);
          const cy = Math.floor(gy / csy);
          const cz = Math.floor(gz / csz);

          // Local coordinate within that chunk
          const lcx = gx - cx * csx;
          const lcy = gy - cy * csy;
          const lcz = gz - cz * csz;

          // Read from cached chunk (C-order: z,y,x)
          const key = ZarrChunkCache.key(lod, cz, cy, cx);
          const chunk = this.chunkCache.get(key);
          if (chunk) {
            const chunkW = chunk.shape[chunk.shape.length - 1]!;
            const chunkH = chunk.shape[chunk.shape.length - 2]!;
            const idx = lcz * chunkH * chunkW + lcy * chunkW + lcx;
            const val = Number(chunk.data[idx]!);

            // Brick layout: x + y * physSize + z * physSize * physSize
            brick[lx + ly * physSize + lz * physSize * physSize] = val;

            min = Math.min(min, val);
            max = Math.max(max, val);
            sum += val;
          }
        }
      }
    }

    // Cache stats
    const voxelCount = physSize * physSize * physSize;
    const statsKey = `${lod}:${bx}/${by}/${bz}`;
    this.brickStatsCache.set(statsKey, {
      min: min === Infinity ? 0 : min,
      max: max === -Infinity ? 0 : max,
      avg: sum / voxelCount,
    });

    return brick;
  }

  /**
   * Fetch a single Zarr chunk and add it to the cache
   */
  private async fetchChunk(
    arr: ZarrArray<DataType, Readable>,
    lod: number, cz: number, cy: number, cx: number
  ): Promise<void> {
    const key = ZarrChunkCache.key(lod, cz, cy, cx);
    try {
      const chunk = await arr.getChunk([cz, cy, cx]);
      this.chunkCache.set(key, chunk.data as unknown as ArrayLike<number>, chunk.shape);
      // Estimate bytes downloaded (compressed size unknown, use uncompressed as upper bound)
      const byteLength = (chunk.data as unknown as ArrayBufferView).byteLength ?? 0;
      this.recordDownload(byteLength);
    } catch (e) {
      console.warn(`Failed to fetch chunk ${key}:`, e);
    }
  }

  /**
   * Check if a brick is empty. Since we don't have pre-computed stats,
   * we return false (assume non-empty) until the brick has been loaded.
   */
  async isBrickEmpty(lod: number, bx: number, by: number, bz: number, maxThreshold?: number): Promise<boolean> {
    const stats = await this.getBrickStats(lod, bx, by, bz);
    if (!stats) return false; // Not yet loaded - assume non-empty
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
    this.chunkCache.clear();
    this.brickStatsCache.clear();
    this.arrays = [];
  }
}
