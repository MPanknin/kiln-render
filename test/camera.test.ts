import { describe, it, expect } from 'vitest';
import { mat4 } from 'wgpu-matrix';
import {
  extractFrustumPlanes,
  isAABBInFrustum,
  type FrustumPlanes,
} from '../src/core/camera.js';

const multiplyMatrices = (a: Float32Array, b: Float32Array) => mat4.multiply(a, b) as Float32Array;

describe('Matrix Operations', () => {
  describe('multiplyMatrices', () => {
    it('should return identity when multiplying by identity', () => {
      const identity = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
      const result = multiplyMatrices(identity, identity);

      for (let i = 0; i < 16; i++) {
        expect(result[i]).toBeCloseTo(identity[i]!);
      }
    });

    it('should handle translation matrix correctly', () => {
      const identity = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
      // Translation by (1, 2, 3) in column-major
      const translation = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        1, 2, 3, 1,
      ]);

      const result = multiplyMatrices(identity, translation);
      expect(result[12]).toBeCloseTo(1); // tx
      expect(result[13]).toBeCloseTo(2); // ty
      expect(result[14]).toBeCloseTo(3); // tz
    });

    it('should combine two translations', () => {
      // Translation by (1, 0, 0)
      const t1 = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        1, 0, 0, 1,
      ]);
      // Translation by (0, 2, 0)
      const t2 = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 2, 0, 1,
      ]);

      const result = multiplyMatrices(t1, t2);
      expect(result[12]).toBeCloseTo(1); // Combined tx
      expect(result[13]).toBeCloseTo(2); // Combined ty
      expect(result[14]).toBeCloseTo(0); // Combined tz
    });
  });
});

describe('Frustum Culling', () => {
  // Create a simple orthographic-like view-projection for testing
  // This creates a frustum that includes the unit cube centered at origin
  function createTestViewProj(): Float32Array {
    // Simple perspective-ish matrix looking at origin from positive Z
    // Near plane at z=0.1, far at z=10
    const near = 0.1;
    const far = 10;
    const fov = Math.PI / 4;
    const aspect = 1;

    const f = 1 / Math.tan(fov / 2);
    const rangeInv = 1 / (near - far);

    // Perspective matrix (column-major)
    const proj = new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (near + far) * rangeInv, -1,
      0, 0, near * far * rangeInv * 2, 0,
    ]);

    // View matrix: camera at (0, 0, 3) looking at origin
    const view = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, -3, 1,
    ]);

    return multiplyMatrices(proj, view);
  }

  describe('extractFrustumPlanes', () => {
    it('should extract 6 planes', () => {
      const viewProj = createTestViewProj();
      const frustum = extractFrustumPlanes(viewProj);

      expect(frustum.left).toBeDefined();
      expect(frustum.right).toBeDefined();
      expect(frustum.bottom).toBeDefined();
      expect(frustum.top).toBeDefined();
      expect(frustum.near).toBeDefined();
      expect(frustum.far).toBeDefined();
    });

    it('should produce normalized plane normals', () => {
      const viewProj = createTestViewProj();
      const frustum = extractFrustumPlanes(viewProj);

      const checkNormalized = (plane: [number, number, number, number]) => {
        const len = Math.sqrt(plane[0] ** 2 + plane[1] ** 2 + plane[2] ** 2);
        expect(len).toBeCloseTo(1.0, 4);
      };

      checkNormalized(frustum.left);
      checkNormalized(frustum.right);
      checkNormalized(frustum.bottom);
      checkNormalized(frustum.top);
      checkNormalized(frustum.near);
      checkNormalized(frustum.far);
    });
  });

  describe('isAABBInFrustum', () => {
    it('should return true for box at origin (inside frustum)', () => {
      const viewProj = createTestViewProj();
      const frustum = extractFrustumPlanes(viewProj);

      // Small box centered at origin
      const min: [number, number, number] = [-0.5, -0.5, -0.5];
      const max: [number, number, number] = [0.5, 0.5, 0.5];

      expect(isAABBInFrustum(min, max, frustum)).toBe(true);
    });

    it('should return false for box far behind camera', () => {
      const viewProj = createTestViewProj();
      const frustum = extractFrustumPlanes(viewProj);

      // Box behind camera (camera is at z=3, looking at origin)
      const min: [number, number, number] = [-1, -1, 10];
      const max: [number, number, number] = [1, 1, 15];

      expect(isAABBInFrustum(min, max, frustum)).toBe(false);
    });

    it('should return false for box far to the left', () => {
      const viewProj = createTestViewProj();
      const frustum = extractFrustumPlanes(viewProj);

      // Box way off to the left
      const min: [number, number, number] = [-100, -1, -1];
      const max: [number, number, number] = [-50, 1, 1];

      expect(isAABBInFrustum(min, max, frustum)).toBe(false);
    });

    it('should return true for large box that contains frustum', () => {
      const viewProj = createTestViewProj();
      const frustum = extractFrustumPlanes(viewProj);

      // Large box that encompasses everything
      const min: [number, number, number] = [-50, -50, -50];
      const max: [number, number, number] = [50, 50, 50];

      expect(isAABBInFrustum(min, max, frustum)).toBe(true);
    });

    it('should return true for box partially intersecting frustum', () => {
      const viewProj = createTestViewProj();
      const frustum = extractFrustumPlanes(viewProj);

      // Box that partially overlaps the viewing area
      const min: [number, number, number] = [-0.5, -0.5, -0.5];
      const max: [number, number, number] = [10, 10, 10];

      expect(isAABBInFrustum(min, max, frustum)).toBe(true);
    });
  });
});

describe('Frustum Plane Mathematics', () => {
  it('should correctly classify point on positive side of plane', () => {
    // Plane: x = 0 (normal pointing +x, d = 0)
    const plane: [number, number, number, number] = [1, 0, 0, 0];
    const point = [1, 0, 0]; // On positive side

    const distance = plane[0] * point[0] + plane[1] * point[1] + plane[2] * point[2] + plane[3];
    expect(distance).toBeGreaterThan(0);
  });

  it('should correctly classify point on negative side of plane', () => {
    // Plane: x = 0 (normal pointing +x, d = 0)
    const plane: [number, number, number, number] = [1, 0, 0, 0];
    const point = [-1, 0, 0]; // On negative side

    const distance = plane[0] * point[0] + plane[1] * point[1] + plane[2] * point[2] + plane[3];
    expect(distance).toBeLessThan(0);
  });

  it('should correctly classify point on plane', () => {
    // Plane: x = 1 (normal pointing +x, d = -1)
    const plane: [number, number, number, number] = [1, 0, 0, -1];
    const point = [1, 5, 5]; // On the plane

    const distance = plane[0] * point[0] + plane[1] * point[1] + plane[2] * point[2] + plane[3];
    expect(distance).toBeCloseTo(0);
  });
});
