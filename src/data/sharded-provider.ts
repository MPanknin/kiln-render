/**
 * ShardedDataProvider - Loads volume data from Kiln's native sharded format
 * (volume.json + lodN.bin + lodN_index.json) using HTTP Range requests.
 */

import { DecompressionPool } from './decompression-pool.js';
import { NetworkTracker, RollingAvg } from './network-tracker.js';
import type {
  DataProvider,
  VolumeMetadata,
  LodLevel,
  BrickData,
  BrickLoadResult,
  BrickStats,
  NetworkStats,
  PipelineTimings,
} from './data-provider.js';

/** Format-specific metadata from volume.json */
interface ShardedVolumeJson {
  name: string;
  originalDimensions: [number, number, number];
  voxelSpacing: [number, number, number];
  brickSize: number;
  physicalSize: number;
  maxLod: number;
  levels: {
    lod: number;
    dimensions: [number, number, number];
    bricks: [number, number, number];
    brickCount: number;
    binFile: string;
    indexFile: string;
  }[];
  format: 'uint8' | 'uint16';
  packed: true;
  compressed?: boolean;
  createdAt: string;
}

/** Format-specific LOD index structure */
interface ShardedLodIndex {
  lod: number;
  brickSize: number;
  physicalSize: number;
  bricks: [number, number, number];
  totalBricks: number;
  totalBytes: number;
  compressed?: boolean;
  entries: Record<string, ShardedBrickEntry>;
}

/** Entry in the LOD index */
interface ShardedBrickEntry {
  offset: number;
  size: number;
  min: number;
  max: number;
  avg: number;
}

/**
 * DataProvider implementation for Kiln's sharded binary format
 */
export class ShardedDataProvider implements DataProvider {
  private basePath: string;
  private rawMetadata: ShardedVolumeJson | null = null;
  private metadata: VolumeMetadata | null = null;
  private lodIndices = new Map<number, ShardedLodIndex>();
  private networkTracker = new NetworkTracker();
  private pool: DecompressionPool | null = null;
  private fetchAvg = new RollingAvg();
  private assemblyAvg = new RollingAvg();

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Set the target texture format for decompressed brick data.
   * Must be called before the first brick load.
   */
  setTargetFormat(format: 'r8unorm' | 'r16unorm' | 'r16float'): void {
    if (this.pool) {
      this.pool.setTargetFormat(format);
    } else {
      // Pool not yet created — store the format so we can apply it on first use
      this.pool = new DecompressionPool();
      this.pool.setTargetFormat(format);
    }
  }

  /**
   * Initialize the provider by loading volume.json
   */
  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    const response = await fetch(`${this.basePath}/volume.json`);
    if (!response.ok) {
      throw new Error(`Failed to load volume metadata: ${response.statusText}`);
    }

    this.rawMetadata = await response.json();
    this.metadata = this.convertMetadata(this.rawMetadata!);

    return this.metadata;
  }

  /**
   * Convert format-specific metadata to generic VolumeMetadata
   */
  private convertMetadata(raw: ShardedVolumeJson): VolumeMetadata {
    const levels: LodLevel[] = raw.levels.map(level => ({
      lod: level.lod,
      dimensions: level.dimensions,
      brickGrid: level.bricks,
      brickCount: level.brickCount,
    }));

    return {
      name: raw.name,
      dimensions: raw.originalDimensions,
      voxelSpacing: raw.voxelSpacing,
      brickSize: raw.brickSize,
      physicalBrickSize: raw.physicalSize,
      maxLod: raw.maxLod,
      levels,
      bitDepth: raw.format === 'uint16' ? 16 : 8,
      numChannels: 1,
    };
  }

  /**
   * Get the loaded metadata
   */
  getMetadata(): VolumeMetadata {
    if (!this.metadata) {
      throw new Error('Metadata not loaded. Call initialize() first.');
    }
    return this.metadata;
  }

  /**
   * Get brick grid for a LOD level
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
   * Load the index for a LOD level
   */
  private async loadLodIndex(lod: number): Promise<ShardedLodIndex> {
    if (this.lodIndices.has(lod)) {
      return this.lodIndices.get(lod)!;
    }

    if (!this.rawMetadata) {
      throw new Error('Metadata not loaded');
    }

    const level = this.rawMetadata.levels.find(l => l.lod === lod);
    if (!level) {
      throw new Error(`LOD level ${lod} not found`);
    }

    const response = await fetch(`${this.basePath}/${level.indexFile}`);
    if (!response.ok) {
      throw new Error(`Failed to load LOD index: ${response.statusText}`);
    }

    const index: ShardedLodIndex = await response.json();
    this.lodIndices.set(lod, index);
    return index;
  }

  /**
   * Get brick statistics
   */
  async getBrickStats(lod: number, bx: number, by: number, bz: number): Promise<BrickStats | null> {
    const index = await this.loadLodIndex(lod);
    const key = `${bx}/${by}/${bz}`;
    const entry = index.entries[key];
    if (!entry) return null;

    return {
      min: entry.min,
      max: entry.max,
      avg: entry.avg,
    };
  }

  /**
   * Check if brick is empty
   */
  async isBrickEmpty(lod: number, bx: number, by: number, bz: number, maxThreshold?: number): Promise<boolean> {
    const stats = await this.getBrickStats(lod, bx, by, bz);
    if (!stats) return false; // Unknown = assume non-empty
    const threshold = maxThreshold ?? 100;
    return stats.max < threshold;
  }

  /**
   * Load a single brick
   */
  async loadBrick(lod: number, bx: number, by: number, bz: number, _channelIndex?: number, signal?: AbortSignal): Promise<BrickLoadResult | null> {
    if (!this.rawMetadata) {
      throw new Error('Metadata not loaded');
    }

    // Validate coordinates
    const level = this.rawMetadata.levels.find(l => l.lod === lod);
    if (!level) return null;

    if (bx < 0 || bx >= level.bricks[0] ||
        by < 0 || by >= level.bricks[1] ||
        bz < 0 || bz >= level.bricks[2]) {
      return null;
    }

    try {
      const index = await this.loadLodIndex(lod);
      const brickKey = `${bx}/${by}/${bz}`;
      const entry = index.entries[brickKey];

      if (!entry) {
        return null;
      }

      const url = `${this.basePath}/${level.binFile}`;
      const rangeEnd = entry.offset + entry.size - 1;

      const tFetch = performance.now();
      const response = await fetch(url, {
        headers: {
          'Range': `bytes=${entry.offset}-${rangeEnd}`,
        },
        signal,
      });

      if (!response.ok && response.status !== 206) {
        console.warn(`Failed to fetch brick ${brickKey}: ${response.status}`);
        return null;
      }

      const buffer = await response.arrayBuffer();
      this.networkTracker.record(buffer.byteLength);
      this.fetchAvg.add(performance.now() - tFetch);

      // Assembly: decompress + typed array conversion
      const tAssembly = performance.now();
      const isCompressed = index.compressed ?? this.rawMetadata.compressed ?? false;

      let rawData: Uint8Array;
      if (isCompressed) {
        if (!this.pool) this.pool = new DecompressionPool();
        rawData = await this.pool.decompress(buffer);
      } else {
        rawData = new Uint8Array(buffer);
      }

      let data: BrickData;
      if (this.rawMetadata.format === 'uint16') {
        data = new Uint16Array(rawData.buffer, rawData.byteOffset, rawData.byteLength / 2);
      } else {
        data = rawData;
      }
      this.assemblyAvg.add(performance.now() - tAssembly);

      return { data, min: entry.min, max: entry.max, avg: entry.avg };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      console.warn(`Error loading brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  getNetworkStats(): NetworkStats {
    return this.networkTracker.getStats();
  }

  getPipelineTimings(): PipelineTimings {
    return {
      avgQueueMs: 0, // no worker queue in sharded provider
      avgFetchMs: this.fetchAvg.value,
      avgAssemblyMs: this.assemblyAvg.value,
      avgUploadMs: 0, // measured in StreamingManager
      sampleCount: this.fetchAvg.count,
    };
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.lodIndices.clear();
    this.pool?.terminate();
    this.pool = null;
  }
}

