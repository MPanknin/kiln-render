/**
 * DataProvider - Abstract interface for volume data sources.
 * Decouples the renderer from file formats (Zarr, sharded binary).
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

/** Result of loading a single brick: voxel data + inline statistics. */
export interface BrickLoadResult {
  data: BrickData;
  min: number;
  max: number;
  avg: number;
  /** Raw-space min (float datasets only — before normalisation to [0, 65535]) */
  rawMin?: number;
  /** Raw-space max (float datasets only — before normalisation to [0, 65535]) */
  rawMax?: number;
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
  /** Window/level metadata (optional, from OMERO or similar) — first channel */
  window?: {
    start: number;
    end: number;
    min: number;
    max: number;
  };
  /** Per-channel window/level metadata (optional, from OMERO or similar) */
  channelWindows?: Array<{ start: number; end: number; min: number; max: number } | undefined>;
  /** Number of channels in the volume (1 for single-channel, N for multi-channel) */
  numChannels: number;
  /** Whether source data is floating-point (float32/float64) */
  isFloat?: boolean;
  /** Data range [min, max] in original float values, used for normalisation to [0, 65535] */
  dataRange?: [number, number];
  /** Compression codec used by the zarr array (e.g. 'zstd', 'blosc/lz4', 'gzip', 'none') */
  compression?: string;
}

/**
 * Per-stage pipeline timing averages (rolling window over recent bricks).
 * All values are milliseconds per brick. Zero means no data yet.
 */
export interface PipelineTimings {
  /** Avg queue wait: dispatch → worker starts processing (ms per brick) */
  avgQueueMs: number;
  /** Avg time for chunk I/O (filesystem read or HTTP fetch + decompress) per brick */
  avgFetchMs: number;
  /** Avg time for brick assembly loop (voxel scatter + any format conversion) per brick */
  avgAssemblyMs: number;
  /** Avg time for GPU atlas upload (writeTexture) per brick */
  avgUploadMs: number;
  /** Number of bricks in the rolling sample window */
  sampleCount: number;
  /** Per-worker chunk cache hit ratio (0–1). Measures bandwidth amplification quality. */
  chunkCacheHitRatio?: number;
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
 * Thrown when a zarr dataset is valid but uses features not yet supported.
 * Carries specific reasons so the importer dialog can display them.
 */
export class UnsupportedDatasetError extends Error {
  constructor(public readonly reasons: string[]) {
    super(reasons.join('; '));
    this.name = 'UnsupportedDatasetError';
  }
}

/** Abstract interface for volume data providers. */
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
   * Get the brick grid dimensions for a specific LOD level
   */
  getBrickGrid(lod: number): [number, number, number];

  /** Load a single brick's voxel data with inline statistics. */
  loadBrick(lod: number, bx: number, by: number, bz: number, channelIndex?: number, signal?: AbortSignal): Promise<BrickLoadResult | null>;

  /** Check if a brick is empty (below threshold). */
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
   * Get per-stage pipeline timing averages (optional — returns zeros if not implemented)
   */
  getPipelineTimings?(): PipelineTimings;

  /**
   * Update the float normalisation range after base LOD range derivation.
   * Only relevant for float zarr datasets with worker pools.
   */
  setFloatRange?(min: number, max: number): Promise<void>;

  /**
   * Clean up resources (workers, caches, etc.)
   */
  dispose(): void;
}
