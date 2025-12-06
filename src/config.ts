/**
 * Kiln Configuration
 *
 * Centralized configuration for volume rendering constants.
 * These values define the structure of the virtual texturing system.
 */

// Core constants (fixed)
export const BRICK_SIZE = 64;    // Each brick is 64³ voxels
export const ATLAS_SIZE = 768;   // Volume atlas texture size

// Computed atlas constants (derived from core constants)
export const GRID_SIZE = ATLAS_SIZE / BRICK_SIZE;  // 12 bricks per dimension (atlas capacity)
export const TOTAL_BRICK_SLOTS = GRID_SIZE ** 3;   // 1728 slots total

// Dataset dimensions (can be reconfigured dynamically)
// Default: small test volume
let datasetSize: [number, number, number] = [512, 256, 512];
let voxelSpacing: [number, number, number] = [1, 1, 1];

// Computed dataset properties
function computeDatasetGrid(): [number, number, number] {
  return [
    Math.ceil(datasetSize[0] / BRICK_SIZE),
    Math.ceil(datasetSize[1] / BRICK_SIZE),
    Math.ceil(datasetSize[2] / BRICK_SIZE),
  ];
}

function computeNormalizedSize(): [number, number, number] {
  // Physical size = voxel count * voxel spacing
  const physicalSize: [number, number, number] = [
    datasetSize[0] * voxelSpacing[0],
    datasetSize[1] * voxelSpacing[1],
    datasetSize[2] * voxelSpacing[2],
  ];
  const maxDim = Math.max(...physicalSize);
  return [
    physicalSize[0] / maxDim,
    physicalSize[1] / maxDim,
    physicalSize[2] / maxDim,
  ];
}

// Exported getters (use these instead of direct constants for dynamic values)
export function getDatasetSize(): [number, number, number] {
  return [...datasetSize];
}

export function getVoxelSpacing(): [number, number, number] {
  return [...voxelSpacing];
}

export function getDatasetGrid(): [number, number, number] {
  return computeDatasetGrid();
}

export function getNormalizedSize(): [number, number, number] {
  return computeNormalizedSize();
}

/**
 * Reconfigure dataset dimensions
 * Call this before initializing renderer/octree when loading a new volume
 */
export function setDatasetSize(size: [number, number, number], spacing?: [number, number, number]): void {
  datasetSize = [...size];
  if (spacing) {
    voxelSpacing = [...spacing];
  }
  console.log(`Dataset size set to ${size[0]}x${size[1]}x${size[2]}`);
  console.log(`  Voxel spacing: ${voxelSpacing.join(' x ')}`);
  console.log(`  Brick grid: ${computeDatasetGrid().join('x')}`);
  console.log(`  Normalized: ${computeNormalizedSize().map(n => n.toFixed(3)).join('x')}`);
}

// Legacy exports for compatibility (use with caution - these are snapshots)
export const DATASET_SIZE: [number, number, number] = datasetSize;
export const DATASET_GRID: [number, number, number] = computeDatasetGrid();
export const NORMALIZED_SIZE: [number, number, number] = computeNormalizedSize();

// Grouped config object for convenience
export const CONFIG = {
  BRICK_SIZE,
  ATLAS_SIZE,
  GRID_SIZE,
  TOTAL_BRICK_SLOTS,
  // These are snapshots - for dynamic values use the getter functions
  DATASET_SIZE,
  DATASET_GRID,
  NORMALIZED_SIZE,
} as const;
