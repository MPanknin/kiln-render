/// <reference types="@webgpu/types" />
/** kiln-render — public API */

// Viewer
export { KilnViewer } from './viewer.js';
export type { ViewerOptions, ViewerState, ViewerPane } from './viewer.js';

// Headless engine (bring your own device, camera and frame loop)
export { KilnEngine } from './engine.js';
export type { EngineOptions } from './engine.js';
export type { ViewParams } from './core/view.js';
export type { LoadMilestones } from './core/milestones.js';
export type { MemoryStats } from './core/memory-stats.js';
export type { PyramidLevel, PyramidPolicy } from './core/pyramid.js';

// Label layers (segmentations)
export { LabelLayer } from './labels/label-layer.js';
export type {
  LabelLayerOptions, LabelLayerState, Label3dStyle, LabelSliceStyle, LabelSegment,
} from './labels/label-layer.js';
export type { LabelManager, LabelPick, LabelHit, LabelStats } from './labels/label-manager.js';
export type { LabelImageInfo, LabelColor } from './data/label-image.js';
export { MAX_LABEL_LAYERS } from './shaders/uniform-layout.js';

// Render state enums/types (needed to construct ViewerOptions)
export type { VolumeRenderMode } from './core/renderer.js';
export type { TFPreset, OpacityPoint } from './core/transfer-function.js';
export type { Projection, UpAxis } from './core/camera.js';

// Data provider interface (implement this to support custom formats)
export type {
  SourceSelection,
  DataProvider,
  VolumeMetadata,
  LodLevel,
  BrickData,
  BrickLoadResult,
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
