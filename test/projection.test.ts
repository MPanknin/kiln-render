/**
 * Orthographic projection: the camera keeps the perspective framing at the target, its near
 * plane sits behind the eye, the engine recognises orthographic matrices, and the viewer
 * switches every view at once.
 */
import { describe, expect, it } from 'vitest';
import { mat4, vec4 } from 'wgpu-matrix';
import { Camera } from '../src/core/camera.js';
import { isOrthographic } from '../src/core/view.js';
import { KilnViewer } from '../src/viewer.js';

const canvasStub = { addEventListener() {} } as unknown as HTMLCanvasElement;

/** Normalised device coordinates of world point `p` in the camera's current projection. */
function ndc(cam: Camera, p: number[]): number[] {
  const { view, proj } = cam.getViewParams(800, 600);
  const clip = vec4.transformMat4([p[0]!, p[1]!, p[2]!, 1], mat4.multiply(proj, view));
  return [clip[0]! / clip[3]!, clip[1]! / clip[3]!, clip[2]! / clip[3]!];
}

describe('Camera projection', () => {
  it('starts in perspective', () => {
    const cam = new Camera(canvasStub);
    expect(cam.projection).toBe('perspective');
    expect(isOrthographic(cam.getViewParams(800, 600).proj)).toBe(false);
  });

  it('keeps the framing at the target when switching', () => {
    const cam = new Camera(canvasStub);
    cam.setOrbitState([0.3, 0.5, 2.5, 0.1, 0, -0.2]);
    const [, , dist, tx, ty, tz] = cam.getOrbitState();
    const v = cam.getViewMatrix();
    const h = dist * Math.tan(cam.fovY / 2);
    // On the target plane, at the top edge of the perspective view
    const top = [tx + v[1]! * h, ty + v[5]! * h, tz + v[9]! * h];
    expect(ndc(cam, top)[1]).toBeCloseTo(1, 5);
    cam.projection = 'orthographic';
    expect(isOrthographic(cam.getViewParams(800, 600).proj)).toBe(true);
    expect(ndc(cam, top)[1]).toBeCloseTo(1, 5);
  });

  it('zooms by changing the orthographic view height', () => {
    const cam = new Camera(canvasStub);
    cam.projection = 'orthographic';
    cam.setOrbitState([0, 0, 2, 0, 0, 0]);
    const wide = cam.getProjectionMatrix(1)[5]!;
    cam.setOrbitState([0, 0, 1, 0, 0, 0]);
    expect(cam.getProjectionMatrix(1)[5]).toBeCloseTo(wide * 2, 5);
  });

  it('keeps volume behind the eye in view, so zooming in never clips it', () => {
    const cam = new Camera(canvasStub);
    cam.projection = 'orthographic';
    cam.setOrbitState([0, 0, 0.1, 0, 0, 0]); // closest zoom, eye inside the volume
    const [x, y, z] = cam.position;
    const behind = [x! * 6, y! * 6, z! * 6]; // half a unit behind the eye
    const depth = ndc(cam, behind)[2]!;
    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThan(1);
  });

  it('counts a switch as a camera change', () => {
    const cam = new Camera(canvasStub);
    const version = cam.version;
    cam.projection = 'perspective';
    expect(cam.version).toBe(version);
    cam.projection = 'orthographic';
    expect(cam.version).toBe(version + 1);
  });
});

describe('KilnViewer.projection', () => {
  it('switches the main view and every pane', () => {
    const viewer: any = Object.create(KilnViewer.prototype);
    Object.assign(viewer, { camera: new Camera(canvasStub), panes: [{ camera: new Camera(canvasStub) }] });
    viewer.projection = 'orthographic';
    expect(viewer.camera.projection).toBe('orthographic');
    expect(viewer.panes[0].camera.projection).toBe('orthographic');
    expect(viewer.projection).toBe('orthographic');
  });
});
