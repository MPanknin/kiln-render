/**
 * BrickLoader - Loads decomposed volume bricks from disk
 *
 * Fetches brick.json metadata and provides async loading of individual bricks.
 * Works with the output from scripts/decompose-volume.ts
 */

export interface BrickMetadata {
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
}

export class BrickLoader {
  private basePath: string;
  private metadata: BrickMetadata | null = null;
  private cache = new Map<string, Uint8Array>();

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Load metadata from brick.json
   */
  async loadMetadata(): Promise<BrickMetadata> {
    if (this.metadata) return this.metadata;

    const response = await fetch(`${this.basePath}/brick.json`);
    if (!response.ok) {
      throw new Error(`Failed to load brick metadata: ${response.statusText}`);
    }

    this.metadata = await response.json();
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
   * Load a single brick
   * Returns Uint8Array of brick data (64^3 = 262144 bytes for uint8)
   */
  async loadBrick(lod: number, bx: number, by: number, bz: number): Promise<Uint8Array | null> {
    const key = `lod${lod}:${bx}-${by}-${bz}`;

    // Check cache first
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    // Validate coordinates
    const meta = this.getMetadata();
    const level = meta.levels.find(l => l.lod === lod);
    if (!level) return null;

    if (bx < 0 || bx >= level.bricks[0] ||
        by < 0 || by >= level.bricks[1] ||
        bz < 0 || bz >= level.bricks[2]) {
      return null;
    }

    // Fetch the brick
    const url = `${this.basePath}/lod${lod}/brick-${bx}-${by}-${bz}.raw`;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;

      const buffer = await response.arrayBuffer();
      const data = new Uint8Array(buffer);

      // Cache it
      this.cache.set(key, data);
      return data;
    } catch (e) {
      console.warn(`Failed to load brick ${key}:`, e);
      return null;
    }
  }

  /**
   * Preload all bricks at a given LOD level
   * Useful for loading the coarsest level on startup
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
   * Returns a map of levelName -> Map<key, Uint8Array>
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
 * Create a pyramid structure from BrickLoader that's compatible with existing code
 * This is a convenience function for easy integration
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
