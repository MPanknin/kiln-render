import { describe, it, expect } from 'vitest';
import { BaseZarrProvider } from '../src/data/base-zarr-provider.js';
import { UnsupportedDatasetError } from '../src/data/data-provider.js';
import type { VolumeMetadata, BrickData } from '../src/data/data-provider.js';

// ---------------------------------------------------------------------------
// Minimal concrete subclass so we can call the protected method under test
// ---------------------------------------------------------------------------

class TestProvider extends BaseZarrProvider {
  async initialize(): Promise<VolumeMetadata> { throw new Error('not used'); }
  async loadBrick(): Promise<BrickData | null> { return null; }
  dispose(): void {}

  // Expose protected method for tests
  parse(attrs: Record<string, unknown>, arrays: MockArray[], name = 'test') {
    return this.parseOmeMetadata(attrs, arrays as any, name);
  }
}

// ---------------------------------------------------------------------------
// Mock ZarrArray — only shape, chunks, dtype are read by parseOmeMetadata
// ---------------------------------------------------------------------------

interface MockArray {
  shape: number[];
  chunks: number[];
  dtype: string;
}

function arr(shape: number[], chunks: number[], dtype = 'uint16'): MockArray {
  return { shape, chunks, dtype };
}

// ---------------------------------------------------------------------------
// Minimal valid attrs fixtures
// ---------------------------------------------------------------------------

function v5Attrs(
  datasets: { path: string; coordinateTransformations?: unknown[] }[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ome: {
      multiscales: [{ datasets, axes: ['z', 'y', 'x'], ...extra }],
    },
  };
}

function v4Attrs(
  datasets: { path: string; coordinateTransformations?: unknown[] }[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    multiscales: [{ datasets, axes: ['z', 'y', 'x'], version: '0.4', ...extra }],
  };
}

// ---------------------------------------------------------------------------
// Dimensions & axis ordering
// ---------------------------------------------------------------------------

describe('parseOmeMetadata — dimensions', () => {
  const provider = new TestProvider();

  it('reads shape as [z, y, x] and exposes metadata as [x, y, z]', () => {
    // shape [64, 128, 256] means z=64, y=128, x=256
    const { metadata } = provider.parse(
      v5Attrs([{ path: '0' }]),
      [arr([64, 128, 256], [64, 64, 64])],
    );
    expect(metadata.dimensions).toEqual([256, 128, 64]); // [x, y, z]
  });

  it('sets name from the provided argument', () => {
    const { metadata } = provider.parse(
      v5Attrs([{ path: '0' }]),
      [arr([64, 64, 64], [64, 64, 64])],
      'my-volume',
    );
    expect(metadata.name).toBe('my-volume');
  });

  it('sets maxLod equal to number of scales minus 1', () => {
    const { metadata } = provider.parse(
      v5Attrs([{ path: '0' }, { path: '1' }, { path: '2' }]),
      [
        arr([256, 256, 256], [64, 64, 64]),
        arr([128, 128, 128], [64, 64, 64]),
        arr([64,  64,  64],  [64, 64, 64]),
      ],
    );
    expect(metadata.maxLod).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bit depth
// ---------------------------------------------------------------------------

describe('parseOmeMetadata — bit depth', () => {
  const provider = new TestProvider();
  const attrs = v5Attrs([{ path: '0' }]);
  const shape = [64, 64, 64];
  const chunks = [64, 64, 64];

  it('detects uint8 as 8-bit', () => {
    const { metadata } = provider.parse(attrs, [arr(shape, chunks, 'uint8')]);
    expect(metadata.bitDepth).toBe(8);
  });

  it('detects uint16 as 16-bit', () => {
    const { metadata } = provider.parse(attrs, [arr(shape, chunks, 'uint16')]);
    expect(metadata.bitDepth).toBe(16);
  });

  // int8/int16 are rejected by validateZarrSupport before bit depth detection is used.
  // The bit depth detection code handles them, but validation fires first — dead code.
  it('rejects int8 (not yet allowed through validation)', () => {
    expect(() => provider.parse(attrs, [arr(shape, chunks, 'int8')])).toThrow(UnsupportedDatasetError);
  });

  it('rejects int16 (not yet allowed through validation)', () => {
    expect(() => provider.parse(attrs, [arr(shape, chunks, 'int16')])).toThrow(UnsupportedDatasetError);
  });

  it('throws UnsupportedDatasetError for float32', () => {
    expect(() => provider.parse(attrs, [arr(shape, chunks, 'float32')])).toThrow(UnsupportedDatasetError);
  });
});

// ---------------------------------------------------------------------------
// LOD levels — virtual dimensions & brick grid
// ---------------------------------------------------------------------------


describe('parseOmeMetadata — LOD levels', () => {
  const provider = new TestProvider();

  it('computes virtual dimensions as strict 2:1 halving of lod0 regardless of actual array shape', () => {
    // lod0: 256, lod1: actual=120 but virtual should be ceil(256/2)=128
    const { metadata } = provider.parse(
      v5Attrs([{ path: '0' }, { path: '1' }]),
      [
        arr([256, 256, 256], [64, 64, 64]),
        arr([120, 120, 120], [64, 64, 64]), // actual may differ from exact half
      ],
    );
    expect(metadata.levels[0]!.dimensions).toEqual([256, 256, 256]);
    expect(metadata.levels[1]!.dimensions).toEqual([128, 128, 128]); // ceil(256/2)
  });

  it('handles non-power-of-two dimensions with ceil', () => {
    // z=100: virtual lod1 = ceil(100/2) = 50, lod2 = ceil(100/4) = 25
    const { metadata } = provider.parse(
      v5Attrs([{ path: '0' }, { path: '1' }, { path: '2' }]),
      [
        arr([100, 100, 100], [64, 64, 64]),
        arr([50,  50,  50],  [50, 50, 50]),
        arr([25,  25,  25],  [25, 25, 25]),
      ],
    );
    expect(metadata.levels[1]!.dimensions).toEqual([50, 50, 50]);
    expect(metadata.levels[2]!.dimensions).toEqual([25, 25, 25]);
  });

  it('computes brick grid as ceil(virtualDim / 64)', () => {
    // virtualDim = 128 → grid = ceil(128/64) = 2
    // virtualDim = 65  → grid = ceil(65/64)  = 2
    const { metadata } = provider.parse(
      v5Attrs([{ path: '0' }, { path: '1' }]),
      [
        arr([65, 128, 256], [64, 64, 64]),  // lod0: x=256→4, y=128→2, z=65→2
        arr([32, 64,  128], [64, 64, 64]),
      ],
    );
    // lod0: x=256, y=128, z=65 → grid=[4,2,2]
    expect(metadata.levels[0]!.brickGrid).toEqual([4, 2, 2]);
  });

  it('sets brickCount = product of brickGrid', () => {
    const { metadata } = provider.parse(
      v5Attrs([{ path: '0' }]),
      [arr([128, 128, 128], [64, 64, 64])],
    );
    const [gx, gy, gz] = metadata.levels[0]!.brickGrid;
    expect(metadata.levels[0]!.brickCount).toBe(gx * gy * gz);
  });
});

// ---------------------------------------------------------------------------
// LOD params
// ---------------------------------------------------------------------------

describe('parseOmeMetadata — lodParams', () => {
  const provider = new TestProvider();

  it('computes scale factors as actual/virtual', () => {
    // lod0: actual=256, virtual=256 → scale=1.0
    // lod1: actual=120, virtual=128 → scale=120/128
    const { lodParams } = provider.parse(
      v5Attrs([{ path: '0' }, { path: '1' }]),
      [
        arr([256, 256, 256], [64, 64, 64]),
        arr([120, 120, 120], [64, 64, 64]),
      ],
    );
    expect(lodParams[0]!.scaleX).toBeCloseTo(1.0);
    expect(lodParams[1]!.scaleX).toBeCloseTo(120 / 128);
  });

  it('extracts chunk sizes from the last three shape dims', () => {
    const { lodParams } = provider.parse(
      v5Attrs([{ path: '0' }]),
      [arr([128, 128, 128], [32, 48, 64])],
    );
    // chunks [csz=32, csy=48, csx=64]
    expect(lodParams[0]!.csx).toBe(64);
    expect(lodParams[0]!.csy).toBe(48);
    expect(lodParams[0]!.csz).toBe(32);
  });

  it('shapePrefixLength is 0 for a plain [z, y, x] array', () => {
    const { lodParams } = provider.parse(
      v5Attrs([{ path: '0' }]),
      [arr([128, 128, 128], [64, 64, 64])],
    );
    expect(lodParams[0]!.shapePrefixLength).toBe(0);
  });

  it('shapePrefixLength is 1 for a [c, z, y, x] array', () => {
    const attrs = {
      ome: { multiscales: [{ datasets: [{ path: '0' }], axes: ['c', 'z', 'y', 'x'] }] },
    };
    const { lodParams } = provider.parse(attrs, [arr([2, 128, 128, 128], [1, 64, 64, 64])]);
    expect(lodParams[0]!.shapePrefixLength).toBe(1);
  });

  it('shapePrefixLength is 2 for a [t, c, z, y, x] array', () => {
    const attrs = {
      ome: { multiscales: [{ datasets: [{ path: '0' }], axes: ['t', 'c', 'z', 'y', 'x'] }] },
    };
    const { lodParams } = provider.parse(attrs, [arr([1, 2, 128, 128, 128], [1, 1, 64, 64, 64])]);
    expect(lodParams[0]!.shapePrefixLength).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Voxel spacing
// ---------------------------------------------------------------------------

describe('parseOmeMetadata — voxel spacing', () => {
  const provider = new TestProvider();
  const simpleArr = [arr([64, 64, 64], [64, 64, 64])];

  it('returns undefined voxelSpacing when no coordinateTransformations present', () => {
    const { metadata } = provider.parse(v5Attrs([{ path: '0' }]), simpleArr);
    expect(metadata.voxelSpacing).toBeUndefined();
  });

  it('reads per-dataset coordinateTransformations (v0.5 style)', () => {
    const attrs = v5Attrs([{
      path: '0',
      coordinateTransformations: [{ type: 'scale', scale: [0.5, 0.3, 0.2] }],
    }]);
    const { metadata } = provider.parse(attrs, simpleArr);
    // stored [z,y,x] = [0.5, 0.3, 0.2], exposed as [x, y, z] = [0.2, 0.3, 0.5]
    expect(metadata.voxelSpacing).toEqual([0.2, 0.3, 0.5]);
  });

  it('falls back to group-level coordinateTransformations (v0.4 style)', () => {
    const attrs = {
      multiscales: [{
        datasets: [{ path: '0' }],
        axes: ['z', 'y', 'x'],
        version: '0.4',
        coordinateTransformations: [{ type: 'scale', scale: [1.0, 0.5, 0.25] }],
      }],
    };
    const { metadata } = provider.parse(attrs, simpleArr);
    expect(metadata.voxelSpacing).toEqual([0.25, 0.5, 1.0]);
  });

  it('ignores non-scale transforms and reads only the scale entry', () => {
    const attrs = v5Attrs([{
      path: '0',
      coordinateTransformations: [
        { type: 'translation', translation: [0, 0, 0] },
        { type: 'scale', scale: [2.0, 1.0, 0.5] },
      ],
    }]);
    const { metadata } = provider.parse(attrs, simpleArr);
    expect(metadata.voxelSpacing).toEqual([0.5, 1.0, 2.0]);
  });

  it('handles 5-D scale array by reading the last three values', () => {
    const attrs = v5Attrs([{
      path: '0',
      coordinateTransformations: [{ type: 'scale', scale: [1, 1, 4.0, 2.0, 1.0] }],
    }]);
    const { metadata } = provider.parse(attrs, simpleArr);
    expect(metadata.voxelSpacing).toEqual([1.0, 2.0, 4.0]);
  });
});

// ---------------------------------------------------------------------------
// Multi-channel support
// ---------------------------------------------------------------------------

describe('parseOmeMetadata — multi-channel', () => {
  const provider = new TestProvider();

  it('reports numChannels: 1 and channelAxisIdx: -1 for plain [z, y, x] axes', () => {
    const { metadata, lodParams } = provider.parse(
      v5Attrs([{ path: '0' }]),
      [arr([64, 64, 64], [64, 64, 64])],
    );
    expect(metadata.numChannels).toBe(1);
    expect(lodParams[0]!.channelAxisIdx).toBe(-1);
  });

  it('extracts numChannels from the c-axis for [c, z, y, x] datasets', () => {
    const attrs = {
      ome: { multiscales: [{ datasets: [{ path: '0' }], axes: ['c', 'z', 'y', 'x'] }] },
    };
    const { metadata } = provider.parse(attrs, [arr([3, 64, 64, 64], [1, 64, 64, 64])]);
    expect(metadata.numChannels).toBe(3);
  });

  it('reports channelAxisIdx: 0 for [c, z, y, x] in lodParams', () => {
    const attrs = {
      ome: { multiscales: [{ datasets: [{ path: '0' }], axes: ['c', 'z', 'y', 'x'] }] },
    };
    const { lodParams } = provider.parse(attrs, [arr([3, 64, 64, 64], [1, 64, 64, 64])]);
    expect(lodParams[0]!.channelAxisIdx).toBe(0);
  });

  it('extracts numChannels from the c-axis for [t, c, z, y, x] datasets', () => {
    const attrs = {
      ome: { multiscales: [{ datasets: [{ path: '0' }], axes: ['t', 'c', 'z', 'y', 'x'] }] },
    };
    const { metadata } = provider.parse(attrs, [arr([1, 4, 64, 64, 64], [1, 1, 64, 64, 64])]);
    expect(metadata.numChannels).toBe(4);
  });

  it('reports channelAxisIdx: 1 for [t, c, z, y, x] in lodParams', () => {
    const attrs = {
      ome: { multiscales: [{ datasets: [{ path: '0' }], axes: ['t', 'c', 'z', 'y', 'x'] }] },
    };
    const { lodParams } = provider.parse(attrs, [arr([1, 4, 64, 64, 64], [1, 1, 64, 64, 64])]);
    expect(lodParams[0]!.channelAxisIdx).toBe(1);
  });

  it('clamps numChannels to 1 when channel axis has size 0', () => {
    const attrs = {
      ome: { multiscales: [{ datasets: [{ path: '0' }], axes: ['c', 'z', 'y', 'x'] }] },
    };
    // shape[0] = 0 channels — should clamp to 1
    const { metadata } = provider.parse(attrs, [arr([0, 64, 64, 64], [1, 64, 64, 64])]);
    expect(metadata.numChannels).toBe(1);
  });

  it('propagates the same channelAxisIdx to all LOD levels', () => {
    const attrs = {
      ome: { multiscales: [{ datasets: [{ path: '0' }, { path: '1' }, { path: '2' }], axes: ['c', 'z', 'y', 'x'] }] },
    };
    const { lodParams } = provider.parse(attrs, [
      arr([2, 128, 128, 128], [1, 64, 64, 64]),
      arr([2,  64,  64,  64], [1, 64, 64, 64]),
      arr([2,  32,  32,  32], [1, 32, 32, 32]),
    ]);
    expect(lodParams).toHaveLength(3);
    for (const lp of lodParams) {
      expect(lp.channelAxisIdx).toBe(0);
    }
  });

  it('uses v0.5 typed object axes to detect channel axis', () => {
    const attrs = {
      ome: {
        multiscales: [{
          datasets: [{ path: '0' }],
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'z', type: 'space' },
            { name: 'y', type: 'space' },
            { name: 'x', type: 'space' },
          ],
        }],
      },
    };
    const { metadata, lodParams } = provider.parse(attrs, [arr([2, 64, 64, 64], [1, 64, 64, 64])]);
    expect(metadata.numChannels).toBe(2);
    expect(lodParams[0]!.channelAxisIdx).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// OMERO window metadata
// ---------------------------------------------------------------------------

describe('parseOmeMetadata — OMERO window', () => {
  const provider = new TestProvider();
  const simpleArr = [arr([64, 64, 64], [64, 64, 64])];

  it('returns undefined window when no OMERO metadata present', () => {
    const { metadata } = provider.parse(v5Attrs([{ path: '0' }]), simpleArr);
    expect(metadata.window).toBeUndefined();
  });

  it('extracts window from ome.omero.channels[0].window', () => {
    const window = { start: 100, end: 4000, min: 0, max: 65535 };
    const attrs = {
      ome: {
        multiscales: [{ datasets: [{ path: '0' }], axes: ['z', 'y', 'x'] }],
        omero: { channels: [{ window }] },
      },
    };
    const { metadata } = provider.parse(attrs, simpleArr);
    expect(metadata.window).toEqual(window);
  });

  it('ignores OMERO metadata when channels array is empty', () => {
    const attrs = {
      ome: {
        multiscales: [{ datasets: [{ path: '0' }], axes: ['z', 'y', 'x'] }],
        omero: { channels: [] },
      },
    };
    const { metadata } = provider.parse(attrs, simpleArr);
    expect(metadata.window).toBeUndefined();
  });
});
