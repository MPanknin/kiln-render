/**
 * Quad layout: fixed axis panes (pan, no orbit), the axis each pane looks along, and
 * KilnViewer driving every pane from one render loop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Camera } from '../src/core/camera.js';
import { KilnViewer } from '../src/viewer.js';
import { axisViews, mountQuadLayout, parsePaneModes } from '../examples/shared/quad-layout.js';

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

  function setupPanes() {
    const renderers = [{ volumeRenderMode: 'dvr', resetAccumulation: vi.fn() }];
    const viewer: any = Object.create(KilnViewer.prototype);
    Object.assign(viewer, {
      disposed: false, panes: [], canvas: canvasStub().canvas,
      camera: new Camera(canvasStub().canvas), format: 'bgra8unorm',
      resizeObserver: { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() },
      context: { unconfigure: vi.fn() },
      engine: {
        device: { limits: { maxTextureDimension2D: 8192 } },
        addView: () => renderers.push({ volumeRenderMode: 'dvr', resetAccumulation: vi.fn() }) - 1,
        removeView: (i: number) => renderers.splice(i, 1),
        getRenderer: (i: number) => renderers[i], setSize: vi.fn(), dispose: vi.fn(),
      },
    });
    const newCanvas = () => Object.assign(canvasStub().canvas, {
      clientWidth: 100, clientHeight: 100,
      getContext: () => ({ configure: vi.fn(), unconfigure: vi.fn() }),
    });
    return { viewer: viewer as KilnViewer, renderers, newCanvas };
  }

  it('invalidates removed handles without affecting the main view or surviving panes', () => {
    const { viewer, renderers, newCanvas } = setupPanes();
    const first = viewer.addPane(newCanvas());
    const second = viewer.addPane(newCanvas());
    viewer.removePane(first);
    expect(() => first.mode).toThrow('no longer attached');
    expect(() => { first.mode = 'iso'; }).toThrow('no longer attached');
    second.mode = 'mip';
    expect(renderers.map(r => r.volumeRenderMode)).toEqual(['dvr', 'mip']);
    expect(renderers[1]!.resetAccumulation).toHaveBeenCalledOnce();

    const replacement = viewer.addPane(first.canvas);
    viewer.removePane(first); // A stale handle must not remove a new pane using the same canvas.
    replacement.mode = 'slice';
    expect(renderers.map(r => r.volumeRenderMode)).toEqual(['dvr', 'mip', 'slice']);
  });

  it('rejects duplicate canvases and handles used after disposal', () => {
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { viewer, renderers, newCanvas } = setupPanes();
    const pane = viewer.addPane(newCanvas());
    expect(() => viewer.addPane(pane.canvas)).toThrow('already belongs');
    expect(() => viewer.addPane((viewer as any).canvas)).toThrow('already belongs');
    expect(renderers).toHaveLength(2);
    viewer.dispose();
    expect(() => pane.mode).toThrow('no longer attached');
    expect(() => { pane.mode = 'iso'; }).toThrow('no longer attached');
    expect(() => viewer.addPane(newCanvas())).toThrow('disposed');
    expect(renderers[0]!.volumeRenderMode).toBe('dvr');
  });

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

/** Just enough DOM for the layout: a tree of elements, body classes and <option>s. */
class El {
  children: El[] = [];
  parentNode: El | null = null;
  className = '';
  textContent = '';
  value = '';
  listeners: Record<string, () => void> = {};
  append(...els: El[]) { for (const el of els) { el.parentNode?.removeChild(el); el.parentNode = this; this.children.push(el); } }
  removeChild(el: El) { this.children = this.children.filter(c => c !== el); el.parentNode = null; }
  replaceWith(el: El) {
    const parent = this.parentNode!;
    el.parentNode?.removeChild(el);
    parent.children[parent.children.indexOf(this)] = el;
    el.parentNode = parent;
    this.parentNode = null;
  }
  insertBefore(el: El, ref: El) { el.parentNode?.removeChild(el); this.children.splice(this.children.indexOf(ref), 0, el); el.parentNode = this; }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren() { for (const c of [...this.children]) this.removeChild(c); }
  attributes: Record<string, string> = {};
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
  add() {}
  blur() {}
}

describe('quad layout switching', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(active = false) {
    const classes = new Set<string>();
    const classList = { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), has: (c: string) => classes.has(c) };
    const body = Object.assign(new El(), { classList });
    vi.stubGlobal('document', { createElement: () => new El(), body });
    vi.stubGlobal('Option', class {});
    const canvas = new El();
    body.append(canvas);
    const panes: any[] = [];
    const viewer: any = {
      camera: new Camera(canvasStub().canvas),
      addPane: vi.fn(() => {
        const camera = new Camera(canvasStub().canvas);
        camera.setUpAxis(viewer.camera.getUpAxis());
        const pane = { mode: 'dvr', camera };
        panes.push(pane);
        return pane;
      }),
      removePane: vi.fn(),
      resize: vi.fn(),
    };
    viewer.camera.setUpAxis('y');
    const layout = mountQuadLayout(viewer, canvas as unknown as HTMLCanvasElement, { active });
    return { body, canvas, viewer, panes, layout };
  }

  it('starts in the single view unless asked, with slice panes once shown', () => {
    const { body, canvas, viewer, panes, layout } = setup();
    expect(layout.active).toBe(false);
    expect(viewer.addPane).not.toHaveBeenCalled();
    layout.onChange = vi.fn();
    layout.toggle();
    expect(layout.active).toBe(true);
    expect(panes.map(p => p.mode)).toEqual(['slice', 'slice', 'slice']);
    expect(panes.every(p => p.camera.orbitEnabled === false)).toBe(true);
    expect(canvas.parentNode?.parentNode?.className).toBe('quad-layout');
    expect(body.classList.has('quad-active')).toBe(true);
    expect(layout.onChange).toHaveBeenCalledWith(true);
    expect(viewer.resize).toHaveBeenCalled();
  });

  it('removes the panes for the single view and restores their mode and camera', () => {
    const { body, canvas, viewer, panes, layout } = setup(true);
    const firstSelect = canvas.parentNode!.parentNode!.children[0]!.children[1]!.children[1]!;
    firstSelect.value = 'mip';
    firstSelect.listeners.change!();
    panes[0].camera.setOrbitState([0.1, 0.2, 2, 0.1, 0.2, 0.3]);
    layout.toggle();
    expect(viewer.removePane).toHaveBeenCalledTimes(3);
    expect(canvas.parentNode).toBe(body);
    expect(body.classList.has('quad-active')).toBe(false);
    layout.toggle();
    const restored = panes.slice(3);
    expect(restored.map(p => p.mode)).toEqual(['mip', 'slice', 'slice']);
    expect(restored[0].camera.getOrbitState()).toEqual([0.1, 0.2, 2, 0.1, 0.2, 0.3]);
    expect(layout.modes()).toEqual(['mip', 'slice', 'slice']);
  });

  it.each(['x', '-x', 'y', '-y', 'z', '-z'] as const)('updates directions and labels for up=%s before opening and while visible', up => {
    const { viewer, panes, canvas, layout } = setup();
    viewer.camera.setUpAxis(up);
    layout.toggle(); // No callback is needed when the layout is hidden.
    const check = (axis: typeof up, current: typeof panes) => {
      axisViews(axis).forEach(({ name, dir }, i) => {
        const expected = new Camera(canvasStub().canvas);
        expected.setUpAxis(axis);
        expected.lookFrom(dir);
        expect(current[i].camera.getUpAxis()).toBe(axis);
        expect(current[i].camera.getOrbitState()).toEqual(expected.getOrbitState());
        const bar = canvas.parentNode!.parentNode!.children[i]!.children[1]!;
        expect(bar.children[0]!.textContent).toBe(name);
        expect(bar.children[1]!.attributes['aria-label']).toBe(`${name} render mode`);
      });
    };
    check(up, panes);
    const next = up === 'z' ? '-y' : 'z';
    viewer.camera.setUpAxis(next);
    layout.syncUpAxis();
    check(next, panes);
    expect(viewer.addPane).toHaveBeenCalledTimes(3); // Reorient existing views without rebuilding GPU resources.
  });

  it('drops stale orbit angles when the up axis changes while hidden and keeps pane modes', () => {
    const { viewer, panes, canvas, layout } = setup(true);
    const select = canvas.parentNode!.parentNode!.children[0]!.children[1]!.children[1]!;
    select.value = 'iso';
    select.listeners.change!();
    panes[2].camera.setOrbitState([0.1, 0.2, 2, 0.3, 0.4, 0.5]);
    layout.toggle();
    viewer.camera.setUpAxis('-z');
    layout.toggle();
    const expected = new Camera(canvasStub().canvas);
    expected.setUpAxis('-z');
    expected.lookFrom([0, 0, -1]);
    expect(panes[5].camera.getOrbitState()).toEqual(expected.getOrbitState());
    expect(layout.modes()).toEqual(['iso', 'slice', 'slice']);
  });
});
