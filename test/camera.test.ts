/**
 * Camera frustum culling — extractFrustumPlanes / isAABBInFrustum.
 *
 * Only Kiln's own culling code is tested here. Earlier revisions also asserted
 * mat4.multiply behaviour (that's wgpu-matrix's job) and reimplemented the
 * plane-distance dot product inline (testing arithmetic, not our code); both
 * were removed as test theater.
 */
import { describe, it, expect } from 'vitest';
import { mat4 } from 'wgpu-matrix';
import {
  extractFrustumPlanes,
  isAABBInFrustum,
} from '../src/core/camera.js';

const multiplyMatrices = (a: Float32Array, b: Float32Array) => mat4.multiply(a, b) as Float32Array;

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
