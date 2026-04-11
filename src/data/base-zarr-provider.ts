/**
 * BaseZarrProvider - Shared base class for Zarr data providers
 *
 * Contains common logic for:
 * - OME-Zarr metadata parsing (multiscales, OMERO window metadata, voxel spacing)
 * - LOD level calculation with virtual dimensions
 * - Brick statistics caching
 * - Network/IO statistics tracking
 * - Common utility methods
 *
 * Subclasses implement the actual brick loading strategy:
 * - ZarrDataProvider: Uses worker pool for HTTP fetching
 * - LocalZarrDataProvider: Main thread assembly from File System Access API
 */

import type { Array as ZarrArray } from 'zarrita';
import type { DataType } from 'zarrita';
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

/** OME-NGFF multiscales metadata (from group attributes) */
export interface OmeMultiscales {
  axes: { name: string; type: string; unit?: string }[];
  datasets: { path: string; coordinateTransformations?: { type: string; scale?: number[] }[] }[];
  name?: string;
  version?: string;
}

/** Per-LOD scale factors and chunk parameters */
export interface LodParams {
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  actualDimX: number;
  actualDimY: number;
  actualDimZ: number;
  csx: number;
  csy: number;
  csz: number;
}

/**
 * Abstract base class for Zarr providers
 */
export abstract class BaseZarrProvider implements DataProvider {
  protected metadata: VolumeMetadata | null = null;
  protected brickStatsCache = new Map<string, BrickStats>();
  protected totalBytesDownloaded = 0;
  protected requestCount = 0;
  protected recentDownloads: { timestamp: number; bytes: number }[] = [];

  // Abstract methods that subclasses must implement
  abstract initialize(): Promise<VolumeMetadata>;
  abstract loadBrick(lod: number, bx: number, by: number, bz: number): Promise<BrickData | null>;
  abstract dispose(): void;

  /**
   * Get cached metadata
   */
  getMetadata(): VolumeMetadata {
    if (!this.metadata) {
      throw new Error('Metadata not loaded. Call initialize() first.');
    }
    return this.metadata;
  }

  /**
   * Get brick grid dimensions for a LOD level
   */
  getBrickGrid(lod: number): [number, number, number] {
    const meta = this.getMetadata();
    const level = meta.levels.find(l => l.lod === lod);
    if (!level) {
      throw new Error(`LOD level ${lod} not found`);
    }
    return level.brickGrid;
  }

  /**
   * Check if a brick is empty (max value below threshold)
   */
  async isBrickEmpty(lod: number, bx: number, by: number, bz: number, maxThreshold?: number): Promise<boolean> {
    const stats = await this.getBrickStats(lod, bx, by, bz);
    if (!stats) return false;
    const threshold = maxThreshold ?? 1;
    return stats.max < threshold;
  }

  /**
   * Get cached brick statistics
   */
  async getBrickStats(lod: number, bx: number, by: number, bz: number): Promise<BrickStats | null> {
    const key = `${lod}:${bx}/${by}/${bz}`;
    return this.brickStatsCache.get(key) ?? null;
  }

  /**
   * Get network/IO statistics
   */
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

  /**
   * Record download/read for statistics tracking
   */
  protected recordDownload(bytes: number): void {
    this.totalBytesDownloaded += bytes;
    this.requestCount++;
    this.recentDownloads.push({ timestamp: performance.now(), bytes });
  }

  /**
   * Cache brick statistics
   */
  protected cacheBrickStats(lod: number, bx: number, by: number, bz: number, stats: BrickStats): void {
    const key = `${lod}:${bx}/${by}/${bz}`;
    this.brickStatsCache.set(key, stats);
  }

  /**
   * Parse OME-Zarr metadata and build VolumeMetadata
   *
   * This handles:
   * - Extracting OME multiscales from group attributes
   * - Detecting bit depth from dtype
   * - Parsing voxel spacing from coordinateTransformations
   * - Building LOD levels with virtual dimensions
   * - Extracting OMERO window metadata
   */
  protected parseOmeMetadata(
    attrs: Record<string, unknown>,
    arrays: ZarrArray<DataType, any>[],
    name: string,
  ): { metadata: VolumeMetadata; lodParams: LodParams[] } {
    // Parse OME multiscales from group attributes
    const omeAttr = attrs['ome'] as {
      multiscales?: OmeMultiscales[];
      omero?: { channels?: { window?: { start: number; end: number; min: number; max: number } }[] };
    } | undefined;

    const multiscales: OmeMultiscales[] =
      omeAttr?.multiscales ??
      (attrs['multiscales'] as OmeMultiscales[] | undefined) ??
      [];

    if (multiscales.length === 0) {
      throw new Error('No OME multiscales metadata found in Zarr group attributes');
    }

    const ms = multiscales[0]!;
    const numScales = ms.datasets.length;

    // Determine bit depth from dtype
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
        // Zarr stores as [z, y, x], convert to [x, y, z]
        voxelSpacing = [s[s.length - 1]!, s[s.length - 2]!, s[s.length - 3]!];
      }
    }

    // Build LOD levels with virtual dimensions for uniform 2:1 downsampling
    const lod0Shape = arrays[0]!.shape; // [z, y, x]
    const lod0Dims: [number, number, number] = [
      lod0Shape[lod0Shape.length - 1]!, // x
      lod0Shape[lod0Shape.length - 2]!, // y
      lod0Shape[lod0Shape.length - 3]!, // z
    ];

    const lodParams: LodParams[] = [];
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

      return {
        lod: i,
        dimensions: [virtualDimX, virtualDimY, virtualDimZ] as [number, number, number],
        brickGrid,
        brickCount: brickGrid[0] * brickGrid[1] * brickGrid[2],
      };
    });

    // Extract OMERO window metadata if available
    let windowMeta: { start: number; end: number; min: number; max: number } | undefined;
    const omeroAttr = omeAttr?.omero;
    if (omeroAttr?.channels?.[0]?.window) {
      windowMeta = omeroAttr.channels[0].window;
    }

    const metadata: VolumeMetadata = {
      name,
      dimensions: levels[0]!.dimensions,
      voxelSpacing,
      brickSize: LOGICAL_BRICK_SIZE,
      physicalBrickSize: PHYSICAL_BRICK_SIZE,
      maxLod: numScales - 1,
      levels,
      bitDepth,
      window: windowMeta,
    };

    return { metadata, lodParams };
  }
}
