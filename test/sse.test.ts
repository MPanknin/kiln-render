import { describe, it, expect } from 'vitest';

/**
 * Screen-Space Error (SSE) Tests
 *
 * SSE is used to determine when to split to finer LOD levels.
 * The formula is: projectedError = (voxelWorldSize / distance) * projectionFactor
 *
 * Where:
 * - voxelWorldSize = baseVoxelSize * (2^lod) - world-space size of one voxel at this LOD
 * - distance = distance from camera to brick center
 * - projectionFactor = screenHeight / (2 * tan(fov/2)) - converts world size to pixels
 *
 * Split when: projectedError > maxPixelError
 */

describe('Screen-Space Error (SSE) Calculations', () => {
  // Simulate the SSE calculation from StreamingManager
  const cameraFovRad = Math.PI / 4; // 45 degrees

  /**
   * Calculate projection factor for a given screen height
   */
  function calculateProjectionFactor(screenHeight: number): number {
    return screenHeight / (2 * Math.tan(cameraFovRad / 2));
  }

  /**
   * Calculate world-space voxel size at a given LOD
   */
  function getVoxelWorldSize(
    lod: number,
    normalizedSize: [number, number, number],
    originalDimensions: [number, number, number]
  ): number {
    const maxDim = Math.max(...originalDimensions);
    const baseVoxelSize = Math.max(...normalizedSize) / maxDim;
    return baseVoxelSize * (1 << lod);
  }

  /**
   * Calculate projected error in pixels
   */
  function calculateProjectedError(
    voxelWorldSize: number,
    distance: number,
    projectionFactor: number
  ): number {
    return (voxelWorldSize / Math.max(distance, 0.001)) * projectionFactor;
  }

  /**
   * Determine if LOD should split to finer level
   */
  function shouldSplit(
    lod: number,
    projectedError: number,
    maxPixelError: number
  ): boolean {
    return lod > 0 && projectedError > maxPixelError;
  }

  describe('projectionFactor', () => {
    it('should increase with screen height', () => {
      const factor720 = calculateProjectionFactor(720);
      const factor1080 = calculateProjectionFactor(1080);
      const factor2160 = calculateProjectionFactor(2160);

      expect(factor1080).toBeGreaterThan(factor720);
      expect(factor2160).toBeGreaterThan(factor1080);
    });

    it('should be proportional to screen height', () => {
      const factor720 = calculateProjectionFactor(720);
      const factor1440 = calculateProjectionFactor(1440);

      // Double the height = double the factor
      expect(factor1440 / factor720).toBeCloseTo(2.0);
    });

    it('should have reasonable values for common resolutions', () => {
      const factor1080 = calculateProjectionFactor(1080);
      // For 45 degree FOV: factor = 1080 / (2 * tan(22.5°)) ≈ 1080 / 0.828 ≈ 1304
      expect(factor1080).toBeGreaterThan(1000);
      expect(factor1080).toBeLessThan(2000);
    });
  });

  describe('voxelWorldSize', () => {
    const normalizedSize: [number, number, number] = [1.0, 1.0, 1.0];
    const dims: [number, number, number] = [512, 512, 512];

    it('should double for each LOD level', () => {
      const size0 = getVoxelWorldSize(0, normalizedSize, dims);
      const size1 = getVoxelWorldSize(1, normalizedSize, dims);
      const size2 = getVoxelWorldSize(2, normalizedSize, dims);
      const size3 = getVoxelWorldSize(3, normalizedSize, dims);

      expect(size1 / size0).toBeCloseTo(2.0);
      expect(size2 / size1).toBeCloseTo(2.0);
      expect(size3 / size2).toBeCloseTo(2.0);
    });

    it('should be 2^lod times base voxel size', () => {
      const size0 = getVoxelWorldSize(0, normalizedSize, dims);
      const size4 = getVoxelWorldSize(4, normalizedSize, dims);

      expect(size4 / size0).toBeCloseTo(16.0); // 2^4 = 16
    });

    it('should be smaller for higher resolution volumes', () => {
      const dims256: [number, number, number] = [256, 256, 256];
      const dims512: [number, number, number] = [512, 512, 512];
      const dims1024: [number, number, number] = [1024, 1024, 1024];

      const size256 = getVoxelWorldSize(0, normalizedSize, dims256);
      const size512 = getVoxelWorldSize(0, normalizedSize, dims512);
      const size1024 = getVoxelWorldSize(0, normalizedSize, dims1024);

      expect(size512).toBeLessThan(size256);
      expect(size1024).toBeLessThan(size512);
    });
  });

  describe('projectedError', () => {
    const projectionFactor = calculateProjectionFactor(1080);

    it('should decrease with distance', () => {
      const voxelSize = 0.01;

      const errorNear = calculateProjectedError(voxelSize, 1.0, projectionFactor);
      const errorMid = calculateProjectedError(voxelSize, 2.0, projectionFactor);
      const errorFar = calculateProjectedError(voxelSize, 4.0, projectionFactor);

      expect(errorMid).toBeLessThan(errorNear);
      expect(errorFar).toBeLessThan(errorMid);
    });

    it('should be inversely proportional to distance', () => {
      const voxelSize = 0.01;

      const error1 = calculateProjectedError(voxelSize, 1.0, projectionFactor);
      const error2 = calculateProjectedError(voxelSize, 2.0, projectionFactor);

      // Double distance = half error
      expect(error1 / error2).toBeCloseTo(2.0);
    });

    it('should increase with voxel size', () => {
      const distance = 2.0;

      const errorSmall = calculateProjectedError(0.01, distance, projectionFactor);
      const errorLarge = calculateProjectedError(0.02, distance, projectionFactor);

      expect(errorLarge).toBeGreaterThan(errorSmall);
      expect(errorLarge / errorSmall).toBeCloseTo(2.0);
    });

    it('should handle very small distances safely', () => {
      const voxelSize = 0.01;

      // Should not throw or return Infinity
      const errorZero = calculateProjectedError(voxelSize, 0, projectionFactor);
      const errorTiny = calculateProjectedError(voxelSize, 0.0001, projectionFactor);

      expect(Number.isFinite(errorZero)).toBe(true);
      expect(Number.isFinite(errorTiny)).toBe(true);
    });
  });

  describe('shouldSplit', () => {
    const maxPixelError = 8.0;

    it('should not split LOD 0 regardless of error', () => {
      // LOD 0 is the finest level - cannot split further
      expect(shouldSplit(0, 100, maxPixelError)).toBe(false);
      expect(shouldSplit(0, 1000, maxPixelError)).toBe(false);
    });

    it('should split when error exceeds threshold', () => {
      expect(shouldSplit(1, 10, maxPixelError)).toBe(true);  // 10 > 8
      expect(shouldSplit(2, 16, maxPixelError)).toBe(true);  // 16 > 8
    });

    it('should not split when error is below threshold', () => {
      expect(shouldSplit(1, 4, maxPixelError)).toBe(false);  // 4 < 8
      expect(shouldSplit(2, 7, maxPixelError)).toBe(false);  // 7 < 8
    });

    it('should not split at exactly threshold', () => {
      expect(shouldSplit(1, 8, maxPixelError)).toBe(false);  // 8 is not > 8
    });

    it('should split just above threshold', () => {
      expect(shouldSplit(1, 8.01, maxPixelError)).toBe(true);
    });
  });

  describe('LOD selection scenarios', () => {
    const screenHeight = 1080;
    const projectionFactor = calculateProjectionFactor(screenHeight);
    const normalizedSize: [number, number, number] = [1.0, 1.0, 1.0];
    const dims: [number, number, number] = [512, 512, 512];
    const maxPixelError = 8.0;

    function selectLOD(distance: number): number {
      // Start from coarsest LOD and work down
      for (let lod = 4; lod >= 0; lod--) {
        const voxelSize = getVoxelWorldSize(lod, normalizedSize, dims);
        const error = calculateProjectedError(voxelSize, distance, projectionFactor);

        if (!shouldSplit(lod, error, maxPixelError)) {
          return lod;
        }
      }
      return 0;
    }

    it('should select coarser LOD for distant objects', () => {
      const lodFar = selectLOD(10.0);
      const lodNear = selectLOD(1.0);

      expect(lodFar).toBeGreaterThanOrEqual(lodNear);
    });

    it('should select finer LOD for close objects', () => {
      const lodVeryClose = selectLOD(0.5);
      const lodClose = selectLOD(1.0);
      const lodMid = selectLOD(3.0);

      expect(lodVeryClose).toBeLessThanOrEqual(lodClose);
      expect(lodClose).toBeLessThanOrEqual(lodMid);
    });

    it('should return LOD 0 for very close distances', () => {
      const lod = selectLOD(0.1);
      expect(lod).toBe(0);
    });

    it('should return coarse LOD for very far distances', () => {
      const lod = selectLOD(100.0);
      expect(lod).toBeGreaterThan(0);
    });
  });

  describe('SSE with different maxPixelError thresholds', () => {
    const projectionFactor = calculateProjectionFactor(1080);
    const voxelSize = 0.01;
    const distance = 2.0;
    const projectedError = calculateProjectedError(voxelSize, distance, projectionFactor);

    it('should split more aggressively with lower threshold', () => {
      const lowThreshold = 2.0;
      const highThreshold = 16.0;

      // Same error, different thresholds
      const splitLow = shouldSplit(1, projectedError, lowThreshold);
      const splitHigh = shouldSplit(1, projectedError, highThreshold);

      // With low threshold, more likely to split (want higher quality)
      // With high threshold, less likely to split (accept lower quality)
      if (projectedError > lowThreshold && projectedError <= highThreshold) {
        expect(splitLow).toBe(true);
        expect(splitHigh).toBe(false);
      }
    });

    it('threshold of 2.0 means split when voxel > 2 pixels', () => {
      const threshold = 2.0;

      expect(shouldSplit(1, 1.9, threshold)).toBe(false); // Under 2 pixels
      expect(shouldSplit(1, 2.1, threshold)).toBe(true);  // Over 2 pixels
    });

    it('threshold of 8.0 means split when voxel > 8 pixels', () => {
      const threshold = 8.0;

      expect(shouldSplit(1, 7.9, threshold)).toBe(false); // Under 8 pixels
      expect(shouldSplit(1, 8.1, threshold)).toBe(true);  // Over 8 pixels
    });
  });
});

describe('SSE Edge Cases', () => {
  const projectionFactor = 1304; // ~1080p at 45° FOV

  it('should handle zero LOD', () => {
    const voxelSize = 0.001; // Very small at LOD 0
    const error = (voxelSize / 1.0) * projectionFactor;

    // LOD 0 should never split
    expect(error).toBeLessThan(8); // Should be sub-pixel anyway
  });

  it('should handle large volumes', () => {
    // 4096^3 volume
    const dims: [number, number, number] = [4096, 4096, 4096];
    const normalizedSize: [number, number, number] = [1, 1, 1];
    const baseVoxelSize = 1.0 / 4096;

    expect(baseVoxelSize).toBeLessThan(0.001);
  });

  it('should handle anisotropic volumes', () => {
    // Common CT: high in-plane res, lower z
    const dims: [number, number, number] = [512, 512, 256];
    const spacing: [number, number, number] = [0.5, 0.5, 1.0];

    // Physical size
    const physical = [
      dims[0] * spacing[0],
      dims[1] * spacing[1],
      dims[2] * spacing[2],
    ];

    // All dimensions same physical size
    expect(physical[0]).toBe(256);
    expect(physical[1]).toBe(256);
    expect(physical[2]).toBe(256);
  });
});
