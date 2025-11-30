/**
 * Kiln Configuration
 *
 * Centralized configuration for volume rendering constants.
 * These values define the structure of the virtual texturing system.
 */

// Core constants
export const BRICK_SIZE = 64;    // Each brick is 64³ voxels
export const ATLAS_SIZE = 768;   // Volume atlas texture size

// Dataset dimensions (the actual volume being visualized)
// This defines the virtual volume space, independent of atlas size
export const DATASET_SIZE: [number, number, number] = [512, 512, 512];

// Computed constants (derived from core constants)
export const GRID_SIZE = ATLAS_SIZE / BRICK_SIZE;  // 12 bricks per dimension (atlas capacity)
export const TOTAL_BRICK_SLOTS = GRID_SIZE ** 3;   // 1728 slots total

// Dataset brick grid (how many bricks the dataset spans)
export const DATASET_GRID: [number, number, number] = [
  Math.ceil(DATASET_SIZE[0] / BRICK_SIZE),
  Math.ceil(DATASET_SIZE[1] / BRICK_SIZE),
  Math.ceil(DATASET_SIZE[2] / BRICK_SIZE),
];

// Normalized proxy dimensions (largest = 1.0, others proportional)
const maxDim = Math.max(...DATASET_SIZE);
export const NORMALIZED_SIZE: [number, number, number] = [
  DATASET_SIZE[0] / maxDim,
  DATASET_SIZE[1] / maxDim,
  DATASET_SIZE[2] / maxDim,
];

// Grouped config object for convenience
export const CONFIG = {
  BRICK_SIZE,
  ATLAS_SIZE,
  GRID_SIZE,
  TOTAL_BRICK_SLOTS,
  DATASET_SIZE,
  DATASET_GRID,
  NORMALIZED_SIZE,
} as const;
