/** Routing-hash fix: workerIndexForChunk's mix step used a plain float64
 *  multiply, which overflows MAX_SAFE_INTEGER and collapsed most coordinates
 *  onto worker 0. Fixed with Math.imul + a second avalanche step. Pokes private state directly. */

import { describe, it, expect, vi } from 'vitest';
import { ZarrWorkerPool } from '../src/data/zarr-worker-pool.js';

const LOD_PARAMS = [{
  scaleX: 1, scaleY: 1, scaleZ: 1,
  actualDimX: 512, actualDimY: 512, actualDimZ: 512,
  csx: 64, csy: 64, csz: 64,
  shapePrefixLength: 1, channelAxisIdx: 0,
}];

/** The current (post-fix) hash, copied verbatim — NOT imported — so a
 *  future edit can't silently drift from the "channelIndex=0 is a no-op"
 *  guarantee, or regress back to the broken plain-multiply mix, without
 *  failing this test. */
function referenceHash(lod: number, cx: number, cy: number, cz: number, channelIndex: number, workerCount: number): number {
  let h = (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791) ^ ((lod + 1) * 2654435761) ^ (channelIndex * 2246822519);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h = (h ^ (h >>> 15)) >>> 0;
  return h % workerCount;
}

function makeFakeWorkers(n: number) {
  return Array.from({ length: n }, () => ({ postMessage: vi.fn(), onmessage: null }));
}

function makePool(workerCount: number): ZarrWorkerPool {
  const pool = new ZarrWorkerPool(workerCount);
  (pool as any).lodParams = LOD_PARAMS;
  (pool as any).logicalBrickSize = 64;
  (pool as any).workers = makeFakeWorkers(workerCount);
  return pool;
}

describe('ZarrWorkerPool — routing hash fix + channel-aware routing', () => {
  it('matches the reference imul+avalanche formula exactly', () => {
    const pool = makePool(8);
    for (const [cx, cy, cz, ch] of [[0, 0, 0, 0], [3, 1, 4, 2], [10, 0, 2, 5], [-7, 12, -3, 1]]) {
      expect((pool as any).workerIndexForChunk(0, cx, cy, cz, ch))
        .toBe(referenceHash(0, cx!, cy!, cz!, ch!, 8));
    }
  });

  it('channelIndex=0 (workerIndexForChunk\'s default, for callers with no channel axis) is a bit-identical no-op', () => {
    const pool = makePool(8);
    for (const [cx, cy, cz] of [[0, 0, 0], [3, 1, 4], [10, 0, 2]]) {
      const withDefault = (pool as any).workerIndexForChunk(0, cx, cy, cz);
      const withExplicitZero = (pool as any).workerIndexForChunk(0, cx, cy, cz, 0);
      expect(withDefault).toBe(referenceHash(0, cx!, cy!, cz!, 0, 8));
      expect(withExplicitZero).toBe(referenceHash(0, cx!, cy!, cz!, 0, 8));
    }
  });

  it('workerIndexFor (single-brick routing) is deterministic and matches the shared hash, including the channel term', () => {
    const pool = makePool(8);
    const idx1 = (pool as any).workerIndexFor(0, 0, 0, 0, 2);
    const idx2 = (pool as any).workerIndexFor(0, 0, 0, 0, 2);
    expect(idx1).toBe(idx2);
    // bx=by=bz=0 → minChunk 0,0,0 for this (cubic) lodParams; channel 2 must
    // land on the same worker workerIndexForChunk itself would pick.
    expect(idx1).toBe(referenceHash(0, 0, 0, 0, 2, 8));
  });

  it('workerIndexFor spreads one brick\'s channels across ≥2 workers on flat-geometry data', () => {
    // Mirrors the real flat/z-sliced blocker case (4496763.zarr): one chunk
    // covers the entire x/y plane (csx/csy == actualDim), so EVERY brick's
    // min-corner chunk is (0, 0, cz) regardless of bx/by — channel is the
    // ONLY thing left to distinguish one brick's per-channel requests.
    const FLAT_LOD_PARAMS = [{
      scaleX: 1, scaleY: 1, scaleZ: 1,
      actualDimX: 2048, actualDimY: 2048, actualDimZ: 25,
      csx: 2048, csy: 2048, csz: 1,
      shapePrefixLength: 1, channelAxisIdx: 0,
    }];
    const pool = new ZarrWorkerPool(8);
    (pool as any).lodParams = FLAT_LOD_PARAMS;
    (pool as any).logicalBrickSize = 64;
    (pool as any).workers = makeFakeWorkers(8);

    const seenWorkers = new Set<number>();
    for (let ch = 0; ch < 4; ch++) {
      seenWorkers.add((pool as any).workerIndexFor(0, 0, 0, 0, ch));
    }
    // Assert distribution, not exact worker ids — the hash is opaque.
    expect(seenWorkers.size).toBeGreaterThan(1);
  });

  it('index is always in [0, n) — no negative modulo from the avalanche step', () => {
    const pool = makePool(8);
    for (let cx = -50; cx < 50; cx += 3) {
      for (let ch = 0; ch < 8; ch++) {
        const idx = (pool as any).workerIndexForChunk(1, cx, 3, 7, ch);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(8);
      }
    }
  });

  it('distributes near-uniformly over a general coordinate domain (regression guard)', () => {
    const pool = makePool(8);
    const counts = new Array(8).fill(0);
    let total = 0;
    for (let cx = 0; cx < 20; cx++) {
      for (let cy = 0; cy < 20; cy++) {
        for (let cz = 0; cz < 20; cz++) {
          counts[(pool as any).workerIndexForChunk(0, cx, cy, cz, 0)]++;
          total++;
        }
      }
    }
    // Before the fix this was 7958/8000 in bucket 0. An even split would be
    // 1000/bucket — assert every bucket gets a meaningful share, not a
    // collapse onto one or two.
    for (const c of counts) expect(c).toBeGreaterThan(total * 0.05);
  });

  it('distributes near-uniformly even on a flat dataset\'s degenerate domain (cx=cy=0 always, only cz/lod/channel vary)', () => {
    const pool = makePool(8);
    const counts = new Array(8).fill(0);
    let total = 0;
    for (let cz = 0; cz < 40; cz++) {
      for (let lod = 0; lod < 3; lod++) {
        for (let ch = 0; ch < 4; ch++) {
          counts[(pool as any).workerIndexForChunk(lod, 0, 0, cz, ch)]++;
          total++;
        }
      }
    }
    // This exact domain was 479/480 in bucket 0 before the fix.
    for (const c of counts) expect(c).toBeGreaterThan(total * 0.05);
  });

  it('sweeping channelIndex for a fixed chunk coordinate spreads across more than one worker', () => {
    const pool = makePool(8);
    const seen = new Set<number>();
    for (let ch = 0; ch < 8; ch++) {
      seen.add((pool as any).workerIndexForChunk(0, 5, 5, 5, ch));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
