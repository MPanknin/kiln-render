import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BRICK_SIZE,
  LOGICAL_BRICK_SIZE,
  PHYSICAL_BRICK_SIZE,
  ATLAS_SIZE,
  GRID_SIZE,
  TOTAL_BRICK_SLOTS,
  getDatasetSize,
  getVoxelSpacing,
  getDatasetGrid,
  getNormalizedSize,
  setDatasetSize,
  getEmptyBrickThreshold,
  setEmptyBrickThreshold,
} from '../src/core/config.js';

describe('Config Constants', () => {
  describe('brick sizes', () => {
    it('should have logical brick size of 64', () => {
      expect(LOGICAL_BRICK_SIZE).toBe(64);
      expect(BRICK_SIZE).toBe(64); // Legacy alias
    });

    it('should have physical brick size of 66 (64 + 2 padding)', () => {
      expect(PHYSICAL_BRICK_SIZE).toBe(66);
      expect(PHYSICAL_BRICK_SIZE).toBe(LOGICAL_BRICK_SIZE + 2);
    });
  });

  describe('atlas dimensions', () => {
    it('should have consistent atlas dimensions', () => {
      // ATLAS_SIZE = GRID_SIZE * PHYSICAL_BRICK_SIZE
      expect(ATLAS_SIZE).toBe(GRID_SIZE * PHYSICAL_BRICK_SIZE);
    });

    it('should have integer grid size', () => {
      expect(Number.isInteger(GRID_SIZE)).toBe(true);
      expect(GRID_SIZE).toBeGreaterThan(0);
    });

    it('should have correct total brick slots', () => {
      expect(TOTAL_BRICK_SLOTS).toBe(GRID_SIZE ** 3);
    });

    it('should have atlas size that is multiple of physical brick size', () => {
      expect(ATLAS_SIZE % PHYSICAL_BRICK_SIZE).toBe(0);
    });
  });
});

describe('Dynamic Dataset Configuration', () => {
  // Save original values to restore after tests
  let originalSize: [number, number, number];
  let originalSpacing: [number, number, number];

  beforeEach(() => {
    originalSize = getDatasetSize();
    originalSpacing = getVoxelSpacing();
  });

  afterEach(() => {
    // Restore original values
    setDatasetSize(originalSize, originalSpacing);
  });

  describe('setDatasetSize', () => {
    it('should update dataset size', () => {
      setDatasetSize([256, 256, 256]);
      const size = getDatasetSize();
      expect(size).toEqual([256, 256, 256]);
    });

    it('should update voxel spacing when provided', () => {
      setDatasetSize([512, 512, 512], [0.5, 0.5, 1.0]);
      const spacing = getVoxelSpacing();
      expect(spacing).toEqual([0.5, 0.5, 1.0]);
    });

    it('should return a copy of the array (not reference)', () => {
      setDatasetSize([100, 200, 300]);
      const size1 = getDatasetSize();
      const size2 = getDatasetSize();
      expect(size1).not.toBe(size2); // Different array instances
      expect(size1).toEqual(size2);  // Same values
    });
  });

  describe('getDatasetGrid', () => {
    it('should compute brick grid correctly for exact multiples', () => {
      setDatasetSize([128, 128, 128]); // 2 bricks per dimension
      const grid = getDatasetGrid();
      expect(grid).toEqual([2, 2, 2]);
    });

    it('should round up for non-exact multiples', () => {
      setDatasetSize([65, 65, 65]); // Just over 1 brick
      const grid = getDatasetGrid();
      expect(grid).toEqual([2, 2, 2]); // Rounds up to 2
    });

    it('should handle asymmetric dimensions', () => {
      setDatasetSize([128, 256, 512]); // 2, 4, 8 bricks
      const grid = getDatasetGrid();
      expect(grid).toEqual([2, 4, 8]);
    });

    it('should handle single brick', () => {
      setDatasetSize([64, 64, 64]);
      const grid = getDatasetGrid();
      expect(grid).toEqual([1, 1, 1]);
    });
  });

  describe('getNormalizedSize', () => {
    it('should normalize cubic volumes to 1x1x1', () => {
      setDatasetSize([512, 512, 512], [1, 1, 1]);
      const normalized = getNormalizedSize();
      expect(normalized[0]).toBeCloseTo(1.0);
      expect(normalized[1]).toBeCloseTo(1.0);
      expect(normalized[2]).toBeCloseTo(1.0);
    });

    it('should preserve aspect ratio for non-cubic volumes', () => {
      setDatasetSize([512, 256, 512], [1, 1, 1]);
      const normalized = getNormalizedSize();
      expect(normalized[0]).toBeCloseTo(1.0);  // Max dimension = 1
      expect(normalized[1]).toBeCloseTo(0.5);  // Half of max
      expect(normalized[2]).toBeCloseTo(1.0);  // Max dimension = 1
    });

    it('should account for voxel spacing', () => {
      // 256 voxels at 2.0 spacing = 512 physical
      // 512 voxels at 1.0 spacing = 512 physical
      setDatasetSize([256, 512, 256], [2, 1, 2]);
      const normalized = getNormalizedSize();
      // All dimensions have same physical size (512)
      expect(normalized[0]).toBeCloseTo(1.0);
      expect(normalized[1]).toBeCloseTo(1.0);
      expect(normalized[2]).toBeCloseTo(1.0);
    });

    it('should handle anisotropic voxels', () => {
      // Common CT scan: high in-plane resolution, lower z resolution
      setDatasetSize([512, 512, 256], [0.5, 0.5, 1.0]);
      // Physical: 256 x 256 x 256
      const normalized = getNormalizedSize();
      expect(normalized[0]).toBeCloseTo(1.0);
      expect(normalized[1]).toBeCloseTo(1.0);
      expect(normalized[2]).toBeCloseTo(1.0);
    });

    it('should normalize to largest physical dimension', () => {
      setDatasetSize([100, 200, 400], [1, 1, 1]);
      const normalized = getNormalizedSize();
      expect(normalized[0]).toBeCloseTo(0.25); // 100/400
      expect(normalized[1]).toBeCloseTo(0.5);  // 200/400
      expect(normalized[2]).toBeCloseTo(1.0);  // 400/400 (max)
    });
  });
});

describe('Empty Brick Threshold', () => {
  let originalThreshold: number;

  beforeEach(() => {
    originalThreshold = getEmptyBrickThreshold();
  });

  afterEach(() => {
    setEmptyBrickThreshold(originalThreshold);
  });

  it('should get and set threshold', () => {
    setEmptyBrickThreshold(50);
    expect(getEmptyBrickThreshold()).toBe(50);

    setEmptyBrickThreshold(200);
    expect(getEmptyBrickThreshold()).toBe(200);
  });

  it('should accept zero threshold', () => {
    setEmptyBrickThreshold(0);
    expect(getEmptyBrickThreshold()).toBe(0);
  });

  it('should accept max 8-bit threshold', () => {
    setEmptyBrickThreshold(255);
    expect(getEmptyBrickThreshold()).toBe(255);
  });
});
