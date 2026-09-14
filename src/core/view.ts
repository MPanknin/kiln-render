/**
 * Per-frame camera description consumed by the renderer and streaming manager.
 *
 * Matrices are column-major 4×4 and expressed in volume space: the volume is a
 * box centred at the origin with extents `DatasetConfig.normalizedSize`. Any
 * host camera (Kiln's own arcball Camera or an external one) can produce one of these.
 */
export interface ViewParams {
  /** Camera position in volume space. */
  position: ArrayLike<number>;
  /** View matrix (world → camera). */
  view: Float32Array | number[];
  /** Projection matrix. Either GL-style (-1..1) or WebGPU-style (0..1) depth works. */
  proj: Float32Array | number[];
  /** Vertical field of view in radians; drives screen-space-error LOD selection. */
  fovY: number;
  /** Viewport size in device pixels. */
  width: number;
  height: number;
  /**
   * True while the user is manipulating the camera. Optional: when omitted the
   * engine infers it from view-projection changes.
   */
  interacting?: boolean;
}
