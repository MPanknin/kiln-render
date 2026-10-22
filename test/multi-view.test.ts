/**
 * Several views of one dataset: the streaming manager loads the union of what the views
 * need, each view keeps its own ray guidance, and the engine renders each view with its own
 * mode and accumulation while the other display settings follow view 0.
 */
import { describe, expect, it, vi } from 'vitest';
import { mat4 } from 'wgpu-matrix';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { RayVisibility } from '../src/streaming/ray-visibility.js';
import { DatasetConfig } from '../src/core/config.js';
import { Renderer } from '../src/core/renderer.js';
import { KilnEngine } from '../src/engine.js';
import type { ViewParams } from '../src/core/view.js';

function view(pos: [number, number, number], target: [number, number, number] = [0, 0, 0]): ViewParams {
  const width = 800, height = 600, fovY = Math.PI / 4;
  return {
    position: new Float32Array(pos),
    view: mat4.lookAt(pos, target, [0, 1, 0]) as Float32Array,
    proj: mat4.perspective(fovY, width / height, 0.01, 100) as Float32Array,
    fovY, width, height,
  };
}

/** Streaming manager past its base load: a 512³ volume with brick grids 8 → 4 → 2 → 1, nothing resident. */
function manager(): any {
  const m: any = Object.create(StreamingManager.prototype);
  const levels = [8, 4, 2, 1].map((n, lod) => ({ lod, brickGrid: [n, n, n] }));
  Object.assign(m, {
    disposed: false, baseLodLoaded: true, maxLod: 3, maxPixelError: 8, maxDesiredBricks: 10000,
    levelsByLod: levels, config: new DatasetConfig([512, 512, 512], [1, 1, 1]),
    loadedBricks: new Map(), emptyBricks: new Map(), pinnedBricks: new Set(), desiredKeys: new Set(),
    inFlightRequests: new Map(), inFlightStaleTime: new Map(), loadQueue: [], lastStats: {},
    resources: { allocator: { touch: vi.fn(), usedCount: 0, totalSlots: 512 } },
    frameCount: 0, rayGuided: false, rayViews: [],
  });
  return m;
}

function desired(views: ViewParams[]): Map<string, number> {
  const m = manager();
  m.forceUpdate(views);
  return new Map(m.loadQueue.map((b: { key: string; distance: number }) => [b.key, b.distance]));
}

describe('streaming for several views', () => {
  it('loads the union of what each view needs', () => {
    const near = view([0, 0, 0.9]);
    const side = view([1.6, 0, 0]);
    const both = desired([near, side]);
    const union = new Set([...desired([near]).keys(), ...desired([side]).keys()]);
    expect([...both.keys()].sort()).toEqual([...union].sort());
  });

  it('queues a brick that several views need once, at the nearest distance', () => {
    const a = desired([view([0, 0, 2])]);
    const b = desired([view([0.3, 0, 2.2])]);
    const both = desired([view([0, 0, 2]), view([0.3, 0, 2.2])]);
    const shared = [...a.keys()].filter(key => b.has(key));
    expect(shared.length).toBeGreaterThan(0);
    for (const key of shared) expect(both.get(key)).toBe(Math.min(a.get(key)!, b.get(key)!));
  });

  it('takes a single view as before', () => {
    const m = manager();
    m.forceUpdate(view([0, 0, 0.9]));
    expect(new Map(m.loadQueue.map((b: { key: string; distance: number }) => [b.key, b.distance]))).toEqual(desired([view([0, 0, 0.9])]));
  });
});

describe('ray guidance per view', () => {
  const grid: [number, number, number] = [4, 4, 4];
  function guided(): any {
    const m: any = Object.create(StreamingManager.prototype);
    Object.assign(m, {
      maxLod: 2, rayGuided: false, rayViews: [], lastCameraPos: [],
      config: { datasetGrid: grid, levelSpanCells: (lod: number) => [2 ** lod, 2 ** lod, 2 ** lod] },
    });
    m.enableRayGuidance();
    return m;
  }
  function seen(x: number, y: number, z: number): Uint32Array {
    const out = new Uint32Array(RayVisibility.wordCount(grid));
    const i = (z * grid[1] + y) * grid[0] + x;
    out[i >> 5]! |= 1 << (i & 31);
    return out;
  }

  it("keeps each view's visibility separate", () => {
    const m = guided();
    m.reportRayVisibility(seen(3, 1, 0), 1, 0);
    m.reportRayVisibility(seen(0, 0, 0), 1, 1);
    expect(m.rayCulls(3, 1, 0, 0, 0)).toBe(false);
    expect(m.rayCulls(3, 1, 0, 0, 1)).toBe(true);
    expect(m.rayCulls(0, 0, 0, 0, 1)).toBe(false);
  });

  it('a view without rays culls nothing while the others still cull', () => {
    const m = guided();
    m.reportRayVisibility(seen(3, 1, 0), 1, 0);
    m.setRayGuidanceActive(false, 1);
    expect(m.rayCulls(0, 0, 0, 0, 1)).toBe(false);
    expect(m.rayCulls(0, 0, 0, 0, 0)).toBe(true);
  });

  it('removing a view moves the later ones down', () => {
    const m = guided();
    m.reportRayVisibility(seen(3, 1, 0), 1, 0);
    m.reportRayVisibility(seen(0, 0, 0), 1, 1);
    m.removeView(0);
    expect(m.rayCulls(0, 0, 0, 0, 0)).toBe(false);
    expect(m.rayCulls(3, 1, 0, 0, 0)).toBe(true);
  });
});

describe('engine with several views', () => {
  function renderer(mode: 'dvr' | 'mip' = 'dvr', converged = true): any {
    const r: any = Object.create(Renderer.prototype);
    const active = { accumFrameCount: converged ? 64 : 0 };
    Object.assign(r, {
      resources: { numChannels: 1 }, volumeRenderMode: mode, useIndirection: true, enableTAA: true,
      renderScale: 1, active, scaleSets: new Map([[1, active]]), activateScale: vi.fn(),
      windowCenter: 0.5, windowWidth: 1, clipMin: new Float32Array([0, 0, 0]), clipMax: new Float32Array([1, 1, 1]),
      channelColors: new Float32Array(16), channelWindowCenter: new Float32Array(4), channelWindowWidth: new Float32Array(4),
      onDirty: vi.fn(), dispose: vi.fn(),
    });
    return r;
  }
  function engine(renderers: any[]): any {
    const e: any = Object.create(KilnEngine.prototype);
    Object.assign(e, {
      disposed: false, vpScratch: new Float32Array(16), userRenderScale: 1, interactionRenderScale: 0,
      transferFunction: { version: 0 },
      _streamingManager: { setVisibleChannels: vi.fn(), setRayGuidanceActive: vi.fn(), update: vi.fn(), removeView: vi.fn() },
      views: renderers.map(r => ({ renderer: r, dirty: false, lastVP: mat4.identity(), hasLastVP: false, lastMoveTime: -1e9, width: 8, height: 8, tfVersion: 0 })),
    });
    return e;
  }
  const still = (v: ViewParams): ViewParams => ({ ...v, interacting: false });

  it('streams for every camera and reports per view whether to render', () => {
    const e = engine([renderer('dvr', true), renderer('mip', false)]);
    const cams = [still(view([0, 0, 2])), still(view([2, 0, 0]))];
    expect(e.updateViews(cams)).toEqual([true, true]); // first frame of each camera
    expect(e._streamingManager.update).toHaveBeenCalledWith(cams);
    expect(e._streamingManager.setRayGuidanceActive).toHaveBeenCalledWith(true, 1);
    expect(e.updateViews(cams)).toEqual([false, true]); // view 1 still accumulating
  });

  it("other views follow view 0's look but keep their own mode", () => {
    const primary = renderer('dvr');
    const other = renderer('mip');
    const e = engine([primary, other]);
    const cams = [still(view([0, 0, 2])), still(view([2, 0, 0]))];
    e.updateViews(cams);
    primary.windowCenter = 0.3;
    primary.clipMax[2] = 0.5;
    e.updateViews(cams);
    expect(other.windowCenter).toBe(0.3);
    expect(other.clipMax[2]).toBe(0.5);
    expect(other.volumeRenderMode).toBe('mip');
    expect(other.active.accumFrameCount).toBe(0);
  });

  it('a transfer function change restarts accumulation in the other views', () => {
    const other = renderer('mip');
    const e = engine([renderer('dvr'), other]);
    const cams = [still(view([0, 0, 2])), still(view([2, 0, 0]))];
    e.updateViews(cams);
    expect(other.active.accumFrameCount).toBe(64);
    e.transferFunction.version++;
    e.updateViews(cams);
    expect(other.active.accumFrameCount).toBe(0);
  });

  it('adds and removes views', () => {
    const e = engine([renderer('dvr')]);
    const added = renderer('dvr');
    e.buildViewRenderer = vi.fn(() => added);
    expect(e.addView()).toBe(1);
    expect(e.viewCount).toBe(2);
    expect(e.getRenderer(1)).toBe(added);
    e.removeView(1);
    expect(added.dispose).toHaveBeenCalled();
    expect(e._streamingManager.removeView).toHaveBeenCalledWith(1);
    expect(() => e.removeView(0)).toThrow(RangeError);
  });
});
