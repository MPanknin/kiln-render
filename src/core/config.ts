/**
 * Kiln Configuration
 *
 * Centralized configuration for volume rendering constants.
 * These values define the structure of the virtual texturing system.
 */

// Core constants
export const LOGICAL_BRICK_SIZE = 64;
export const PHYSICAL_BRICK_SIZE = 66; // 64 + 1 voxel padding on each side
export const ATLAS_SIZE = 660;         // Grid slots * physical brick size - 528, 660, 792, etc.
export const MAX_BRICK_TRAVERSALS = 512; // Upper bound for shader loop termination

// Derived constants - GRID_SIZE determines how many bricks fit in the atlas
// ATLAS_SIZE = GRID_SIZE * PHYSICAL_BRICK_SIZE
// 528 = 8 * 66, 660 = 10 * 66, 792 = 12 * 66, etc.
export const GRID_SIZE = Math.floor(ATLAS_SIZE / PHYSICAL_BRICK_SIZE);
export const TOTAL_BRICK_SLOTS = GRID_SIZE * GRID_SIZE * GRID_SIZE;

// For backward compatibility with existing code
export const BRICK_SIZE = LOGICAL_BRICK_SIZE;

// Grouped config object (static constants only)
export const CONFIG = {
  LOGICAL_BRICK_SIZE,
  PHYSICAL_BRICK_SIZE,
  BRICK_SIZE,
  ATLAS_SIZE,
  GRID_SIZE,
  TOTAL_BRICK_SLOTS,
  MAX_BRICK_TRAVERSALS,
} as const;

// ─── DatasetConfig ────────────────────────────────────────────────────────────

function computeDatasetGrid(dimensions: [number, number, number]): [number, number, number] {
  return [
    Math.ceil(dimensions[0] / BRICK_SIZE),
    Math.ceil(dimensions[1] / BRICK_SIZE),
    Math.ceil(dimensions[2] / BRICK_SIZE),
  ];
}

function computeNormalizedSize(
  dimensions: [number, number, number],
  voxelSpacing: [number, number, number],
): [number, number, number] {
  const physicalSize: [number, number, number] = [
    dimensions[0] * voxelSpacing[0],
    dimensions[1] * voxelSpacing[1],
    dimensions[2] * voxelSpacing[2],
  ];
  const maxDim = Math.max(...physicalSize);
  return [
    physicalSize[0] / maxDim,
    physicalSize[1] / maxDim,
    physicalSize[2] / maxDim,
  ];
}

/**
 * Immutable value object describing dataset geometry.
 * Computed from VolumeMetadata and injected into subsystems at construction.
 */
export class DatasetConfig {
  readonly dimensions: [number, number, number];
  readonly voxelSpacing: [number, number, number];
  /** Bricks per axis at LOD 0 */
  readonly datasetGrid: [number, number, number];
  /** Normalized extent [0–1] per axis, accounting for anisotropic voxel spacing */
  readonly normalizedSize: [number, number, number];
  /** Bricks with max intensity below this value are considered empty */
  readonly emptyBrickThreshold: number;

  constructor(
    dimensions: [number, number, number],
    voxelSpacing: [number, number, number] = [1, 1, 1],
    emptyBrickThreshold = 100,
  ) {
    this.dimensions = [...dimensions] as [number, number, number];
    this.voxelSpacing = [...voxelSpacing] as [number, number, number];
    this.emptyBrickThreshold = emptyBrickThreshold;
    this.datasetGrid = computeDatasetGrid(dimensions);
    this.normalizedSize = computeNormalizedSize(dimensions, voxelSpacing);
  }
}
