/**
 * kiln-render — public API
 *
 * Everything a consumer needs to embed a volume renderer:
 *   import { KilnViewer } from 'kiln-render';
 *   const viewer = await KilnViewer.create(canvas, url);
 */

// Viewer
export { KilnViewer } from './viewer.js';
export type { ViewerOptions, ViewerState } from './viewer.js';

// Data provider interface (implement this to support custom formats)
export type {
  DataProvider,
  VolumeMetadata,
  LodLevel,
  BrickData,
  BrickStats,
  BitDepth,
  NetworkStats,
} from './data/data-provider.js';
export { UnsupportedDatasetError } from './data/data-provider.js';
