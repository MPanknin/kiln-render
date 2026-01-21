/**
 * BrickLoader - Loads volume bricks from binary sharded format
 *
 * Uses HTTP Range requests to efficiently stream individual bricks from
 * lodN.bin files, guided by lodN_index.json index files.
 * Supports gzip-compressed bricks with off-main-thread decompression.
 */

import { getEmptyBrickThreshold } from '../core/config.js';
import { getDecompressionPool } from './decompression-pool.js';

export interface BrickStats {
  offset: number;
  size: number; // Compressed size (for range reads)
  min: number;
  max: number;
  avg: number;
}

export interface LodIndex {
  lod: number;
  brickSize: number;
  physicalSize: number;
  bricks: [number, number, number];
  totalBricks: number;
  totalBytes: number;
  compressed?: boolean; // Whether bricks are gzip compressed
  entries: Record<string, BrickStats>;
}

export interface BrickMetadata {
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
  format: string;
  packed: true;
  compressed?: boolean; // Whether bricks are gzip compressed
  createdAt: string;
}

export interface NetworkStats {
  totalBytesDownloaded: number;
  recentBytesPerSecond: number;
  requestCount: number;
}

export class BrickLoader {
  private basePath: string;
  private metadata: BrickMetadata | null = null;
  private cache = new Map<string, Uint8Array>();
  private lodIndices = new Map<number, LodIndex>();

  // Network tracking
  private totalBytesDownloaded = 0;
  private requestCount = 0;
  private recentDownloads: { timestamp: number; bytes: number }[] = [];

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Get network statistics
   */
  getNetworkStats(): NetworkStats {
    // Calculate bytes per second from recent downloads (last 2 seconds)
    const now = performance.now();
    const windowMs = 2000;
    const cutoff = now - windowMs;

    // Clean old entries and sum recent bytes
    this.recentDownloads = this.recentDownloads.filter(d => d.timestamp > cutoff);
    const recentBytes = this.recentDownloads.reduce((sum, d) => sum + d.bytes, 0);
    const recentBytesPerSecond = (recentBytes / windowMs) * 1000;

    return {
      totalBytesDownloaded: this.totalBytesDownloaded,
      recentBytesPerSecond,
      requestCount: this.requestCount,
    };
  }

  /**
   * Record a download for network stats
   */
  private recordDownload(bytes: number): void {
    this.totalBytesDownloaded += bytes;
    this.requestCount++;
    this.recentDownloads.push({
      timestamp: performance.now(),
      bytes,
    });
  }

  /**
   * Load metadata from volume.json
   */
  async loadMetadata(): Promise<BrickMetadata> {
    if (this.metadata) return this.metadata;

    const response = await fetch(`${this.basePath}/volume.json`);
    if (!response.ok) {
      throw new Error(`Failed to load volume metadata: ${response.statusText}`);
    }

    this.metadata = await response.json();
    console.log(`Loaded volume: ${this.metadata!.name}`);
    return this.metadata!;
  }

  /**
   * Get metadata (must call loadMetadata first)
   */
  getMetadata(): BrickMetadata {
    if (!this.metadata) {
      throw new Error('Metadata not loaded. Call loadMetadata() first.');
    }
    return this.metadata;
  }

  /**
   * Load the index for a LOD level
   */
  private async loadLodIndex(lod: number): Promise<LodIndex> {
    if (this.lodIndices.has(lod)) {
      return this.lodIndices.get(lod)!;
    }

    const meta = this.getMetadata();
    const level = meta.levels.find(l => l.lod === lod);
    if (!level) {
      throw new Error(`LOD level ${lod} not found`);
    }

    const response = await fetch(`${this.basePath}/${level.indexFile}`);
    if (!response.ok) {
      throw new Error(`Failed to load LOD index: ${response.statusText}`);
    }

    const index: LodIndex = await response.json();
    this.lodIndices.set(lod, index);
    return index;
  }

  /**
   * Get the brick grid dimensions for a given LOD level
   */
  getBrickGrid(lod: number): [number, number, number] {
    const meta = this.getMetadata();
    const level = meta.levels.find(l => l.lod === lod);
    if (!level) {
      throw new Error(`LOD level ${lod} not found`);
    }
    return level.bricks;
  }

  /**
   * Get brick stats (min/max/avg) for a brick
   * Returns null if brick doesn't exist
   */
  async getBrickStats(lod: number, bx: number, by: number, bz: number): Promise<BrickStats | null> {
    const index = await this.loadLodIndex(lod);
    const key = `${bx}/${by}/${bz}`;
    return index.entries[key] || null;
  }

  /**
   * Check if a brick is empty or below threshold
   * Returns true if brick has max intensity below threshold
   *
   * TODO: Make threshold dynamic based on dataset intensity distribution
   */
  async isBrickEmpty(lod: number, bx: number, by: number, bz: number, maxThreshold?: number): Promise<boolean> {
    const stats = await this.getBrickStats(lod, bx, by, bz);
    if (!stats) return false; // Unknown = assume non-empty
    const threshold = maxThreshold ?? getEmptyBrickThreshold();
    return stats.max < threshold;
  }

  /**
   * Load a single brick using HTTP Range request
   * Handles gzip decompression via worker pool if data is compressed
   */
  async loadBrick(lod: number, bx: number, by: number, bz: number): Promise<Uint8Array | null> {
    const key = `lod${lod}:${bx}-${by}-${bz}`;

    // Check cache first (cache stores decompressed data)
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const meta = this.getMetadata();

    // Validate coordinates
    const level = meta.levels.find(l => l.lod === lod);
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

      const response = await fetch(url, {
        headers: {
          'Range': `bytes=${entry.offset}-${rangeEnd}`,
        },
      });

      if (!response.ok && response.status !== 206) {
        console.warn(`Failed to fetch brick ${brickKey}: ${response.status}`);
        return null;
      }

      const buffer = await response.arrayBuffer();
      this.recordDownload(buffer.byteLength);

      // Check if data is compressed (from index or metadata)
      const isCompressed = index.compressed ?? meta.compressed ?? false;

      let data: Uint8Array;
      if (isCompressed) {
        // Decompress using worker pool (off main thread)
        const pool = getDecompressionPool();
        data = await pool.decompress(buffer);
      } else {
        // Uncompressed - use directly
        data = new Uint8Array(buffer);
      }

      this.cache.set(key, data);
      return data;
    } catch (e) {
      console.warn(`Error loading brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  /**
   * Preload all bricks at a given LOD level
   */
  async preloadLevel(lod: number): Promise<Map<string, Uint8Array>> {
    const meta = this.getMetadata();
    const level = meta.levels.find(l => l.lod === lod);
    if (!level) {
      throw new Error(`LOD level ${lod} not found`);
    }

    const bricks = new Map<string, Uint8Array>();
    const [nx, ny, nz] = level.bricks;

    // Batch fetch all bricks at this level
    const promises: Promise<void>[] = [];

    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          promises.push(
            this.loadBrick(lod, x, y, z).then(data => {
              if (data) {
                const key = `${z}/${y}/${x}`;
                bricks.set(key, data);
              }
            })
          );
        }
      }
    }

    await Promise.all(promises);
    console.log(`Preloaded ${bricks.size} bricks at LOD ${lod}`);
    return bricks;
  }

  /**
   * Build a pyramid structure compatible with the existing code
   */
  async buildPyramid(): Promise<Record<string, Map<string, Uint8Array>>> {
    const meta = this.getMetadata();
    const pyramid: Record<string, Map<string, Uint8Array>> = {};

    for (const level of meta.levels) {
      const levelName = `scale${level.lod}`;
      pyramid[levelName] = await this.preloadLevel(level.lod);
    }

    return pyramid;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache stats
   */
  getCacheStats(): { entries: number; sizeBytes: number } {
    let sizeBytes = 0;
    for (const data of this.cache.values()) {
      sizeBytes += data.byteLength;
    }
    return {
      entries: this.cache.size,
      sizeBytes,
    };
  }
}

/**
 * Create a pyramid structure from BrickLoader
 */
export async function loadBrickPyramid(basePath: string): Promise<{
  pyramid: Record<string, Map<string, Uint8Array>>;
  metadata: BrickMetadata;
  loader: BrickLoader;
}> {
  const loader = new BrickLoader(basePath);
  await loader.loadMetadata();
  const metadata = loader.getMetadata();
  const pyramid = await loader.buildPyramid();

  return { pyramid, metadata, loader };
}
