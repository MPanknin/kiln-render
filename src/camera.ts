/**
 * Simple arcball camera with mouse interaction
 */

// Camera orbits around origin (center of normalized volume)
const TARGET: [number, number, number] = [0, 0, 0];

export class Camera {
  position: Float32Array;

  private distance = 2.4;  // Distance from origin in normalized units
  private rotationX = 0.3;
  private rotationY = 0.4;
  private isDragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.position = new Float32Array(3);
    this.updatePosition();

    canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;

      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;

      this.rotationY -= dx * 0.01;
      this.rotationX += dy * 0.01;
      this.rotationX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.rotationX));
      this.updatePosition();
    });

    canvas.addEventListener('mouseup', () => { this.isDragging = false; });
    canvas.addEventListener('mouseleave', () => { this.isDragging = false; });

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
    // Orbit around origin (center of normalized volume)
    this.position[0] = TARGET[0] + Math.sin(this.rotationY) * cosX * this.distance;
    this.position[1] = TARGET[1] + Math.sin(this.rotationX) * this.distance;
    this.position[2] = TARGET[2] + Math.cos(this.rotationY) * cosX * this.distance;
  }

  getViewMatrix(): Float32Array {
    return lookAt(this.position, TARGET, [0, 1, 0]);
  }

  getProjectionMatrix(aspect: number): Float32Array {
    // Near/far planes for normalized space
    const near = 0.01;
    const far = 100;
    return perspective(Math.PI / 4, aspect, near, far);
  }
}

// Simple matrix utilities
function lookAt(eye: ArrayLike<number>, target: ArrayLike<number>, up: ArrayLike<number>): Float32Array {
  const zAxis = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);

  return new Float32Array([
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -dot(xAxis, eye), -dot(yAxis, eye), -dot(zAxis, eye), 1,
  ]);
}

function perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function normalize(v: number[]): number[] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: ArrayLike<number>, b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: number[], b: ArrayLike<number>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
