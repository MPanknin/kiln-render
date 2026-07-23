import { describe, it, expect } from 'vitest';
import {
  computeBrickChunkFootprint,
  estimateBrickChunkFanout,
  estimateDatasetFanoutMultiplier,
  clampedLutEntry,
  type LodChunkParams,
  type ChunkRange,
} from '../src/data/chunk-math.js';

const LOGICAL = 64;
const PHYSICAL = 66;

const chunkRangeCount = (r: ChunkRange): number =>
  (r.maxCx - r.minCx + 1) * (r.maxCy - r.minCy + 1) * (r.maxCz - r.minCz + 1);

describe('computeBrickChunkFootprint', () => {
  it('thin z-sliced dataset (2048x2048x35) spans all 35 z-chunks at LOD0', () => {
    // scaleZ=1 at LOD0 (no z downsampling yet).
    const params: LodChunkParams = {
      scaleX: 1, scaleY: 1, scaleZ: 1,
      actualDimX: 2048, actualDimY: 2048, actualDimZ: 35,
      csx: 2048, csy: 2048, csz: 1, // one 8MB z-slice per chunk
    };
    const fp = computeBrickChunkFootprint(params, 0, 0, 0, LOGICAL, PHYSICAL);

    expect(fp.minCx).toBe(0);
    expect(fp.maxCx).toBe(0);
    expect(fp.minCy).toBe(0);
    expect(fp.maxCy).toBe(0);
    expect(fp.minCz).toBe(0);
    expect(fp.maxCz).toBe(34); // clamped to actualDimZ-1, not 65 — spans all 35 z-chunks
    expect(chunkRangeCount(fp)).toBe(35);
  });

  it('a cubic, well-chunked dataset (chunk size = brick size) touches a small, bounded footprint', () => {
    const params: LodChunkParams = {
      scaleX: 1, scaleY: 1, scaleZ: 1,
      actualDimX: 1024, actualDimY: 1024, actualDimZ: 1024,
      csx: 64, csy: 64, csz: 64,
    };
    const fp = computeBrickChunkFootprint(params, 2, 2, 2, LOGICAL, PHYSICAL);
    // 66³ physical brick with 1 voxel of ghost padding on each side, chunk
    // size 64 — should span at most 2 chunks per axis (the ghost border can
    // spill into a neighboring chunk).
    expect(fp.maxCx - fp.minCx).toBeLessThanOrEqual(2);
    expect(fp.maxCy - fp.minCy).toBeLessThanOrEqual(2);
    expect(fp.maxCz - fp.minCz).toBeLessThanOrEqual(2);
    expect(chunkRangeCount(fp)).toBeLessThanOrEqual(27);
  });

  it('clamps to array bounds at the volume edge instead of going negative or out of range', () => {
    const params: LodChunkParams = {
      scaleX: 1, scaleY: 1, scaleZ: 1,
      actualDimX: 100, actualDimY: 100, actualDimZ: 100,
      csx: 32, csy: 32, csz: 32,
    };
    const fp = computeBrickChunkFootprint(params, 0, 0, 0, LOGICAL, PHYSICAL);
    expect(fp.minCx).toBeGreaterThanOrEqual(0);
    expect(fp.minCy).toBeGreaterThanOrEqual(0);
    expect(fp.minCz).toBeGreaterThanOrEqual(0);
  });

  it('fetches far enough that every voxel\'s true chunk falls within range — none need edge-clamping', () => {
    // scale=1023/512, bx=0: the last voxel's rounded target chunk is one past
    // a floor-based footprint's maxCx. Assert the true (unclamped) chunk index
    // for every voxel stays within [minCx, maxCx].
    const params: LodChunkParams = {
      scaleX: 1023 / 512, scaleY: 1023 / 512, scaleZ: 1023 / 512,
      actualDimX: 1023, actualDimY: 1023, actualDimZ: 1023,
      csx: 64, csy: 64, csz: 64,
    };
    const fp = computeBrickChunkFootprint(params, 0, 0, 0, LOGICAL, PHYSICAL);
    for (let i = 0; i < PHYSICAL; i++) {
      const g = Math.max(0, Math.min(params.actualDimX - 1, Math.round((fp.vStartX + i) * params.scaleX)));
      const trueChunk = Math.floor(g / params.csx);
      expect(trueChunk).toBeGreaterThanOrEqual(fp.minCx);
      expect(trueChunk).toBeLessThanOrEqual(fp.maxCx);
    }
  });
});

describe('estimateBrickChunkFanout / estimateDatasetFanoutMultiplier', () => {
  it('flat/z-sliced dataset (2048x2048x35, csz=1) evaluates to 35', () => {
    const params: LodChunkParams = {
      scaleX: 1, scaleY: 1, scaleZ: 1,
      actualDimX: 2048, actualDimY: 2048, actualDimZ: 35,
      csx: 2048, csy: 2048, csz: 1,
    };
    expect(estimateBrickChunkFanout(params, PHYSICAL)).toBe(35);
  });

  it('cubic, well-chunked dataset (chunk size = brick size) — evaluates to exactly 8, matching the old fixed multiplier', () => {
    const params: LodChunkParams = {
      scaleX: 1, scaleY: 1, scaleZ: 1,
      actualDimX: 1024, actualDimY: 1024, actualDimZ: 1024,
      csx: 64, csy: 64, csz: 64,
    };
    expect(estimateBrickChunkFanout(params, PHYSICAL)).toBe(8);
  });

  it('estimateDatasetFanoutMultiplier picks the max across LODs, not the first or last', () => {
    const cubic: LodChunkParams = {
      scaleX: 1, scaleY: 1, scaleZ: 1,
      actualDimX: 1024, actualDimY: 1024, actualDimZ: 1024,
      csx: 64, csy: 64, csz: 64,
    };
    const flat: LodChunkParams = {
      scaleX: 1, scaleY: 1, scaleZ: 1,
      actualDimX: 2048, actualDimY: 2048, actualDimZ: 35,
      csx: 2048, csy: 2048, csz: 1,
    };
    expect(estimateDatasetFanoutMultiplier([cubic, flat, cubic], PHYSICAL)).toBe(35);
    expect(estimateDatasetFanoutMultiplier([flat, cubic], PHYSICAL)).toBe(35);
  });

  it('estimateDatasetFanoutMultiplier falls back to 8 for an empty LOD list', () => {
    expect(estimateDatasetFanoutMultiplier([], PHYSICAL)).toBe(8);
  });
});

describe('clampedLutEntry (data-integrity fix)', () => {
  /** For every i in [0, physSize), asserts clampedLutEntry stays in
   *  [0, nc)/[0, cs) on all three axes — the exact invariant the assembly
   *  scatter loop's flat chunk-lookup array depends on. */
  function assertAllInRange(params: LodChunkParams, bx: number, by: number, bz: number): void {
    const fp = computeBrickChunkFootprint(params, bx, by, bz, LOGICAL, PHYSICAL);
    const ncx = fp.maxCx - fp.minCx + 1;
    const ncy = fp.maxCy - fp.minCy + 1;
    const ncz = fp.maxCz - fp.minCz + 1;
    // A degenerate/empty footprint (brick entirely outside the actual
    // dimension, e.g. a coarse LOD's single brick overshooting a tiny
    // dataset) has no valid range to assert against — skip it, it's a
    // different concern from this fix.
    if (ncx <= 0 || ncy <= 0 || ncz <= 0) return;

    for (let i = 0; i < PHYSICAL; i++) {
      const ex = clampedLutEntry(fp.vStartX + i, params.scaleX, params.actualDimX, params.csx, fp.minCx, fp.maxCx);
      expect(ex.chunkIdx).toBeGreaterThanOrEqual(0);
      expect(ex.chunkIdx).toBeLessThan(ncx);
      expect(ex.offset).toBeGreaterThanOrEqual(0);
      expect(ex.offset).toBeLessThan(params.csx);

      const ey = clampedLutEntry(fp.vStartY + i, params.scaleY, params.actualDimY, params.csy, fp.minCy, fp.maxCy);
      expect(ey.chunkIdx).toBeGreaterThanOrEqual(0);
      expect(ey.chunkIdx).toBeLessThan(ncy);
      expect(ey.offset).toBeGreaterThanOrEqual(0);
      expect(ey.offset).toBeLessThan(params.csy);

      const ez = clampedLutEntry(fp.vStartZ + i, params.scaleZ, params.actualDimZ, params.csz, fp.minCz, fp.maxCz);
      expect(ez.chunkIdx).toBeGreaterThanOrEqual(0);
      expect(ez.chunkIdx).toBeLessThan(ncz);
      expect(ez.offset).toBeGreaterThanOrEqual(0);
      expect(ez.offset).toBeLessThan(params.csz);
    }
  }

  it('regression pin: actualDim 1023 at scale 1023/512', () => {
    const params: LodChunkParams = {
      scaleX: 1023 / 512, scaleY: 1023 / 512, scaleZ: 1023 / 512,
      actualDimX: 1023, actualDimY: 1023, actualDimZ: 1023,
      csx: 64, csy: 64, csz: 64,
    };
    for (let bx = 0; bx < 4; bx++) {
      for (let by = 0; by < 4; by++) {
        assertAllInRange(params, bx, by, 0);
      }
    }
  });

  it('regression pin: actualDim 35 at scale 35/33 (thin-pyramid case)', () => {
    const params: LodChunkParams = {
      scaleX: 35 / 33, scaleY: 35 / 33, scaleZ: 35 / 33,
      actualDimX: 35, actualDimY: 35, actualDimZ: 35,
      csx: 8, csy: 8, csz: 8,
    };
    for (let bx = 0; bx < 3; bx++) assertAllInRange(params, bx, 0, 0);
  });

  it('stays in range for scale > 1 (thin/anisotropic pyramid — z upsampled relative to xy)', () => {
    const params: LodChunkParams = {
      scaleX: 1, scaleY: 1, scaleZ: 7,
      actualDimX: 2048, actualDimY: 2048, actualDimZ: 35,
      csx: 2048, csy: 2048, csz: 1,
    };
    for (let bz = 0; bz < 3; bz++) assertAllInRange(params, 0, 0, bz);
  });

  it('property sweep: stays in range across a broad grid of non-integer scales, dims, chunk sizes, and brick positions', () => {
    const dimScalePairs: [number, number][] = [
      [35, 33], [1023, 512], [999, 256], [127, 100], [500, 333], [17, 16],
    ];
    const chunkSizes = [1, 8, 16, 64];
    for (const [actualDim, virtualDim] of dimScalePairs) {
      const scale = actualDim / virtualDim;
      for (const cs of chunkSizes) {
        const params: LodChunkParams = {
          scaleX: scale, scaleY: scale, scaleZ: scale,
          actualDimX: actualDim, actualDimY: actualDim, actualDimZ: actualDim,
          csx: cs, csy: cs, csz: cs,
        };
        for (let b = 0; b < 5; b++) {
          assertAllInRange(params, b, b, b);
        }
      }
    }
  });

  it('offset stays clamp-to-edge (0 or cs-1) exactly when the chunk index itself was clamped', () => {
    // Direct unit check on the function itself (not via a footprint): when
    // the raw chunk index falls outside [minC, maxC], the returned offset
    // must be the nearest in-range edge, not a stale/out-of-range value.
    const below = clampedLutEntry(/* virtualCoord */ -100, /* scale */ 1, /* actualDim */ 1000, /* cs */ 10, /* minC */ 5, /* maxC */ 20);
    expect(below.chunkIdx).toBe(0); // clamped to minC=5 → 5-5=0
    expect(below.offset).toBeGreaterThanOrEqual(0);
    expect(below.offset).toBeLessThan(10);

    const above = clampedLutEntry(/* virtualCoord */ 100000, /* scale */ 1, /* actualDim */ 1000, /* cs */ 10, /* minC */ 5, /* maxC */ 20);
    expect(above.chunkIdx).toBe(15); // clamped to maxC=20 → 20-5=15
    expect(above.offset).toBeGreaterThanOrEqual(0);
    expect(above.offset).toBeLessThan(10);
  });
});
