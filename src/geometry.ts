/**
 * Box geometry for proxy rendering
 */

export interface BoxGeometry {
  vertices: Float32Array;
  indices: Uint16Array;
  wireframeIndices: Uint16Array;
}

export function createBox(size: number = 512): BoxGeometry {
  // Cube vertices in [0, size] range (matching volume canvas)
  const s = size;
  const vertices = new Float32Array([
    0, 0, 0,  // 0
    s, 0, 0,  // 1
    s, s, 0,  // 2
    0, s, 0,  // 3
    0, 0, s,  // 4
    s, 0, s,  // 5
    s, s, s,  // 6
    0, s, s,  // 7
  ]);

  // Triangle indices (6 faces, 2 triangles each)
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, // front
    5, 4, 7, 5, 7, 6, // back
    3, 2, 6, 3, 6, 7, // top
    4, 5, 1, 4, 1, 0, // bottom
    1, 5, 6, 1, 6, 2, // right
    4, 0, 3, 4, 3, 7, // left
  ]);

  // Line indices for wireframe (12 edges)
  const wireframeIndices = new Uint16Array([
    0, 1, 1, 2, 2, 3, 3, 0, // front
    4, 5, 5, 6, 6, 7, 7, 4, // back
    0, 4, 1, 5, 2, 6, 3, 7, // connecting
  ]);

  return { vertices, indices, wireframeIndices };
}

export interface AxisGeometry {
  vertices: Float32Array; // position (xyz) + color (rgb)
}

export function createAxis(size: number): AxisGeometry {
  // 6 vertices: 2 per axis (origin + endpoint)
  // Format: x, y, z, r, g, b
  const vertices = new Float32Array([
    // X axis (red)
    0, 0, 0, 1, 0, 0,
    size, 0, 0, 1, 0, 0,
    // Y axis (green)
    0, 0, 0, 0, 1, 0,
    0, size, 0, 0, 1, 0,
    // Z axis (blue)
    0, 0, 0, 0, 0, 1,
    0, 0, size, 0, 0, 1,
  ]);

  return { vertices };
}
