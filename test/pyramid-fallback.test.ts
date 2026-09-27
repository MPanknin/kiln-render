import { describe, it, expect, vi, afterEach } from 'vitest';
import { initializeWithPyramidFallback, isNativePyramidRejection } from '../src/data/pyramid-fallback.js';
import { BaseZarrProvider, LEGACY_HINT } from '../src/data/base-zarr-provider.js';
import { LocalZarrDataProvider } from '../src/data/local-zarr-provider.js';
import { UnsupportedDatasetError } from '../src/data/data-provider.js';
import type { DataProvider, VolumeMetadata } from '../src/data/data-provider.js';
import type { PyramidPolicy } from '../src/core/pyramid.js';

const PYRAMID_REJECTION = () => new UnsupportedDatasetError(['level 1 z: 1012 voxels do not match factor 2 of 2048', LEGACY_HINT]);

/** Zarr-provider stand-in: records the policy of every initialize() and fails native on demand. */
class FakeZarrProvider extends BaseZarrProvider {
  calls: PyramidPolicy[] = [];
  constructor(private readonly fail: (policy: PyramidPolicy) => Error | null) { super(); }
  async initialize(): Promise<VolumeMetadata> {
    this.calls.push(this.pyramidPolicy);
    const err = this.fail(this.pyramidPolicy);
    if (err) throw err;
    return { pyramidPolicy: this.pyramidPolicy } as VolumeMetadata;
  }
  async loadBrick() { return null; }
  dispose() {}
}

describe('initializeWithPyramidFallback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens with native when native is accepted', async () => {
    const p = new FakeZarrProvider(() => null);
    const r = await initializeWithPyramidFallback(p);
    expect(r.pyramid).toBe('native');
    expect(p.calls).toEqual(['native']);
  });

  it('retries once with legacy when native rejects only the level geometry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new FakeZarrProvider(policy => (policy === 'native' ? PYRAMID_REJECTION() : null));
    const r = await initializeWithPyramidFallback(p);
    expect(r.pyramid).toBe('legacy');
    expect(r.metadata.pyramidPolicy).toBe('legacy');
    expect(p.calls).toEqual(['native', 'legacy']);
    expect(warn.mock.calls[0]![0]).toContain('1012 voxels do not match factor 2 of 2048');
    expect(warn.mock.calls[0]![0]).not.toContain(LEGACY_HINT);
  });

  it('never overrides an explicitly requested native model', async () => {
    const p = new FakeZarrProvider(policy => (policy === 'native' ? PYRAMID_REJECTION() : null));
    await expect(initializeWithPyramidFallback(p, 'native')).rejects.toBeInstanceOf(UnsupportedDatasetError);
    expect(p.calls).toEqual(['native']);
  });

  it('does not retry rejections unrelated to the pyramid', async () => {
    const p = new FakeZarrProvider(() => new UnsupportedDatasetError(['Data type "int64" is not supported']));
    await expect(initializeWithPyramidFallback(p)).rejects.toThrow('int64');
    expect(p.calls).toEqual(['native']);
  });

  it('does not retry providers other than the Zarr providers', async () => {
    const init = vi.fn(async () => { throw PYRAMID_REJECTION(); });
    const custom = { setPyramidPolicy: vi.fn(), initialize: init } as unknown as DataProvider;
    await expect(initializeWithPyramidFallback(custom)).rejects.toBeInstanceOf(UnsupportedDatasetError);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('surfaces the legacy error when legacy fails too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new FakeZarrProvider(policy => (policy === 'native' ? PYRAMID_REJECTION() : new Error('legacy failed')));
    await expect(initializeWithPyramidFallback(p)).rejects.toThrow('legacy failed');
    expect(p.calls).toEqual(['native', 'legacy']);
  });

  it('recognises the native-pyramid rejection by its hint', () => {
    expect(isNativePyramidRejection(PYRAMID_REJECTION())).toBe(true);
    expect(isNativePyramidRejection(new UnsupportedDatasetError(['other']))).toBe(false);
    expect(isNativePyramidRejection(new Error(LEGACY_HINT))).toBe(false);
  });
});

/** Minimal in-memory FileSystemDirectoryHandle: enough for FileSystemStore reads. */
function memoryDir(name: string, files: Record<string, string>): FileSystemDirectoryHandle {
  const dir = (prefix: string, dirName: string): FileSystemDirectoryHandle => ({
    name: dirName,
    kind: 'directory',
    async getDirectoryHandle(child: string) {
      const p = `${prefix}${child}/`;
      if (!Object.keys(files).some(k => k.startsWith(p))) throw new DOMException('missing', 'NotFoundError');
      return dir(p, child);
    },
    async getFileHandle(child: string) {
      const content = files[`${prefix}${child}`];
      if (content === undefined) throw new DOMException('missing', 'NotFoundError');
      return { kind: 'file', name: child, getFile: async () => new Blob([content]) } as unknown as FileSystemFileHandle;
    },
  }) as unknown as FileSystemDirectoryHandle;
  return dir('', name);
}

describe('fallback with a real LocalZarrDataProvider', () => {
  it('opens a Woodbranch-shaped pyramid (level 1 short in z) with legacy, retrying the same instance', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const zarray = (shape: number[]) => JSON.stringify({
      zarr_format: 2, shape, chunks: shape, dtype: '<u2', compressor: null,
      fill_value: 0, filters: null, order: 'C', dimension_separator: '/',
    });
    const handle = memoryDir('short.zarr', {
      '.zgroup': JSON.stringify({ zarr_format: 2 }),
      '.zattrs': JSON.stringify({ multiscales: [{
        version: '0.4',
        axes: [{ name: 'z', type: 'space' }, { name: 'y', type: 'space' }, { name: 'x', type: 'space' }],
        datasets: [
          { path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] },
          { path: '1', coordinateTransformations: [{ type: 'scale', scale: [2, 2, 2] }] },
        ],
      }] }),
      '0/.zarray': zarray([128, 64, 64]),
      '1/.zarray': zarray([60, 32, 32]), // z should be 64: like Woodbranch's 1012 instead of 1024
    });

    const provider = new LocalZarrDataProvider(handle);
    await expect(initializeWithPyramidFallback(provider, 'native')).rejects.toSatisfy(isNativePyramidRejection);

    const fresh = new LocalZarrDataProvider(handle);
    const { metadata, pyramid } = await initializeWithPyramidFallback(fresh);
    expect(pyramid).toBe('legacy');
    expect(metadata.pyramidPolicy).toBe('legacy');
    expect(metadata.dimensions).toEqual([64, 64, 128]);
    expect(metadata.levels.map(l => l.dimensions)).toEqual([[64, 64, 128], [32, 32, 64]]);
  });
});
