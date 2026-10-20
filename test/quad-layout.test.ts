/**
 * Quad layout: fixed axis panes (pan, no orbit), the axis each pane looks along, and
 * KilnViewer driving every pane from one render loop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Camera } from '../src/core/camera.js';
import { KilnViewer } from '../src/viewer.js';
import { axisViews, parsePaneModes } from '../examples/shared/quad-layout.js';

type Listener = (e: Partial<MouseEvent>) => void;
function canvasStub() {
  const listeners: Record<string, Listener> = {};
  const canvas = { addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; } } as unknown as HTMLCanvasElement;
  const drag = (dx: number, dy: number) => {
    listeners.mousedown!({ button: 0, clientX: 0, clientY: 0 });
    listeners.mousemove!({ clientX: dx, clientY: dy });
    listeners.mouseup!({});
  };
  return { canvas, drag };
}

describe('axis panes', () => {
  it('pan instead of orbiting when orbit is off', () => {
    const { canvas, drag } = canvasStub();
    const cam = new Camera(canvas);
    cam.lookFrom([0, 0, 1]);
    const [rx, ry, dist] = cam.getOrbitState();
    cam.orbitEnabled = false;
    drag(40, 0);
    const [rx2, ry2, dist2, tx, ty, tz] = cam.getOrbitState();
    expect([rx2, ry2, dist2]).toEqual([rx, ry, dist]);
    expect(Math.hypot(tx, ty, tz)).toBeGreaterThan(0);
  });

  it('look down the up axis from the top and along the other two from front and side', () => {
    expect(axisViews('y').map(v => [v.name, v.dir])).toEqual([
      ['Front · +Z', [0, 0, 1]], ['Side · +X', [1, 0, 0]], ['Top · +Y', [0, 1, 0]],
    ]);
    expect(axisViews('-z').map(v => v.dir)).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, -1]]);
  });

  it('read pane modes from the URL, skipping unknown ones', () => {
    expect(parsePaneModes('mip,foo,slice')).toEqual(['mip', undefined, 'slice']);
    expect(parsePaneModes(null)).toEqual([undefined]);
  });
});

describe('KilnViewer panes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('updates every pane in one call and renders only those that need it', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    const viewer: any = Object.create(KilnViewer.prototype);
    const camera = (id: number) => ({ getViewParams: () => ({ id }) });
    const target = (name: string) => ({ getCurrentTexture: () => ({ createView: () => name }) });
    Object.assign(viewer, {
      disposed: false,
      canvas: { width: 8, height: 8 }, context: target('main'), camera: camera(0),
      panes: [1, 2].map(i => ({ canvas: { width: 8, height: 8 }, context: target(`pane${i}`), camera: camera(i) })),
      engine: { noteAnimationFrame: vi.fn(), updateViews: vi.fn(() => [false, true, false]), render: vi.fn() },
      onBeforeFrame: vi.fn(),
    });
    viewer.frame();
    expect(viewer.engine.updateViews).toHaveBeenCalledWith([{ id: 0 }, { id: 1 }, { id: 2 }]);
    expect(viewer.engine.render.mock.calls).toEqual([['pane1', { id: 1 }, 1]]);
    expect(viewer.onBeforeFrame).toHaveBeenCalledOnce();
  });
});
