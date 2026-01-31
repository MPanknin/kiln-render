/**
 * DataProvider - Abstract interface for volume data sources
 *
 * This interface decouples the renderer from specific file formats.
 * Implementations handle format-specific details (HTTP fetching, decompression,
 * metadata parsing) while exposing a uniform API for brick streaming.
 *
 * Current implementations:
 * - ShardedDataProvider: Kiln's native sharded binary format
 *
 * Future implementations could include:
 * - ZarrDataProvider: OME-NGFF/Zarr format
 * - NiftiDataProvider: NIfTI medical imaging format
 * - DicomDataProvider: DICOM series
 */

/** Bit depth for volume data */
export type BitDepth = 8 | 16;

/** Typed array for brick voxel data */
export type BrickData = Uint8Array | Uint16Array;

/**
 * Statistics for a single brick (used for empty brick detection)
 */
export interface BrickStats {
  min: number;
  max: number;
  avg: number;
}

/**
 * Information about a single LOD level
 */
export interface LodLevel {
  /** LOD index (0 = finest, higher = coarser) */
  lod: number;
  /** Volume dimensions at this LOD level */
  dimensions: [number, number, number];
  /** Number of bricks in each axis */
  brickGrid: [number, number, number];
  /** Total number of bricks at this level */
  brickCount: number;
}

/**
 * Format-agnostic volume metadata
 * Contains only information the renderer needs to know
 */
export interface VolumeMetadata {
  /** Human-readable name */
  name: string;
  /** Original volume dimensions in voxels */
  dimensions: [number, number, number];
  /** Physical voxel spacing (optional, for correct aspect ratio) */
  voxelSpacing?: [number, number, number];
  /** Logical brick size (e.g., 64) */
  brickSize: number;
  /** Physical brick size including ghost voxels (e.g., 66) */
  physicalBrickSize: number;
  /** Maximum LOD index (coarsest level) */
  maxLod: number;
  /** Information about each LOD level */
  levels: LodLevel[];
  /** Bit depth of volume data */
  bitDepth: BitDepth;
}

/**
 * Network/loading statistics for monitoring
 */
export interface NetworkStats {
  /** Total bytes downloaded since start */
  totalBytesDownloaded: number;
  /** Recent download rate in bytes/second */
  recentBytesPerSecond: number;
  /** Total number of HTTP requests made */
  requestCount: number;
}

/**
 * Abstract interface for volume data providers
 *
 * Implementations must handle:
 * - Loading and parsing format-specific metadata
 * - Fetching brick data (network, filesystem, etc.)
 * - Decompression if applicable
 * - Converting to appropriate TypedArray based on bit depth
 */
export interface DataProvider {
  /**
   * Initialize the provider and load volume metadata
   * Must be called before any other methods
   */
  initialize(): Promise<VolumeMetadata>;

  /**
   * Get the loaded metadata
   * Throws if initialize() hasn't been called
   */
  getMetadata(): VolumeMetadata;

  /**
   * Get the bit depth of the volume (8 or 16)
   */
  getBitDepth(): BitDepth;

  /**
   * Get the brick grid dimensions for a specific LOD level
   */
  getBrickGrid(lod: number): [number, number, number];

  /**
   * Load a single brick's voxel data
   *
   * @param lod - LOD level (0 = finest)
   * @param bx - Brick X coordinate
   * @param by - Brick Y coordinate
   * @param bz - Brick Z coordinate
   * @returns Brick data as Uint8Array or Uint16Array, or null if not found
   */
  loadBrick(lod: number, bx: number, by: number, bz: number): Promise<BrickData | null>;

  /**
   * Check if a brick is empty (below threshold)
   * Used to skip loading/rendering of empty regions
   *
   * @param lod - LOD level
   * @param bx - Brick X coordinate
   * @param by - Brick Y coordinate
   * @param bz - Brick Z coordinate
   * @param maxThreshold - Optional custom threshold (default from config)
   * @returns true if brick is empty/should be skipped
   */
  isBrickEmpty(lod: number, bx: number, by: number, bz: number, maxThreshold?: number): Promise<boolean>;

  /**
   * Get statistics for a specific brick
   * Returns null if stats are not available
   */
  getBrickStats(lod: number, bx: number, by: number, bz: number): Promise<BrickStats | null>;

  /**
   * Get network/loading statistics
   */
  getNetworkStats(): NetworkStats;

  /**
   * Clean up resources (workers, caches, etc.)
   */
  dispose(): void;
}
