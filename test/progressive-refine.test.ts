/**
 * ?p36=1 progressive multichannel refinement: a refined brick is committed on
 * its first non-empty channel, missing channels show the resident ancestor's
 * data resampled, and real data replaces it on arrival.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { writeToCanvas } from '../src/core/volume.js';
import { upsampleFromAncestor } from '../src/streaming/placeholder.js';
import type { DataProvider, VolumeMetadata, NetworkStats, BrickLoadResult } from '../src/data/data-provider.js';

vi.mock('../src/core/volume.js', () => ({ writeToCanvas: vi.fn() }));
const flags = new Set<string>();
vi.mock('../src/core/feature-flags.js', () => ({
  isFlagEnabled: (name: string) => flags.has(name),
  activeFlags: () => [...flags],
}));

const N = 66 * 66 * 66;
// 128×64×64 volume: lod1 is one brick (base), lod0 has two bricks along x.
const meta: VolumeMetadata = {
  name: 'p', dimensions: [128, 64, 64], brickSize: 64, physicalBrickSize: 66, maxLod: 1, bitDepth: 16, numChannels: 2,
  levels: [
    { lod: 0, dimensions: [128, 64, 64], brickGrid: [2, 1, 1], brickCount: 2 },
    { lod: 1, dimensions: [64, 32, 32], brickGrid: [1, 1, 1], brickCount: 1 },
  ],
};
const config = {
  normalizedSize: [1, 0.5, 0.5] as [number, number, number],
  emptyBrickThreshold: 10,
  levelRatio: (a: number, f: number) => [1 << (a - f), 1 << (a - f), 1 << (a - f)] as [number, number, number],
};

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function filled(v: number) { const d = new Uint16Array(N); for (let i = 0; i < N; i++) d[i] = v + (i % 7); return d; }
const res = (data: Uint16Array, max = 500): BrickLoadResult => ({ data, min: 0, max, avg: 1 });

const baseData = [filled(100), filled(200)];

function setup(fine: (ch: number) => Promise<BrickLoadResult | null>) {
  const provider: DataProvider = {
    initialize: vi.fn().mockResolvedValue(meta), getMetadata: vi.fn().mockReturnValue(meta),
    getBrickGrid: vi.fn(), isBrickEmpty: vi.fn().mockResolvedValue(false), getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({ totalBytesDownloaded: 0, recentBytesPerSecond: 0, requestCount: 0 } as NetworkStats),
    dispose: vi.fn(),
    loadBrick: vi.fn((lod: number, _x: number, _y: number, _z: number, ch = 0) =>
      lod === 1 ? Promise.resolve(res(baseData[ch]!)) : fine(ch)),
  };
  let slot = 0;
  const resources = {
    numChannels: 2,
    allocator: { allocate: vi.fn(() => ({ slot: { x: slot, y: 0, z: 0 }, slotIndex: slot++, evicted: null })), setMetadata: vi.fn(), pin: vi.fn(), touch: vi.fn(), free: vi.fn(), usedCount: 0, totalSlots: 512 },
    indirection: { setBrick: vi.fn(), setEmpty: vi.fn(), clearBrick: vi.fn(), clearAll: vi.fn() },
    canvases: [{ _ch: 0, bitDepth: 16 }, { _ch: 1, bitDepth: 16 }],
  };
  const sm = new StreamingManager(resources as never, provider, meta, {} as GPUDevice, config as never, vi.fn());
  return { sm, resources };
}

const KEY = 'lod0:0/0/1';
async function refine(sm: StreamingManager) {
  await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
  vi.mocked(writeToCanvas).mockClear();
  (sm as unknown as { desiredKeys: Set<string> }).desiredKeys.add(KEY);
  const run = (sm as unknown as { loadBrickProgressive(r: object, s: AbortSignal, c: number[]): Promise<void> }).loadBrickProgressive.bind(sm);
  return run({ lod: 0, bx: 1, by: 0, bz: 0, key: KEY, distance: 1 }, new AbortController().signal, [0, 1]);
}
const writes = () => vi.mocked(writeToCanvas).mock.calls.map(c => ({ ch: (c[1] as { _ch: number })._ch, data: c[2] as Uint16Array }));
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => { flags.clear(); flags.add('p36'); vi.mocked(writeToCanvas).mockClear(); });

describe('progressive refinement (?p36)', () => {
  it('commits on the first channel with the ancestor resampled into the missing one, then replaces it', async () => {
    const ch1 = deferred<BrickLoadResult | null>();
    const fine0 = filled(1000), fine1 = filled(2000);
    const { sm, resources } = setup(ch => ch === 0 ? Promise.resolve(res(fine0)) : ch1.promise);
    const done = refine(sm);
    await vi.waitFor(() => expect(resources.indirection.setBrick).toHaveBeenCalledTimes(2)); // base + refined

    const w = writes();
    expect(w.map(x => x.ch).sort()).toEqual([0, 1]);
    expect(w.find(x => x.ch === 0)!.data).toBe(fine0);
    const expected = upsampleFromAncestor(baseData[1]!, [1, 0, 0], [0, 0, 0], [2, 2, 2]);
    expect(w.find(x => x.ch === 1)!.data).toEqual(expected);

    ch1.resolve(res(fine1));
    await done;
    expect(writes().at(-1)).toEqual({ ch: 1, data: fine1 });
    expect(sm.getStats().bricksCommitted).toBe(1);
  });

  it('without ancestor data in the cache it waits for all channels', async () => {
    const ch1 = deferred<BrickLoadResult | null>();
    const { sm, resources } = setup(ch => ch === 0 ? Promise.resolve(res(filled(1))) : ch1.promise);
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    (sm as unknown as { brickCache: { clear(): void } }).brickCache.clear();
    const done = refine(sm);
    await flush(); await flush();
    expect(resources.indirection.setBrick).toHaveBeenCalledTimes(1); // base only
    ch1.resolve(res(filled(2)));
    await done;
    expect(resources.indirection.setBrick).toHaveBeenCalledTimes(2);
    expect(writes().map(x => x.ch).sort()).toEqual([0, 1]);
  });

  it('a dark first channel does not commit; the first channel with signal does', async () => {
    const ch1 = deferred<BrickLoadResult | null>();
    const { sm, resources } = setup(ch => ch === 0 ? Promise.resolve(res(filled(0), 3)) : ch1.promise);
    const done = refine(sm);
    await flush(); await flush();
    expect(resources.indirection.setBrick).toHaveBeenCalledTimes(1);
    ch1.resolve(res(filled(5)));
    await done;
    expect(resources.indirection.setBrick).toHaveBeenCalledTimes(2);
  });

  it('all channels dark → marked empty, no slot', async () => {
    const { sm, resources } = setup(() => Promise.resolve(res(filled(0), 3)));
    await refine(sm);
    expect(resources.indirection.setEmpty).toHaveBeenCalledTimes(1);
    expect(resources.allocator.allocate).toHaveBeenCalledTimes(1); // base only
  });

  it('a brick no longer desired at first arrival is discarded', async () => {
    const { sm, resources } = setup(() => Promise.resolve(res(filled(9))));
    await vi.waitFor(() => expect(sm.baseLodLoaded).toBe(true));
    const run = (sm as unknown as { loadBrickProgressive(r: object, s: AbortSignal, c: number[]): Promise<void> }).loadBrickProgressive.bind(sm);
    await run({ lod: 0, bx: 1, by: 0, bz: 0, key: KEY, distance: 1 }, new AbortController().signal, [0, 1]);
    expect(resources.indirection.setBrick).toHaveBeenCalledTimes(1);
    expect(sm.getStats().bricksDiscarded).toBe(1);
  });
});
