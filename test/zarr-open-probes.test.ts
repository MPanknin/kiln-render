/**
 * Opening a dataset probes its own Zarr format only, so a v3 dataset doesn't fill the console
 * with 404s for v2 documents (and the reverse), and workers get the metadata instead of probing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ZarrDataProvider } from '../src/data/zarr-provider.js';
import { TolerantFetchStore } from '../src/data/tolerant-fetch-store.js';
import { jsonReader, listLabelNames } from '../src/data/label-image.js';

const BASE = 'https://example.org/data.zarr';
const multiscales = [{ axes: ['z', 'y', 'x'].map(name => ({ name, type: 'space' })), datasets: [{ path: '0' }, { path: '1' }] }];
const v3Array = (shape: number[]) => ({
  zarr_format: 3, node_type: 'array', shape, data_type: 'uint8', fill_value: 0,
  chunk_grid: { name: 'regular', configuration: { chunk_shape: [64, 64, 64] } },
  chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
  codecs: [{ name: 'bytes' }, { name: 'zstd', configuration: { level: 3 } }],
});
const v2Array = (shape: number[]) => ({
  zarr_format: 2, shape, chunks: [64, 64, 64], dtype: '|u1', compressor: { id: 'zstd', level: 3 },
  filters: null, fill_value: 0, order: 'C', dimension_separator: '/',
});

/** Serves `files` (relative to BASE) and records every requested path. */
function serve(files: Record<string, unknown>): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url).slice(BASE.length);
    requested.push(path);
    const body = files[path];
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  return requested;
}

const openFast = (p: ZarrDataProvider) =>
  (p as unknown as { openFast(s: TolerantFetchStore): Promise<{ format: number; compression?: string; arrayMetadata: unknown[] } | null> })
    .openFast(new TolerantFetchStore(BASE));

afterEach(() => vi.unstubAllGlobals());

describe('fast open', () => {
  it('opens v3 from zarr.json documents only, apart from the root .zattrs', async () => {
    const requested = serve({
      '/zarr.json': { zarr_format: 3, node_type: 'group', attributes: { ome: { version: '0.5', multiscales } } },
      '/0/zarr.json': v3Array([128, 128, 128]),
      '/1/zarr.json': v3Array([64, 64, 64]),
    });
    const fast = await openFast(new ZarrDataProvider(BASE));
    expect(fast).toMatchObject({ format: 3, compression: 'zstd' });
    expect(fast!.arrayMetadata).toHaveLength(2);
    expect(requested.sort()).toEqual(['/.zattrs', '/0/zarr.json', '/1/zarr.json', '/zarr.json']);
  });

  it('opens v2 from .zattrs and .zarray documents, apart from the root zarr.json', async () => {
    const requested = serve({
      '/.zattrs': { multiscales: [{ ...multiscales[0], version: '0.4' }] },
      '/0/.zarray': v2Array([128, 128, 128]),
      '/1/.zarray': v2Array([64, 64, 64]),
    });
    const fast = await openFast(new ZarrDataProvider(BASE));
    expect(fast).toMatchObject({ format: 2, compression: 'zstd' });
    expect(requested.sort()).toEqual(['/.zattrs', '/0/.zarray', '/1/.zarray', '/zarr.json']);
  });

  it('finds the multiscales in a v3 bioformats2raw "0" sub-group', async () => {
    serve({
      '/zarr.json': { zarr_format: 3, node_type: 'group', attributes: { ome: { version: '0.5', bioformats2raw: { layout: 3 } } } },
      '/0/zarr.json': { zarr_format: 3, node_type: 'group', attributes: { ome: { version: '0.5', multiscales } } },
      '/0/0/zarr.json': v3Array([128, 128, 128]),
      '/0/1/zarr.json': v3Array([64, 64, 64]),
    });
    expect(await openFast(new ZarrDataProvider(BASE))).toMatchObject({ format: 3, subGroupPath: '0/' });
  });

  it('leaves datasets it cannot open fast to the zarrita path', async () => {
    serve({ '/zarr.json': { zarr_format: 3, node_type: 'group', attributes: {} } });
    expect(await openFast(new ZarrDataProvider(BASE))).toBeNull();
  });
});

describe('listLabelNames', () => {
  it('reads only the known format', async () => {
    const requested = serve({ '/labels/zarr.json': { zarr_format: 3, node_type: 'group', attributes: { ome: { labels: ['cells'] } } } });
    expect(await listLabelNames(jsonReader(new TolerantFetchStore(BASE)), '', 3)).toEqual(['cells']);
    expect(requested).toEqual(['/labels/zarr.json']);
  });
});
