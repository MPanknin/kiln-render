/**
 * BrickLoader - Loads decomposed volume bricks
 *
 * Supports two formats:
 * 1. Legacy: Individual .raw files per brick (brick.json + lodN/brick-X-Y-Z.raw)
 * 2. Packed: Binary sharded format (volume.json + lodN.bin + lodN_index.json)
 *
 * The packed format uses HTTP Range requests for efficient streaming.
 */

export interface BrickStats {
  offset: number;
  size: number;
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
  entries: Record<string, BrickStats>;
}

export interface LegacyMetadata {
  name: string;
  originalDimensions: [number, number, number];
  voxelSpacing?: [number, number, number];
  brickSize: number;
  maxLod: number;
  levels: {
    lod: number;
    dimensions: [number, number, number];
    bricks: [number, number, number];
    brickCount: number;
  }[];
  format: string;
  createdAt: string;
  packed?: false;
}

export interface PackedMetadata {
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
  createdAt: string;
}

export type BrickMetadata = LegacyMetadata | PackedMetadata;

function isPacked(meta: BrickMetadata): meta is PackedMetadata {
  return (meta as PackedMetadata).packed === true;
}

export class BrickLoader {
  private basePath: string;
  private metadata: BrickMetadata | null = null;
  private cache = new Map<string, Uint8Array>();
  private lodIndices = new Map<number, LodIndex>();

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Load metadata - tries volume.json first (packed), falls back to brick.json (legacy)
   */
  async loadMetadata(): Promise<BrickMetadata> {
    if (this.metadata) return this.metadata;

    // Try packed format first
    try {
      const response = await fetch(`${this.basePath}/volume.json`);
      if (response.ok) {
        this.metadata = await response.json();
        console.log(`Loaded packed volume: ${this.metadata!.name}`);
        return this.metadata!;
      }
    } catch {
      // Fall through to legacy
    }

    // Try legacy format
    const response = await fetch(`${this.basePath}/brick.json`);
    if (!response.ok) {
      throw new Error(`Failed to load brick metadata: ${response.statusText}`);
    }

    this.metadata = await response.json();
    console.log(`Loaded legacy volume: ${this.metadata!.name}`);
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
   * Check if this is a packed volume
   */
  isPacked(): boolean {
    return this.metadata !== null && isPacked(this.metadata);
  }

  /**
   * Load the index for a LOD level (packed format only)
   */
  private async loadLodIndex(lod: number): Promise<LodIndex> {
    if (this.lodIndices.has(lod)) {
      return this.lodIndices.get(lod)!;
    }

    const meta = this.getMetadata();
    if (!isPacked(meta)) {
      throw new Error('loadLodIndex called on non-packed volume');
    }

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
   * Get brick stats (min/max/avg) for a brick (packed format only)
   * Returns null if not available or brick doesn't exist
   */
  async getBrickStats(lod: number, bx: number, by: number, bz: number): Promise<BrickStats | null> {
    const meta = this.getMetadata();
    if (!isPacked(meta)) return null;

    const index = await this.loadLodIndex(lod);
    const key = `${bx}/${by}/${bz}`;
    return index.entries[key] || null;
  }

  /**
   * Load a single brick using range request (packed) or individual file (legacy)
   */
  async loadBrick(lod: number, bx: number, by: number, bz: number): Promise<Uint8Array | null> {
    const key = `lod${lod}:${bx}-${by}-${bz}`;

    // Check cache first
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

    let data: Uint8Array | null = null;

    if (isPacked(meta)) {
      // Packed format: use range request
      data = await this.loadBrickPacked(lod, bx, by, bz, level as PackedMetadata['levels'][0]);
    } else {
      // Legacy format: individual files
      data = await this.loadBrickLegacy(lod, bx, by, bz);
    }

    if (data) {
      this.cache.set(key, data);
    }

    return data;
  }

  /**
   * Load brick from packed binary using Range request
   */
  private async loadBrickPacked(
    lod: number,
    bx: number,
    by: number,
    bz: number,
    level: PackedMetadata['levels'][0]
  ): Promise<Uint8Array | null> {
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
      return new Uint8Array(buffer);
    } catch (e) {
      console.warn(`Error loading packed brick lod${lod}:${bx}-${by}-${bz}:`, e);
      return null;
    }
  }

  /**
   * Load brick from individual file (legacy format)
   */
  private async loadBrickLegacy(
    lod: number,
    bx: number,
    by: number,
    bz: number
  ): Promise<Uint8Array | null> {
    const url = `${this.basePath}/lod${lod}/brick-${bx}-${by}-${bz}.raw`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }

      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (e) {
      if (e instanceof TypeError && (e.message.includes('fetch') || e.message.includes('network'))) {
        console.warn(`Network error loading brick:`, e.message);
      }
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
