/**
 * BaseZarrProvider - Shared base for OME-Zarr metadata parsing, LOD calculation,
 * and brick stats. Subclassed by ZarrDataProvider (HTTP) and LocalZarrDataProvider (FS).
 */

import type { Array as ZarrArray } from 'zarrita';
import type { DataType } from 'zarrita';
import { LOGICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE } from '../core/config.js';
import type {
  DataProvider,
  VolumeMetadata,
  LodLevel,
  BrickLoadResult,
  BrickStats,
  BitDepth,
  NetworkStats,
} from './data-provider.js';
import { UnsupportedDatasetError } from './data-provider.js';
import { NetworkTracker } from './network-tracker.js';
import { extractMultiscales, normalizeAxes, validateZarrSupport } from './zarr-validator.js';
import { estimateBrickChunkFanout } from './chunk-math.js';

/** OME-NGFF multiscales metadata (from group attributes) */
export interface OmeMultiscales {
  // may be string[] (v0.4) or {name,type}[] (v0.5) or absent — use normalizeAxes()
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

/** Detect the compression codec from zarr v2 (.zarray) or v3 (zarr.json) metadata. */
export async function detectCompression(
  store: { get: (key: any) => Promise<Uint8Array | undefined> },
  arrayPath: string,
): Promise<string | undefined> {
  const tryParse = async (key: string): Promise<any> => {
    const bytes = await store.get(key).catch(() => undefined);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  };

  // Zarr v2: .zarray has a "compressor" field
  const v2 = await tryParse(`/${arrayPath}/.zarray`);
  if (v2) {
    const c = v2.compressor;
    if (!c) return undefined;
    return c.id === 'blosc' ? `blosc/${c.cname ?? 'lz4'}` : String(c.id);
  }

  // Zarr v3: zarr.json has a "codecs" array
  const v3 = await tryParse(`/${arrayPath}/zarr.json`);
  if (v3?.codecs) {
    const comp = (v3.codecs as { name: string }[]).find(c =>
      ['blosc', 'zstd', 'gzip', 'zlib', 'bz2', 'lz4'].includes(c.name)
    );
    return comp?.name;
  }

  return undefined;
}

/**
 * Abstract base class for Zarr providers
 */
export abstract class BaseZarrProvider implements DataProvider {
  // Bounds long panning sessions on multi-gigabyte datasets — otherwise one
  // entry accumulates per brick ever touched, cleared only on dispose().
  private static readonly MAX_STATS_ENTRIES = 100_000;

  protected metadata: VolumeMetadata | null = null;
  protected brickStatsCache = new Map<string, BrickStats>();
  private networkTracker = new NetworkTracker();

  // Abstract methods that subclasses must implement
  abstract initialize(): Promise<VolumeMetadata>;
  abstract loadBrick(lod: number, bx: number, by: number, bz: number, channelIndex?: number, signal?: AbortSignal): Promise<BrickLoadResult | null>;
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
    const stats = this.brickStatsCache.get(key);
    if (stats) {
      // Move to end (most recently used) — Maps preserve insertion order.
      this.brickStatsCache.delete(key);
      this.brickStatsCache.set(key, stats);
    }
    return stats ?? null;
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
  protected recordDownload(bytes: number, requests = 1): void {
    this.networkTracker.record(bytes, requests);
  }

  /**
   * Cache brick statistics
   */
  protected cacheBrickStats(lod: number, bx: number, by: number, bz: number, stats: BrickStats): void {
    const key = `${lod}:${bx}/${by}/${bz}`;
    const existing = this.brickStatsCache.get(key);
    if (existing) {
      // Multiple channels update the same key — keep the max across all channels.
      // isBrickEmpty should return true only if ALL channels are below the threshold,
      // not just whichever channel happened to write last.
      this.brickStatsCache.delete(key);
      this.brickStatsCache.set(key, {
        min: Math.min(existing.min, stats.min),
        max: Math.max(existing.max, stats.max),
        avg: (existing.avg + stats.avg) / 2,
      });
    } else {
      this.brickStatsCache.set(key, stats);
    }

    // Evict oldest (least recently used/inserted) entries once over the cap.
    while (this.brickStatsCache.size > BaseZarrProvider.MAX_STATS_ENTRIES) {
      const oldest = this.brickStatsCache.keys().next().value!;
      this.brickStatsCache.delete(oldest);
    }
  }

  /**
   * Parse OME-Zarr metadata and build VolumeMetadata.
   * @internal — takes zarrita `Array` types; not part of the public API surface.
   *   Stripped from emitted .d.ts (stripInternal) so `zarrita` doesn't leak into
   *   published types (consumers don't install it — it's bundled).
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

    // Parse axes — supports both v0.4 string arrays and v0.5 typed objects
    const axisNames = normalizeAxes(ms.axes);
    const channelAxisIdx = axisNames.findIndex(a => a.type === 'channel');
    const numChannels = channelAxisIdx >= 0
      ? Math.max(1, arrays[0]!.shape[channelAxisIdx] ?? 1)
      : 1;

    // Safety-net validation (catches direct ?dataset= URL loads that bypassed dialog pre-check)
    const dtype = arrays[0]!.dtype;
    const validationReasons = validateZarrSupport(ms, arrays[0]!.shape, String(dtype));
    if (validationReasons.length > 0) throw new UnsupportedDatasetError(validationReasons);

    // Determine bit depth from dtype
    const dtypeStr = String(dtype);
    let bitDepth: BitDepth;
    let isFloat = false;
    if (dtypeStr === 'uint8' || dtypeStr === 'int8') {
      bitDepth = 8;
    } else if (dtypeStr === 'uint16' || dtypeStr === 'int16') {
      bitDepth = 16;
    } else if (dtypeStr === 'float32' || dtypeStr === 'float64') {
      // Float data is normalised to [0, 65535] in the worker → 16-bit pipeline
      bitDepth = 16;
      isFloat = true;
    } else {
      bitDepth = 8; // unreachable after validation, satisfies type checker
    }

    // Compute voxel spacing from coordinateTransformations if available.
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
    // Chunk size along the channel axis per LOD — diagnostic-only (see P1
    // below), not part of LodParams since workers don't need it.
    const cChunkSizes: number[] = [];
    const levels: LodLevel[] = arrays.map((arr, i) => {
      const shape = arr.shape;
      const actualDimX = shape[shape.length - 1]!;
      const actualDimY = shape[shape.length - 2]!;
      const actualDimZ = shape[shape.length - 3]!;

      const virtualDimX = Math.ceil(lod0Dims[0] / (1 << i));
      const virtualDimY = Math.ceil(lod0Dims[1] / (1 << i));
      const virtualDimZ = Math.ceil(lod0Dims[2] / (1 << i));

      const chunkShape = arr.chunks;
      const shapePrefixLength = shape.length - 3;
      cChunkSizes.push(
        channelAxisIdx >= 0 && channelAxisIdx < shapePrefixLength ? (chunkShape[channelAxisIdx] ?? 1) : 1,
      );
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
        shapePrefixLength,
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

    // For float data, derive initial dataRange from OMERO window (absolute min/max).
    // If no OMERO window is present, the caller must scan the coarsest LOD to fill this in.
    let dataRange: [number, number] | undefined;
    if (isFloat && windowMeta) {
      dataRange = [windowMeta.min, windowMeta.max];
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
      isFloat,
      dataRange,
    };

    // --- P1 diagnostic (zero behavior change) ---------------------------------
    // Confirms the fetch-fanout hypothesis from the audit before any patch
    // touches real behavior: for each LOD, estimate how many Zarr chunks one
    // brick footprint can touch (worst case, independent of brick position),
    // per channel. See docs/audits/kiln-render - fetch_patterns.md.
    lodParams.forEach((p, lod) => {
      const fanout = estimateBrickChunkFanout(p, PHYSICAL_BRICK_SIZE);
      console.log(
        `[Kiln] LOD ${lod}: chunk shape ${p.csx}×${p.csy}×${p.csz}, fanout ${fanout} ` +
        `chunks/brick/channel (×${numChannels}ch = ${fanout * numChannels} chunk fetches/brick)`,
      );
      if (lod === 0 && fanout * numChannels > 16) {
        console.warn(
          `[Kiln] LOD 0 fanout×channels = ${fanout * numChannels} — each brick may require this many ` +
          `chunk fetches. If load times are a problem, consider re-chunking the source dataset to ` +
          `≥64 per axis (or Zarr v3 sharding).`,
        );
      }
      // B3 (latent correctness bug): chunk-coordinate math assumes channel
      // chunk size 1 (prefix[channelAxisIdx] = channelIndex). If a chunk packs
      // more than one channel, this reads the wrong voxels for channels
      // beyond the first in each chunk — silently, with no error thrown.
      const cChunkSize = cChunkSizes[lod] ?? 1;
      if (cChunkSize > 1) {
        console.error(
          `[Kiln] LOD ${lod}: channel chunk size is ${cChunkSize} (>1) — this dataset packs multiple ` +
          `channels per chunk. Kiln's chunk-coordinate calculation assumes channel chunk size 1 and ` +
          `will read the WRONG voxels for channels beyond the first in each chunk. Do not trust ` +
          `rendered output for non-first channels on this dataset (known limitation, audit bug B3).`,
        );
      }
    });

    return { metadata, lodParams };
  }
}
