/** Data module — volume data provider abstraction. */

// Core types and interface
export type {
  DataProvider,
  VolumeMetadata,
  LodLevel,
  BrickData,
  BrickStats,
  BitDepth,
  NetworkStats,
} from './data-provider.js';

// Sharded format implementation (Kiln's native format)
export { ShardedDataProvider } from './sharded-provider.js';

// OME-Zarr format implementation
export { ZarrDataProvider } from './zarr-provider.js';

// Decompression utilities
export {
  DecompressionPool,
  getDecompressionPool,
  terminateDecompressionPool,
} from './decompression-pool.js';
