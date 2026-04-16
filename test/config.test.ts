import { describe, it, expect } from 'vitest';
import {
  BRICK_SIZE,
  LOGICAL_BRICK_SIZE,
  PHYSICAL_BRICK_SIZE,
  ATLAS_SIZE,
  GRID_SIZE,
  TOTAL_BRICK_SLOTS,
  DatasetConfig,
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

describe('DatasetConfig', () => {
  describe('datasetGrid', () => {
    it('should compute brick grid correctly for exact multiples', () => {
      const cfg = new DatasetConfig([128, 128, 128]);
      expect(cfg.datasetGrid).toEqual([2, 2, 2]);
    });

    it('should round up for non-exact multiples', () => {
      const cfg = new DatasetConfig([65, 65, 65]); // Just over 1 brick
      expect(cfg.datasetGrid).toEqual([2, 2, 2]); // Rounds up to 2
    });

    it('should handle asymmetric dimensions', () => {
      const cfg = new DatasetConfig([128, 256, 512]); // 2, 4, 8 bricks
      expect(cfg.datasetGrid).toEqual([2, 4, 8]);
    });

    it('should handle single brick', () => {
      const cfg = new DatasetConfig([64, 64, 64]);
      expect(cfg.datasetGrid).toEqual([1, 1, 1]);
    });
  });

  describe('normalizedSize', () => {
    it('should normalize cubic volumes to 1x1x1', () => {
      const cfg = new DatasetConfig([512, 512, 512], [1, 1, 1]);
      expect(cfg.normalizedSize[0]).toBeCloseTo(1.0);
      expect(cfg.normalizedSize[1]).toBeCloseTo(1.0);
      expect(cfg.normalizedSize[2]).toBeCloseTo(1.0);
    });

    it('should preserve aspect ratio for non-cubic volumes', () => {
      const cfg = new DatasetConfig([512, 256, 512], [1, 1, 1]);
      expect(cfg.normalizedSize[0]).toBeCloseTo(1.0);  // Max dimension = 1
      expect(cfg.normalizedSize[1]).toBeCloseTo(0.5);  // Half of max
      expect(cfg.normalizedSize[2]).toBeCloseTo(1.0);  // Max dimension = 1
    });

    it('should account for voxel spacing', () => {
      // 256 voxels at 2.0 spacing = 512 physical
      // 512 voxels at 1.0 spacing = 512 physical
      const cfg = new DatasetConfig([256, 512, 256], [2, 1, 2]);
      // All dimensions have same physical size (512)
      expect(cfg.normalizedSize[0]).toBeCloseTo(1.0);
      expect(cfg.normalizedSize[1]).toBeCloseTo(1.0);
      expect(cfg.normalizedSize[2]).toBeCloseTo(1.0);
    });

    it('should handle anisotropic voxels', () => {
      // Common CT scan: high in-plane resolution, lower z resolution
      // Physical: 256 x 256 x 256
      const cfg = new DatasetConfig([512, 512, 256], [0.5, 0.5, 1.0]);
      expect(cfg.normalizedSize[0]).toBeCloseTo(1.0);
      expect(cfg.normalizedSize[1]).toBeCloseTo(1.0);
      expect(cfg.normalizedSize[2]).toBeCloseTo(1.0);
    });

    it('should normalize to largest physical dimension', () => {
      const cfg = new DatasetConfig([100, 200, 400], [1, 1, 1]);
      expect(cfg.normalizedSize[0]).toBeCloseTo(0.25); // 100/400
      expect(cfg.normalizedSize[1]).toBeCloseTo(0.5);  // 200/400
      expect(cfg.normalizedSize[2]).toBeCloseTo(1.0);  // 400/400 (max)
    });
  });

  describe('emptyBrickThreshold', () => {
    it('should default to 100', () => {
      const cfg = new DatasetConfig([256, 256, 256]);
      expect(cfg.emptyBrickThreshold).toBe(100);
    });

    it('should accept a custom threshold', () => {
      const cfg = new DatasetConfig([256, 256, 256], [1, 1, 1], 50);
      expect(cfg.emptyBrickThreshold).toBe(50);
    });

    it('should accept zero threshold', () => {
      const cfg = new DatasetConfig([256, 256, 256], [1, 1, 1], 0);
      expect(cfg.emptyBrickThreshold).toBe(0);
    });

    it('should accept max 8-bit threshold', () => {
      const cfg = new DatasetConfig([256, 256, 256], [1, 1, 1], 255);
      expect(cfg.emptyBrickThreshold).toBe(255);
    });
  });

  describe('immutability', () => {
    it('should not be affected by mutating the source arrays', () => {
      const dims: [number, number, number] = [512, 256, 128];
      const spacing: [number, number, number] = [1, 2, 3];
      const cfg = new DatasetConfig(dims, spacing);

      dims[0] = 999;
      spacing[0] = 999;

      expect(cfg.dimensions[0]).toBe(512);
      expect(cfg.voxelSpacing[0]).toBe(1);
    });
  });
});
