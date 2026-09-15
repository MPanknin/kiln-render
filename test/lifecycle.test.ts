/**
 * Lifecycle: dispose and clear() form a generation boundary — completions from an
 * older load never mutate state, workers settle their pending promises, textures die.
 */
import { describe, it, expect, vi } from 'vitest';
import { mat4 } from 'wgpu-matrix';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { DatasetConfig } from '../src/core/config.js';
import { ZarrWorkerPool } from '../src/data/zarr-worker-pool.js';
import { DecompressionPool } from '../src/data/decompression-pool.js';
import { IndirectionTable } from '../src/core/indirection.js';
import type { DataProvider, VolumeMetadata, NetworkStats, BrickLoadResult } from '../src/data/data-provider.js';
import type { ViewParams } from '../src/core/view.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));

// 64³ volume, one LOD, a single base brick.
const metadata: VolumeMetadata = {
  name: 'lifecycle', dimensions: [64, 64, 64], brickSize: 64, physicalBrickSize: 66,
  maxLod: 0, bitDepth: 8, numChannels: 1,
  levels: [{ lod: 0, dimensions: [64, 64, 64], brickGrid: [1, 1, 1], brickCount: 1 }],
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const brickResult = (): BrickLoadResult => ({ data: new Uint8Array(66 ** 3), min: 0, max: 128, avg: 64 });

function makeProvider(loadBrick: DataProvider['loadBrick']): DataProvider {
  return {
    initialize: vi.fn().mockResolvedValue(metadata),
    getMetadata: vi.fn().mockReturnValue(metadata),
    getBrickGrid: vi.fn().mockReturnValue([1, 1, 1] as [number, number, number]),
    loadBrick: vi.fn(loadBrick),
    isBrickEmpty: vi.fn().mockResolvedValue(false),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 } as NetworkStats),
    dispose: vi.fn(),
  };
}

function makeResources() {
  return {
    numChannels: 1,
    allocator: {
      allocate: vi.fn(() => ({ slot: { x: 0, y: 0, z: 0 }, slotIndex: 0, evicted: null })),
      setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(), reset: vi.fn(),
      usedCount: 0, totalSlots: 512,
    },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: [{ bitDepth: 8 }],
  };
}

function stubView(): ViewParams {
  const pos: [number, number, number] = [0, 0, 3];
  return {
    position: new Float32Array(pos),
    view: mat4.lookAt(pos, [0, 0, 0], [0, 1, 0]) as Float32Array,
    proj: mat4.perspective(Math.PI / 4, 4 / 3, 0.01, 100) as Float32Array,
    fovY: Math.PI / 4, width: 800, height: 600,
  };
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('StreamingManager lifecycle', () => {
  it('dispose aborts the base load and ignores its late completion', async () => {
    const pending = deferred<BrickLoadResult>();
    let signalSeen: AbortSignal | undefined;
    const provider = makeProvider((_l, _x, _y, _z, _c, signal) => { signalSeen = signal; return pending.promise; });
    const resources = makeResources();
    const sm = new StreamingManager(resources as never, provider, metadata, {} as GPUDevice, new DatasetConfig([64, 64, 64]) as never, vi.fn());
    await vi.waitFor(() => expect(provider.loadBrick).toHaveBeenCalled());

    sm.dispose();
    expect(signalSeen?.aborted).toBe(true);
    pending.resolve(brickResult());
    await tick();

    expect(resources.indirection.setBrick).not.toHaveBeenCalled();
    expect(sm.baseLodLoaded).toBe(false);
  });

  it('clear() during an unfinished base load discards the old generation', async () => {
    const first = deferred<BrickLoadResult>();
    let calls = 0;
    const provider = makeProvider(() => (++calls === 1 ? first.promise : Promise.resolve(brickResult())));
    const resources = makeResources();
    const sm = new StreamingManager(resources as never, provider, metadata, {} as GPUDevice, new DatasetConfig([64, 64, 64]) as never, vi.fn());
    await vi.waitFor(() => expect(calls).toBe(1));

    sm.clear();
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    expect(resources.indirection.setBrick).toHaveBeenCalledTimes(1);

    first.resolve(brickResult());
    await tick();
    expect(resources.indirection.setBrick).toHaveBeenCalledTimes(1); // stale completion dropped
    expect(sm.getStats().bricksFailed).toBe(0);
  });

  it('update and forceUpdate are no-ops after dispose', async () => {
    const provider = makeProvider(() => Promise.resolve(brickResult()));
    const sm = new StreamingManager(makeResources() as never, provider, metadata, {} as GPUDevice, new DatasetConfig([64, 64, 64]) as never, vi.fn());
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    sm.dispose();
    sm.update(stubView());
    sm.forceUpdate(stubView());
    expect((sm as unknown as { desiredKeys: Set<string> }).desiredKeys.size).toBe(0);
  });
});

describe('worker pools settle pending work on terminate', () => {
  it('ZarrWorkerPool rejects pending requests with AbortError', () => {
    const pool: any = Object.create(ZarrWorkerPool.prototype);
    const reject = vi.fn();
    pool.workers = [];
    pool.pendingRequests = new Map([[1, { resolve: vi.fn(), reject }]]);
    pool.requestToWorker = new Map();
    pool.abortListeners = new Map();
    pool.terminate();
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
    expect(pool.pendingRequests.size).toBe(0);
  });

  it('DecompressionPool rejects pending requests with AbortError', () => {
    const pool: any = Object.create(DecompressionPool.prototype);
    const reject = vi.fn();
    pool.workers = [];
    pool.pendingRequests = new Map([[1, { resolve: vi.fn(), reject }]]);
    pool.terminate();
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
  });
});

describe('GPU texture ownership', () => {
  it('IndirectionTable.dispose destroys its texture', () => {
    vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2 });
    try {
      const destroy = vi.fn();
      const device: any = { createTexture: () => ({ destroy }), queue: { writeTexture: vi.fn() } };
      const table = new IndirectionTable(device, new DatasetConfig([128, 128, 128]));
      table.dispose();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
