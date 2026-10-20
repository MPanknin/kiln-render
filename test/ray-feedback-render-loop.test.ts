import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mat4 } from 'wgpu-matrix';
import { KilnEngine } from '../src/engine.js';
import { Renderer } from '../src/core/renderer.js';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { COMPUTE_UNIFORMS } from '../src/shaders/uniform-layout.js';

function bits(...cells: number[]): Uint32Array {
  const result = new Uint32Array(2);
  for (const cell of cells) result[cell >> 5]! |= 1 << (cell & 31);
  return result;
}

/** Real engine/render/readback/selection methods with GPU commands and completed brick loads stubbed. */
function harness({ taa = false, enabled = true } = {}) {
  const manager: any = Object.create(StreamingManager.prototype);
  Object.assign(manager, {
    config: { datasetGrid: [4, 4, 4], levelSpanCells: (lod: number) => [2 ** lod, 2 ** lod, 2 ** lod] },
    maxLod: 2,
    update: vi.fn(), milestones: { firstAtlasCommit: null },
  });
  if (enabled) manager.enableRayGuidance();

  const maps: Array<{ resolve: () => void; reject: (reason: Error) => void }> = [];
  let mapping = false;
  let staged = bits();
  const visited = bits();
  let nextVisits = bits(0);
  const staging = {
    size: 8,
    mapAsync: vi.fn(() => {
      expect(mapping).toBe(false);
      mapping = true;
      return new Promise<void>((resolve, reject) => maps.push({ resolve, reject }));
    }),
    getMappedRange: () => staged.buffer,
    unmap: vi.fn(() => { mapping = false; }),
  };
  const volumePipeline = {};
  const march = vi.fn(() => {
    for (let i = 0; i < visited.length; i++) visited[i]! |= nextVisits[i]!;
  });
  const copy = vi.fn(() => {
    expect(mapping).toBe(false); // never copy into a mapped or mapping staging buffer
    staged = visited.slice();
  });
  const device = {
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
    createCommandEncoder: () => ({
      beginComputePass: () => {
        let pipeline: unknown;
        return {
          setPipeline: (value: unknown) => { pipeline = value; },
          setBindGroup: vi.fn(),
          dispatchWorkgroups: () => { if (pipeline === volumePipeline) march(); },
          end: vi.fn(),
        };
      },
      beginRenderPass: () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() }),
      copyBufferToBuffer: copy,
      clearBuffer: () => visited.fill(0),
      finish: vi.fn(),
    }),
  };
  const renderer: any = Object.create(Renderer.prototype);
  const uniforms = new Float32Array(COMPUTE_UNIFORMS.size / 4);
  const active = { width: 8, height: 8, accumFrameCount: 0, accumIndex: 0, accumBindGroups: [{}, {}], blitBindGroups: [{}, {}] };
  Object.assign(renderer, {
    device, resources: { numChannels: 1 },
    config: { dimensions: [256, 256, 256], normalizedSize: [1, 1, 1] },
    active, scaleSets: new Map([[1, active]]), renderScale: 1,
    enableTAA: taa, volumeRenderMode: 'dvr', useIndirection: true,
    vpScratch: new Float32Array(16), invVPScratch: new Float32Array(16), prevVP: mat4.identity(),
    computeUniformScratch: uniforms, computeUniformView: new DataView(uniforms.buffer),
    accumScratch: new Float32Array(4), computePipeline: volumePipeline, frameIndex: 0,
    clipMin: [0, 0, 0], clipMax: [1, 1, 1],
    channelColors: new Float32Array(16), channelWindowCenter: new Float32Array(4), channelWindowWidth: new Float32Array(4),
    rayReadback: enabled ? staging : null, rayReadbackBusy: false, rayFramesPending: 0,
    onRayVisibility: vi.fn((value: Uint32Array, frames: number) => manager.reportRayVisibility(value, frames)),
  });
  const engine: any = Object.create(KilnEngine.prototype);
  Object.assign(engine, {
    views: [{ renderer, dirty: true, lastVP: mat4.identity(), hasLastVP: true, lastMoveTime: -10000, width: 8, height: 8 }],
    _streamingManager: manager, vpScratch: new Float32Array(16),
    userRenderScale: 1, interactionRenderScale: 0, firstContentSubmit: null,
  });
  renderer.onDirty = () => engine.markDirty();
  const view = { proj: mat4.identity(), view: mat4.identity(), position: [0, 0, 2], interacting: false };
  return {
    engine, renderer, manager, active, staging, copy, march,
    frame(...cells: number[]) {
      nextVisits = bits(...cells);
      if (!engine.update(view)) return false;
      engine.render({}, view);
      return true;
    },
    async completeMap() {
      expect(maps.length).toBe(1);
      maps.shift()!.resolve();
      await Promise.resolve();
    },
    async rejectMap() {
      expect(maps.length).toBe(1);
      mapping = false;
      maps.shift()!.reject(new Error('Buffer destroyed'));
      await Promise.resolve();
    },
  };
}

beforeEach(() => vi.stubGlobal('GPUMapMode', { READ: 1 }));
afterEach(() => vi.unstubAllGlobals());

describe('ray feedback when rendering goes idle', () => {
  it.each([false, true])('expires visibility after 16 rendered frames through the full feedback path (TAA: %s)', async (taa) => {
    const h = harness({ taa });
    const batchSize = taa ? 4 : 1;
    for (let i = 0; i < batchSize; i++) h.frame(0);
    await h.completeMap();
    for (let elapsed = batchSize; elapsed <= 16; elapsed += batchSize) {
      for (let i = 0; i < batchSize; i++) {
        if (!taa) h.renderer.resetAccumulation();
        h.frame(); // no rays revisit cell zero
      }
      await h.completeMap();
      expect(h.manager.rayCulls(0, 0, 0, 0)).toBe(elapsed === 16);
    }
  });

  it('delivers the first TAA-off frame so refinement can start', async () => {
    const h = harness();
    expect(h.manager.rayCulls(1, 0, 0, 0)).toBe(true);
    expect(h.frame(1)).toBe(true);
    await h.completeMap();
    expect(h.manager.rayCulls(1, 0, 0, 0)).toBe(false);
    expect(h.frame(1)).toBe(false);
    expect(h.march).toHaveBeenCalledOnce();
    expect(h.renderer.onRayVisibility).toHaveBeenCalledWith(bits(1), 1);
  });

  it('delivers a stationary parameter change without requesting more draws', async () => {
    const h = harness();
    h.frame(0);
    await h.completeMap();
    expect(h.frame(0)).toBe(false);

    h.renderer.clipMin[0] = 0.25;
    h.renderer.resetAccumulation();
    h.frame(1); // simulated GPU visibility after exposing another region
    await h.completeMap();
    for (let i = 0; i < 600; i++) expect(h.frame(1)).toBe(false);
    expect(h.manager.rayCulls(1, 0, 0, 0)).toBe(false);
    expect(h.march).toHaveBeenCalledTimes(2);
  });

  it('drains changes collected during an older mapping with no extra raymarch', async () => {
    const h = harness();
    h.frame(0); // keep this readback pending while two changes render
    h.renderer.resetAccumulation();
    h.frame(1);
    h.renderer.resetAccumulation();
    h.frame(2);
    expect(h.frame(2)).toBe(false);
    expect(h.copy).toHaveBeenCalledOnce();
    await h.completeMap();
    expect(h.copy).toHaveBeenCalledTimes(2);
    await h.completeMap();
    expect(h.manager.rayCulls(1, 0, 0, 0)).toBe(false);
    expect(h.manager.rayCulls(2, 0, 0, 0)).toBe(false);
    expect(h.march).toHaveBeenCalledTimes(3);
    expect(h.renderer.onRayVisibility).toHaveBeenNthCalledWith(1, bits(0), 1);
    expect(h.renderer.onRayVisibility).toHaveBeenNthCalledWith(2, bits(1, 2), 2);
    expect(h.staging.mapAsync).toHaveBeenCalledTimes(2);
    expect(h.frame(2)).toBe(false);
  });

  it('keeps four-frame batching during TAA but flushes a final partial batch', async () => {
    const h = harness({ taa: true });
    for (let i = 0; i < 3; i++) h.frame(0);
    expect(h.copy).not.toHaveBeenCalled();
    h.frame(0);
    expect(h.copy).toHaveBeenCalledOnce();
    await h.completeMap();

    // A batch need not align with convergence (for example after mapping delayed an earlier copy).
    h.active.accumFrameCount = 63;
    h.frame(1);
    expect(h.renderer.isConverged).toBe(true);
    await h.completeMap();
    expect(h.manager.rayCulls(1, 0, 0, 0)).toBe(false);
    expect(h.frame(1)).toBe(false);
  });

  it('drains a final TAA frame that arrived while the previous map was pending', async () => {
    const h = harness({ taa: true });
    for (let i = 0; i < 4; i++) h.frame(0);
    h.active.accumFrameCount = 63;
    h.frame(1);
    expect(h.frame(1)).toBe(false);
    await h.completeMap();
    await h.completeMap();
    expect(h.manager.rayCulls(1, 0, 0, 0)).toBe(false);
    expect(h.march).toHaveBeenCalledTimes(5);
    expect(h.renderer.onRayVisibility).toHaveBeenNthCalledWith(1, bits(0), 4);
    expect(h.renderer.onRayVisibility).toHaveBeenNthCalledWith(2, bits(1), 1);
    expect(h.staging.mapAsync).toHaveBeenCalledTimes(2);
  });

  it('does not schedule feedback while the feature is disabled', () => {
    const h = harness({ enabled: false });
    for (let i = 0; i < 5; i++) {
      h.renderer.resetAccumulation();
      h.frame(0);
    }
    expect(h.copy).not.toHaveBeenCalled();
    expect(h.staging.mapAsync).not.toHaveBeenCalled();
  });

  it('does not drain pending visits after switching to a mode without rays', async () => {
    const h = harness();
    h.frame(0);
    h.renderer.resetAccumulation();
    h.frame(1);
    h.renderer.volumeRenderMode = 'slice';
    h.manager.setRayGuidanceActive(false);
    await h.completeMap();
    expect(h.copy).toHaveBeenCalledOnce();
    expect(h.manager.rayViews[0].visibility.ready).toBe(false);
  });

  it.each([false, true])('does not deliver or drain feedback after disposal (map rejected: %s)', async (reject) => {
    const h = harness();
    h.frame(0);
    h.renderer.resetAccumulation();
    h.frame(1);
    h.renderer.disposed = true;
    if (reject) await h.rejectMap();
    else await h.completeMap();
    expect(h.renderer.onRayVisibility).not.toHaveBeenCalled();
    expect(h.copy).toHaveBeenCalledOnce();
    expect(h.renderer.rayReadbackBusy).toBe(false);
  });
});
