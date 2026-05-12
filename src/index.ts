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

// Render state enums/types (needed to construct ViewerOptions)
export type { VolumeRenderMode } from './core/renderer.js';
export type { TFPreset } from './core/transfer-function.js';
export type { UpAxis } from './core/camera.js';

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

// Built-in providers
export { LocalZarrDataProvider } from './data/local-zarr-provider.js';

// Validation utilities
export { preValidateRemoteZarr, preValidateLocalZarr } from './data/zarr-validator.js';

// Local file loader utilities (File System Access API)
export { promptForZarrDirectory, getStoredHandle, requestPermission } from './data/local-loader.js';
export { clearHandle } from './data/handle-storage.js';
