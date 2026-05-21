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
import { UnsupportedDatasetError } from './data-provider.js';
import { NetworkTracker } from './network-tracker.js';
import { extractMultiscales, normalizeAxes, validateZarrSupport } from './zarr-validator.js';

/** OME-NGFF multiscales metadata (from group attributes) */
export interface OmeMultiscales {
  // may be string[] (v0.4) or {name,type}[] (v0.5) or absent — use normalizeAxes()
  // this needs to be hardened once the spec has settled
  axes?: unknown; 
  datasets: { path: string; coordinateTransformations?: { type: string; scale?: number[] }[] }[];
  coordinateTransformations?: { type: string; scale?: number[] }[]; // v0.4 group-level fallback
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
  /** Number of non-spatial prefix dims before [z, y, x] (e.g. 1 for [c, z, y, x]). */
  shapePrefixLength: number;
  /** Index of the channel axis within the full shape array (-1 if no channel axis). */
  channelAxisIdx: number;
}

/**
 * Abstract base class for Zarr providers
 */
export abstract class BaseZarrProvider implements DataProvider {
  protected metadata: VolumeMetadata | null = null;
  protected brickStatsCache = new Map<string, BrickStats>();
  private networkTracker = new NetworkTracker();

  // Abstract methods that subclasses must implement
  abstract initialize(): Promise<VolumeMetadata>;
  abstract loadBrick(lod: number, bx: number, by: number, bz: number, channelIndex?: number): Promise<BrickData | null>;
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
    return this.networkTracker.getStats();
  }

  /**
   * Record download/read for statistics tracking
   */
  protected recordDownload(bytes: number): void {
    this.networkTracker.record(bytes);
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

    const ms = extractMultiscales(attrs) as OmeMultiscales | null;
    if (!ms) {
      throw new UnsupportedDatasetError(['No OME-NGFF multiscales metadata found']);
    }

    const numScales = ms.datasets.length;

    // Parse axes to detect channel axis and number of channels
    const axisNames = normalizeAxes(ms.axes);
    const channelAxisIdx = axisNames.findIndex(a => a.type === 'channel');
    const numChannels = channelAxisIdx >= 0
      ? Math.max(1, arrays[0]!.shape[channelAxisIdx] ?? 1)
      : 1;

    // Safety-net validation (catches direct ?dataset= URL loads that bypassed dialog pre-check)
    const dtype = arrays[0]!.dtype;
    const validationReasons = validateZarrSupport(ms, arrays[0]!.shape, String(dtype));
    if (validationReasons.length > 0) throw new UnsupportedDatasetError(validationReasons);

    // Determine bit depth from dtype (validation above ensures only uint8/uint16 reach here)
    let bitDepth: BitDepth;
    if (dtype === 'uint8' || dtype === 'int8') {
      bitDepth = 8;
    } else if (dtype === 'uint16' || dtype === 'int16') {
      bitDepth = 16;
    } else {
      bitDepth = 8; // unreachable after validation, satisfies type checker
    }

    // Compute voxel spacing from coordinateTransformations if available.
    // also needs to be hardened once the spec has settled
    // v0.5: per-dataset transforms; v0.4: may be at group level instead.
    let voxelSpacing: [number, number, number] | undefined;
    const transforms = ms.datasets[0]?.coordinateTransformations ?? ms.coordinateTransformations;
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
        shapePrefixLength: shape.length - 3,
        channelAxisIdx,
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

    // Extract OMERO window metadata if available (per-channel and backward-compat single)
    type WindowEntry = { start: number; end: number; min: number; max: number };
    let windowMeta: WindowEntry | undefined;
    let channelWindows: Array<WindowEntry | undefined> | undefined;
    const omeroAttr = omeAttr?.omero;
    if (Array.isArray(omeroAttr?.channels) && omeroAttr.channels.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channelWindows = omeroAttr.channels.map((ch: any) => ch?.window as WindowEntry | undefined);
      windowMeta = channelWindows[0];
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
      channelWindows,
      numChannels,
    };

    return { metadata, lodParams };
  }
}
