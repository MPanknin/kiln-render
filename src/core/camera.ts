/**
 * Simple arcball camera with mouse interaction
 * Left mouse: orbit, Right mouse: pan, Wheel: zoom
 */

import { mat4 } from 'wgpu-matrix';

export type UpAxis = 'x' | 'y' | 'z' | '-x' | '-y' | '-z';

export class Camera {
  position: Float32Array;

  private target: [number, number, number] = [0, 0, 0];  // Pan target
  private distance = 5.0;  // Distance from target in normalized units
  private rotationX = 0.3;
  private rotationY = 0.4;
  private isDragging = false;
  private isPanning = false;
  private lastX = 0;
  private lastY = 0;

  // Up vector configuration
  private upAxis: UpAxis = 'y';
  private upVector: [number, number, number] = [0, 1, 0];

  constructor(canvas: HTMLCanvasElement) {
    this.position = new Float32Array(3);
    this.updatePosition();

    // Disable context menu on right-click
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('mousedown', (e) => {
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (e.button === 0) {
        this.isDragging = true;  // Left click: orbit
      } else if (e.button === 2) {
        this.isPanning = true;   // Right click: pan
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this.isDragging && !this.isPanning) return;

      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;

      if (this.isDragging) {
        // Orbit: rotate around target
        const baseAxis = this.upAxis.replace('-', '');
        const isNegative = this.upAxis.startsWith('-');
        let hSign = baseAxis === 'z' ? 1 : -1;
        if (baseAxis === 'y' && isNegative) hSign = 1;
        this.rotationY += hSign * dx * 0.01;
        this.rotationX += dy * 0.01;
        this.rotationX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.rotationX));
      } else if (this.isPanning) {
        // Pan: move target in screen space
        const panSpeed = this.distance * 0.002;
        const right = this.getRightVector();
        const up = this.getUpVectorLocal();
        // Note: dy is inverted (drag up = move target up = subtract)
        this.target[0] -= (dx * right[0] - dy * up[0]) * panSpeed;
        this.target[1] -= (dx * right[1] - dy * up[1]) * panSpeed;
        this.target[2] -= (dx * right[2] - dy * up[2]) * panSpeed;
      }

      this.updatePosition();
    });

    canvas.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.isPanning = false;
    });
    canvas.addEventListener('mouseleave', () => {
      this.isDragging = false;
      this.isPanning = false;
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance *= 1 + e.deltaY * 0.001;
      // Zoom limits for normalized space
      this.distance = Math.max(0.5, Math.min(10, this.distance));
      this.updatePosition();
    }, { passive: false });
  }

  private updatePosition() {
    const cosX = Math.cos(this.rotationX);
    const sinX = Math.sin(this.rotationX);
    const cosY = Math.cos(this.rotationY);
    const sinY = Math.sin(this.rotationY);

    // Determine sign for negative axes
    const sign = this.upAxis.startsWith('-') ? -1 : 1;
    const baseAxis = this.upAxis.replace('-', '') as 'x' | 'y' | 'z';

    // Orbit around target based on up axis
    // The "horizontal" rotation is around the up axis
    // The "vertical" rotation tilts toward/away from up
    switch (baseAxis) {
      case 'x':
        // X is up: orbit in YZ plane, tilt toward X
        this.position[0] = this.target[0] + sign * sinX * this.distance;
        this.position[1] = this.target[1] + cosY * cosX * this.distance;
        this.position[2] = this.target[2] + sinY * cosX * this.distance;
        break;
      case 'y':
        // Y is up (default): orbit in XZ plane, tilt toward Y
        this.position[0] = this.target[0] + sinY * cosX * this.distance;
        this.position[1] = this.target[1] + sign * sinX * this.distance;
        this.position[2] = this.target[2] + cosY * cosX * this.distance;
        break;
      case 'z':
        // Z is up: orbit in XY plane, tilt toward Z
        this.position[0] = this.target[0] + cosY * cosX * this.distance;
        this.position[1] = this.target[1] + sinY * cosX * this.distance;
        this.position[2] = this.target[2] + sign * sinX * this.distance;
        break;
    }
  }

  /** Get camera right vector (screen X direction in world space) */
  private getRightVector(): [number, number, number] {
    const cosY = Math.cos(this.rotationY);
    const sinY = Math.sin(this.rotationY);
    const sign = this.upAxis.startsWith('-') ? -1 : 1;
    const baseAxis = this.upAxis.replace('-', '') as 'x' | 'y' | 'z';

    switch (baseAxis) {
      case 'x':
        return [0, -sinY * sign, cosY * sign];
      case 'y':
        return [cosY * sign, 0, -sinY * sign];
      case 'z':
        return [-sinY * sign, cosY * sign, 0];
    }
  }

  /** Get camera up vector in view space (screen Y direction in world space) */
  private getUpVectorLocal(): [number, number, number] {
    const cosX = Math.cos(this.rotationX);
    const sinX = Math.sin(this.rotationX);
    const cosY = Math.cos(this.rotationY);
    const sinY = Math.sin(this.rotationY);
    const sign = this.upAxis.startsWith('-') ? -1 : 1;
    const baseAxis = this.upAxis.replace('-', '') as 'x' | 'y' | 'z';

    switch (baseAxis) {
      case 'x':
        return [sign * cosX, sinX * cosY, sinX * sinY];
      case 'y':
        return [sinX * sinY, sign * cosX, sinX * cosY];
      case 'z':
        return [sinX * cosY, sinX * sinY, sign * cosX];
    }
  }

  /**
   * Set the up axis for camera orientation
   * Supports positive and negative axes: 'x', 'y', 'z', '-x', '-y', '-z'
   */
  setUpAxis(axis: UpAxis): void {
    this.upAxis = axis;
    switch (axis) {
      case 'x':
        this.upVector = [1, 0, 0];
        break;
      case '-x':
        this.upVector = [-1, 0, 0];
        break;
      case 'y':
        this.upVector = [0, 1, 0];
        break;
      case '-y':
        this.upVector = [0, -1, 0];
        break;
      case 'z':
        this.upVector = [0, 0, 1];
        break;
      case '-z':
        this.upVector = [0, 0, -1];
        break;
    }
    // Reset rotation and pan to sensible defaults for the new up axis
    this.rotationX = 0.3;
    this.rotationY = 0.4;
    this.target = [0, 0, 0];
    this.updatePosition();
  }

  /** Reset pan to center on origin */
  resetPan(): void {
    this.target = [0, 0, 0];
    this.updatePosition();
  }

  getUpAxis(): UpAxis {
    return this.upAxis;
  }

  getViewMatrix(): Float32Array {
    return mat4.lookAt(this.position, this.target, this.upVector) as Float32Array;
  }

  getProjectionMatrix(aspect: number): Float32Array {
    // Near/far planes for normalized space
    const near = 0.01;
    const far = 100;
    return mat4.perspective(Math.PI / 4, aspect, near, far) as Float32Array;
  }
}

/**
 * Frustum planes for culling.
 * Each plane is [a, b, c, d] where ax + by + cz + d = 0
 * Normal points inward (positive side is inside frustum)
 */
export type FrustumPlanes = {
  left: [number, number, number, number];
  right: [number, number, number, number];
  bottom: [number, number, number, number];
  top: [number, number, number, number];
  near: [number, number, number, number];
  far: [number, number, number, number];
};

/**
 * Extract frustum planes from a view-projection matrix.
 * Uses Gribb/Hartmann method.
 */
export function extractFrustumPlanes(viewProj: Float32Array): FrustumPlanes {
  const normalizePlane = (p: [number, number, number, number]): [number, number, number, number] => {
    const len = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    return [p[0] / len, p[1] / len, p[2] / len, p[3] / len];
  };

  // Left: row3 + row0
  const left: [number, number, number, number] = [
    viewProj[3]! + viewProj[0]!,
    viewProj[7]! + viewProj[4]!,
    viewProj[11]! + viewProj[8]!,
    viewProj[15]! + viewProj[12]!,
  ];

  // Right: row3 - row0
  const right: [number, number, number, number] = [
    viewProj[3]! - viewProj[0]!,
    viewProj[7]! - viewProj[4]!,
    viewProj[11]! - viewProj[8]!,
    viewProj[15]! - viewProj[12]!,
  ];

  // Bottom: row3 + row1
  const bottom: [number, number, number, number] = [
    viewProj[3]! + viewProj[1]!,
    viewProj[7]! + viewProj[5]!,
    viewProj[11]! + viewProj[9]!,
    viewProj[15]! + viewProj[13]!,
  ];

  // Top: row3 - row1
  const top: [number, number, number, number] = [
    viewProj[3]! - viewProj[1]!,
    viewProj[7]! - viewProj[5]!,
    viewProj[11]! - viewProj[9]!,
    viewProj[15]! - viewProj[13]!,
  ];

  // Near: row3 + row2
  const near: [number, number, number, number] = [
    viewProj[3]! + viewProj[2]!,
    viewProj[7]! + viewProj[6]!,
    viewProj[11]! + viewProj[10]!,
    viewProj[15]! + viewProj[14]!,
  ];

  // Far: row3 - row2
  const far: [number, number, number, number] = [
    viewProj[3]! - viewProj[2]!,
    viewProj[7]! - viewProj[6]!,
    viewProj[11]! - viewProj[10]!,
    viewProj[15]! - viewProj[14]!,
  ];

  return {
    left: normalizePlane(left),
    right: normalizePlane(right),
    bottom: normalizePlane(bottom),
    top: normalizePlane(top),
    near: normalizePlane(near),
    far: normalizePlane(far),
  };
}

/**
 * Test if an AABB intersects or is inside the frustum.
 * Returns true if any part of the box is visible.
 */
export function isAABBInFrustum(
  min: [number, number, number],
  max: [number, number, number],
  frustum: FrustumPlanes
): boolean {
  const planes = [frustum.left, frustum.right, frustum.bottom, frustum.top, frustum.near, frustum.far];

  for (const plane of planes) {
    // Find the positive vertex (furthest along plane normal)
    const px = plane[0] >= 0 ? max[0] : min[0];
    const py = plane[1] >= 0 ? max[1] : min[1];
    const pz = plane[2] >= 0 ? max[2] : min[2];

    // If positive vertex is outside, box is completely outside
    if (plane[0] * px + plane[1] * py + plane[2] * pz + plane[3] < 0) {
      return false;
    }
  }

  return true;
}

/**
 * Multiply two 4x4 matrices (column-major)
 */
export function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
  return mat4.multiply(a, b) as Float32Array;
}
