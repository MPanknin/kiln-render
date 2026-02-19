/**
 * Kiln Configuration
 *
 * Centralized configuration for volume rendering constants.
 * These values define the structure of the virtual texturing system.
 */

// Core constants
export const LOGICAL_BRICK_SIZE = 64;
export const PHYSICAL_BRICK_SIZE = 66; // 64 + 1 voxel padding on each side
export const ATLAS_SIZE = 528;         // Grid slots * physical brick size - 528, 660, 792, etc.
export const MAX_BRICK_TRAVERSALS = 512; // Upper bound for shader loop termination

// Derived constants - GRID_SIZE determines how many bricks fit in the atlas
// ATLAS_SIZE = GRID_SIZE * PHYSICAL_BRICK_SIZE
// 528 = 8 * 66, 660 = 10 * 66, 792 = 12 * 66, etc.
export const GRID_SIZE = Math.floor(ATLAS_SIZE / PHYSICAL_BRICK_SIZE);
export const TOTAL_BRICK_SLOTS = GRID_SIZE * GRID_SIZE * GRID_SIZE;

// For backward compatibility with existing code
export const BRICK_SIZE = LOGICAL_BRICK_SIZE;

// Dataset dimensions (can be reconfigured dynamically)
// Default: small test volume
let datasetSize: [number, number, number] = [512, 256, 512];
let voxelSpacing: [number, number, number] = [1, 1, 1];

// Empty brick threshold: bricks with max intensity below this are skipped
// Lower values = more conservative (fewer skipped bricks)
// Higher values = more aggressive culling (may miss low-intensity data)
let emptyBrickThreshold = 100;

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

export function getEmptyBrickThreshold(): number {
  return emptyBrickThreshold;
}

export function setEmptyBrickThreshold(threshold: number): void {
  emptyBrickThreshold = threshold;
  console.log(`Empty brick threshold set to ${threshold}`);
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

// Grouped config object (static constants only — use getter functions for dynamic values)
export const CONFIG = {
  LOGICAL_BRICK_SIZE,
  PHYSICAL_BRICK_SIZE,
  BRICK_SIZE,
  ATLAS_SIZE,
  GRID_SIZE,
  TOTAL_BRICK_SLOTS,
  MAX_BRICK_TRAVERSALS,
} as const;
