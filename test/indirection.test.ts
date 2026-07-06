/**
 * IndirectionTable — virtual-brick → atlas-slot mapping.
 *
 * Drives the REAL IndirectionTable class (not a reimplemented closure). The GPU
 * is faked: createTexture returns a stub and writeTexture is recorded, so the
 * class's own CPU-side `data` array — the source of truth mirrored into the
 * texture — is what we assert against.
 *
 * The interesting, easy-to-break logic is LOD priority:
 *  - setBrick fills (2^lod)³ cells and never overwrites a finer/equal LOD
 *  - setEmpty marks a region empty but never clobbers loaded data
 *  - clearBrick only clears cells still at the given LOD, with optional fallback
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IndirectionTable } from '../src/core/indirection.js';
import { DatasetConfig } from '../src/core/config.js';

// GPUTextureUsage is a global only in a real WebGPU context; stub the flags the
// table touches so the class constructs under the node test environment.
(globalThis as unknown as { GPUTextureUsage?: object }).GPUTextureUsage ??= {
  TEXTURE_BINDING: 4, COPY_DST: 2,
} as GPUTextureUsage;

// 512³ volume → LOD-0 dataset grid of 8×8×8, enough headroom for LOD 0..3.
const GX = 8, GY = 8, GZ = 8;
function makeConfig() {
  return new DatasetConfig([512, 512, 512], [1, 1, 1]);
}

function makeDevice() {
  return {
    createTexture: vi.fn(() => ({ destroy: vi.fn() })),
    queue: { writeTexture: vi.fn() },
  } as unknown as GPUDevice;
}

// Decode one indirection cell from the class's private CPU mirror.
// w: 0 = unloaded, lod+1 = loaded at that LOD, 255 = empty marker.
function cell(table: IndirectionTable, x: number, y: number, z: number) {
  const data = (table as unknown as { data: Uint8Array }).data;
  const i = (x + y * GX + z * GX * GY) * 4;
  return { ax: data[i]!, ay: data[i + 1]!, az: data[i + 2]!, w: data[i + 3]! };
}

let device: GPUDevice;
let table: IndirectionTable;

beforeEach(() => {
  device = makeDevice();
  table = new IndirectionTable(device, makeConfig());
});

describe('IndirectionTable — construction', () => {
  it('creates an rgba8uint texture sized to the dataset grid', () => {
    expect(device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({ size: [GX, GY, GZ], format: 'rgba8uint', dimension: '3d' }),
    );
  });

  it('starts with every cell unloaded (w = 0) and uploads once', () => {
    for (let z = 0; z < GZ; z++)
      for (let y = 0; y < GY; y++)
        for (let x = 0; x < GX; x++)
          expect(cell(table, x, y, z).w).toBe(0);
    expect(device.queue.writeTexture).toHaveBeenCalledTimes(1); // initial full upload
  });
});

describe('IndirectionTable — setBrick', () => {
  it('stores raw atlas slot indices and marks the cell loaded (w = lod+1)', () => {
    table.setBrick(2, 3, 4, 5, 6, 7, 0);
    expect(cell(table, 2, 3, 4)).toEqual({ ax: 5, ay: 6, az: 7, w: 1 });
  });

  it('does not disturb neighbouring cells', () => {
    table.setBrick(0, 0, 0, 1, 1, 1, 0);
    expect(cell(table, 1, 0, 0).w).toBe(0);
    expect(cell(table, 0, 1, 0).w).toBe(0);
    expect(cell(table, 7, 7, 7).w).toBe(0);
  });

  it('fills (2^lod)³ cells for a coarse LOD brick', () => {
    // LOD 1 brick (0,0,0) covers the 2×2×2 block of LOD-0 cells
    table.setBrick(0, 0, 0, 4, 4, 4, 1);
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++)
          expect(cell(table, x, y, z)).toEqual({ ax: 4, ay: 4, az: 4, w: 2 });
    expect(cell(table, 2, 0, 0).w).toBe(0); // just outside the covered block
  });

  it('uploads the affected region to the GPU', () => {
    vi.mocked(device.queue.writeTexture).mockClear();
    table.setBrick(1, 1, 1, 2, 2, 2, 0);
    expect(device.queue.writeTexture).toHaveBeenCalledTimes(1);
  });

  it('does not let a coarser LOD overwrite a finer resident cell', () => {
    table.setBrick(0, 0, 0, 9, 9, 9, 0);        // finer LOD 0 at cell (0,0,0)
    table.setBrick(0, 0, 0, 4, 4, 4, 1);        // coarser LOD 1 covering (0..1)³
    // Finer cell survives; the rest of the block takes the coarse brick.
    expect(cell(table, 0, 0, 0)).toEqual({ ax: 9, ay: 9, az: 9, w: 1 });
    expect(cell(table, 1, 1, 1)).toEqual({ ax: 4, ay: 4, az: 4, w: 2 });
  });

  it('does not overwrite a cell already at the same LOD', () => {
    table.setBrick(0, 0, 0, 1, 1, 1, 1);
    table.setBrick(0, 0, 0, 5, 5, 5, 1);        // same LOD, different slot → ignored
    expect(cell(table, 0, 0, 0)).toEqual({ ax: 1, ay: 1, az: 1, w: 2 });
  });
});

describe('IndirectionTable — setEmpty', () => {
  it('marks an unloaded region with the empty sentinel (w = 255)', () => {
    table.setEmpty(0, 0, 0, 0);
    expect(cell(table, 0, 0, 0).w).toBe(255);
  });

  it('never clobbers loaded data with the empty marker', () => {
    table.setBrick(0, 0, 0, 3, 3, 3, 0);
    table.setEmpty(0, 0, 0, 0);
    expect(cell(table, 0, 0, 0)).toEqual({ ax: 3, ay: 3, az: 3, w: 1 }); // unchanged
  });

  it('an empty cell can later be replaced by a real brick', () => {
    table.setEmpty(0, 0, 0, 0);
    table.setBrick(0, 0, 0, 2, 2, 2, 0);
    expect(cell(table, 0, 0, 0)).toEqual({ ax: 2, ay: 2, az: 2, w: 1 });
  });
});

describe('IndirectionTable — clearBrick', () => {
  it('reverts a cleared cell to unloaded', () => {
    table.setBrick(3, 3, 3, 1, 2, 3, 0);
    table.clearBrick(3, 3, 3, 0);
    expect(cell(table, 3, 3, 3)).toEqual({ ax: 0, ay: 0, az: 0, w: 0 });
  });

  it('only clears cells still at the given LOD (leaves finer data intact)', () => {
    table.setBrick(0, 0, 0, 7, 7, 7, 0);   // cell holds LOD 0 (w=1)
    table.clearBrick(0, 0, 0, 1);          // try to clear LOD 1 → no match, skipped
    expect(cell(table, 0, 0, 0).w).toBe(1);
  });

  it('restores a parent brick when a fallback is supplied', () => {
    table.setBrick(0, 0, 0, 9, 9, 9, 0);
    table.clearBrick(0, 0, 0, 0, [1, 2, 3], 2); // fall back to LOD-2 parent slot
    expect(cell(table, 0, 0, 0)).toEqual({ ax: 1, ay: 2, az: 3, w: 3 });
  });
});
