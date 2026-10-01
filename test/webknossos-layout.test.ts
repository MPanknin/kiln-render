/**
 * webKnossos publishes OME-Zarr layers as c, x, y, z with a transpose codec, under
 * URLs without ".zarr". Metadata from the public Neuromast_WT1 layer on data-humerus.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { open, root } from 'zarrita';
import { LocalZarrDataProvider } from '../src/data/local-zarr-provider.js';
import { isShardedUrl } from '../src/data/sharded-provider.js';

const axes = [
  { name: 'c', type: 'channel' },
  { name: 'x', type: 'space', unit: 'nanometer' },
  { name: 'y', type: 'space', unit: 'nanometer' },
  { name: 'z', type: 'space', unit: 'nanometer' },
];
const attrs = (mags: number[]) => ({
  ome: {
    version: '0.5',
    multiscales: [{
      name: 'color', axes,
      datasets: mags.map(m => ({
        path: String(m), coordinateTransformations: [{ type: 'scale', scale: [1, 6 * m, 6 * m, 30 * m] }],
      })),
    }],
  },
});

describe('webKnossos layout: metadata', () => {
  const p: any = new LocalZarrDataProvider({ name: 'wk' } as any);
  const level = (m: number) => ({ shape: [1, 9216 / m, 9216 / m, 1024 / m], chunks: [1, 32, 32, 32], dtype: 'uint8' });
  const { metadata, lodParams } = p.parseOmeMetadata(attrs([1, 2, 4]), [level(1), level(2), level(4)], 'wk');

  it('reads dimensions, spacing and chunks as x, y, z', () => {
    expect(metadata.dimensions).toEqual([9216, 9216, 1024]);
    expect(metadata.voxelSpacing).toEqual([6, 6, 30]);
    expect(lodParams[0]).toMatchObject({ csx: 32, csy: 32, csz: 32, actualDimZ: 1024, spatialOrder: [0, 1, 2] });
  });

  it('builds the native pyramid', () => {
    expect(metadata.pyramidIssues).toEqual([]);
    expect(metadata.levels[2].dimensions).toEqual([2304, 2304, 256]);
  });
});

describe('webKnossos layout: voxels', () => {
  it('every voxel lands at its x, y, z position through real decoding', async () => {
    const X = 4, Y = 3, Z = 2;
    const value = (x: number, y: number, z: number) => z * 100 + y * 10 + x;
    const store = new Map<string, Uint8Array>();
    store.set('/zarr.json', new TextEncoder().encode(JSON.stringify({
      zarr_format: 3, node_type: 'array', shape: [1, X, Y, Z], data_type: 'uint8',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, X, Y, Z] } },
      chunk_key_encoding: { name: 'v2', configuration: { separator: '.' } },
      fill_value: 0, attributes: {}, dimension_names: ['c', 'x', 'y', 'z'],
      codecs: [{ name: 'transpose', configuration: { order: [3, 2, 1, 0] } }, { name: 'bytes', configuration: { endian: 'little' } }],
    })));
    const data = new Uint8Array(X * Y * Z); // transposed to z, y, x, c: x varies fastest
    for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) data[(z * Y + y) * X + x] = value(x, y, z);
    store.set('/0.0.0.0', data);

    const arr = await open(root(store), { kind: 'array' });
    const p: any = new LocalZarrDataProvider({ name: 'wk' } as any);
    const { metadata, lodParams } = p.parseOmeMetadata(attrs([1]), [arr], 'wk');
    Object.assign(p, { metadata, lodParams, arrays: [arr] });

    const brick = (await p.loadBrick(0, 0, 0, 0)).data as Uint8Array;
    const core = (x: number, y: number, z: number) => brick[(z + 1) * 66 * 66 + (y + 1) * 66 + (x + 1)];
    for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
      expect(core(x, y, z)).toBe(value(x, y, z));
    }
  });
});

describe('isShardedUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('takes a .zarr URL as Zarr without a request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await isShardedUrl('https://example.org/scan.ome.zarr')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('takes a URL that serves volume.json as sharded', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    expect(await isShardedUrl('https://example.org/chameleon/')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith('https://example.org/chameleon/volume.json');
  });

  it('takes any other URL as Zarr, such as a webKnossos layer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await isShardedUrl('https://data-humerus.webknossos.org/data/zarr3_experimental/abc/color')).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await isShardedUrl('https://data-humerus.webknossos.org/data/zarr3_experimental/abc/color')).toBe(false);
  });
});
