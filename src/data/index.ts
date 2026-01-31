/**
 * Data module - Volume data provider abstraction
 *
 * This module provides an abstract interface for loading volume data from
 * different sources and formats. The renderer and streaming manager depend
 * only on the DataProvider interface, not on specific implementations.
 */

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
export { ShardedDataProvider, createShardedProvider } from './sharded-provider.js';

// Decompression utilities
export {
  DecompressionPool,
  getDecompressionPool,
  terminateDecompressionPool,
} from './decompression-pool.js';
