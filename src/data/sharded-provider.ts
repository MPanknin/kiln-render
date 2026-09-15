/**
 * ShardedDataProvider - Loads volume data from Kiln's native sharded format
 * (volume.json + lodN.bin + lodN_index.json) using HTTP Range requests.
 */

import { DecompressionPool } from './decompression-pool.js';
import { NetworkTracker, RollingAvg } from './network-tracker.js';
import { convertBrickBytes, brickElementView } from './brick-convert.js';
import type { TargetFormat } from './brick-convert.js';
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
  private lodIndexLoads = new Map<number, Promise<ShardedLodIndex>>();
  private networkTracker = new NetworkTracker();
  private pool: DecompressionPool | null = null;
  private targetFormat: TargetFormat = 'r16unorm';
  private fetchAvg = new RollingAvg();
  private assemblyAvg = new RollingAvg();

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /** Set the target texture format for brick data. Must be called before the first brick load. */
  setTargetFormat(format: TargetFormat): void {
    this.targetFormat = format;
    this.pool?.setTargetFormat(format);
  }

  /**
   * Initialize the provider by loading volume.json
   */
  async initialize(): Promise<VolumeMetadata> {
    if (this.metadata) return this.metadata;

    this.rawMetadata = await this.fetchJson<ShardedVolumeJson>(`${this.basePath}/volume.json`, 'volume metadata');
    this.metadata = this.convertMetadata(this.rawMetadata);

    return this.metadata;
  }

  /** GET a JSON document, counting it in the network stats. */
  private async fetchJson<T>(url: string, what: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load ${what}: ${response.statusText}`);
    }
    const text = await response.text();
    this.networkTracker.record(text.length);
    return JSON.parse(text) as T;
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
  /** Loads each LOD index once; concurrent callers share the in-flight request. */
  private loadLodIndex(lod: number): Promise<ShardedLodIndex> {
    const cached = this.lodIndices.get(lod);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.lodIndexLoads.get(lod);
    if (inFlight) return inFlight;

    if (!this.rawMetadata) {
      return Promise.reject(new Error('Metadata not loaded'));
    }
    const level = this.rawMetadata.levels.find(l => l.lod === lod);
    if (!level) {
      return Promise.reject(new Error(`LOD level ${lod} not found`));
    }

    const load = this.fetchJson<ShardedLodIndex>(`${this.basePath}/${level.indexFile}`, `LOD ${lod} index`)
      .then(index => {
        this.lodIndices.set(lod, index);
        return index;
      })
      .finally(() => this.lodIndexLoads.delete(lod));
    this.lodIndexLoads.set(lod, load);
    return load;
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

      if (!this.isValidRangeResponse(response, entry)) {
        console.warn(`Brick ${brickKey}: server did not honour the byte range (status ${response.status})`);
        void response.body?.cancel();
        return null;
      }

      const buffer = await response.arrayBuffer();
      this.networkTracker.record(buffer.byteLength);
      this.fetchAvg.add(performance.now() - tFetch);
      if (buffer.byteLength !== entry.size) {
        console.warn(`Brick ${brickKey}: expected ${entry.size} bytes, received ${buffer.byteLength}`);
        return null;
      }

      // Assembly: decompress + dtype conversion to the target texture format
      const tAssembly = performance.now();
      const isCompressed = index.compressed ?? this.rawMetadata.compressed ?? false;
      const source = this.rawMetadata.format;

      let data: BrickData;
      if (isCompressed) {
        if (!this.pool) {
          this.pool = new DecompressionPool();
          this.pool.setTargetFormat(this.targetFormat);
        }
        data = brickElementView(await this.pool.decompress(buffer, source), source, this.targetFormat);
      } else {
        data = convertBrickBytes(new Uint8Array(buffer), source, this.targetFormat);
      }
      this.assemblyAvg.add(performance.now() - tAssembly);

      return { data, min: entry.min, max: entry.max, avg: entry.avg };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      console.warn(`Error loading brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  /** 206: Content-Range must match when readable (CORS often hides it; body length is checked after).
   *  200: only acceptable if Content-Length is exactly the brick, i.e. the server ignored Range. */
  private isValidRangeResponse(response: Response, entry: ShardedBrickEntry): boolean {
    if (response.status === 206) {
      const contentRange = response.headers.get('content-range');
      if (contentRange === null) return true;
      const match = /^bytes (\d+)-(\d+)\//.exec(contentRange);
      return !!match && Number(match[1]) === entry.offset && Number(match[2]) === entry.offset + entry.size - 1;
    }
    if (response.status === 200) {
      return Number(response.headers.get('content-length')) === entry.size;
    }
    return false;
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
    this.lodIndexLoads.clear();
    this.pool?.terminate();
    this.pool = null;
  }
}

