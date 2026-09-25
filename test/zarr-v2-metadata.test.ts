/**
 * v2ToV3ArrayMetadata must agree with zarrita's own v2 open on everything
 * the workers rely on (shape, chunks, dtype, codecs, chunk keys).
 */
import { describe, it, expect } from 'vitest';
import { open, Array as ZarrArray } from 'zarrita';
import type { AbsolutePath, Readable } from 'zarrita';
import { v2ToV3ArrayMetadata, compressionLabel } from '../src/data/zarr-v2-metadata.js';
import type { ZarrV2ArrayJson } from '../src/data/zarr-v2-metadata.js';

class MemStore implements Readable {
  constructor(private files: Record<string, unknown>) {}
  async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
    const v = this.files[key];
    return v === undefined ? undefined : new TextEncoder().encode(JSON.stringify(v));
  }
}

const zarray: ZarrV2ArrayJson = {
  shape: [1, 4, 103, 512, 512],
  chunks: [1, 1, 1, 512, 512],
  dtype: '>u2',
  compressor: { id: 'blosc', cname: 'lz4', clevel: 5, shuffle: 1, blocksize: 0 },
  filters: null,
  fill_value: 0,
  order: 'C',
  dimension_separator: '/',
};

describe('v2ToV3ArrayMetadata', () => {
  it('matches zarrita open.v2 for a big-endian blosc array', async () => {
    const store = new MemStore({ '/0/.zarray': zarray, '/0/.zattrs': {} });
    const viaZarrita = await open.v2(store, { kind: 'array' }).catch(() => null);
    // open.v2 on a store (no Location) opens "/", so resolve the array explicitly
    const ref = viaZarrita ?? await open.v2({ store, path: '/0', resolve: (p: string) => ({ store, path: `/0/${p}` }) } as never, { kind: 'array' });
    const ours = new ZarrArray(store, '/0', v2ToV3ArrayMetadata(zarray));
    expect(ours.shape).toEqual(ref.shape);
    expect(ours.chunks).toEqual(ref.chunks);
    expect(ours.dtype).toEqual(ref.dtype);
    // Same chunk key for the same coords (v2 encoding with "/" separator)
    const key = (a: ZarrArray<'uint16', Readable>, c: number[]) =>
      (a as unknown as { resolve: (k: string) => { path: string } }).resolve(c.join('/')).path;
    expect(key(ours as never, [0, 1, 2, 3, 4])).toBe(key(ref as never, [0, 1, 2, 3, 4]));
  });

  it('emits codecs in zarrita order: transpose, bytes(big), filters, compressor', () => {
    const m = v2ToV3ArrayMetadata({ ...zarray, order: 'F', filters: [{ id: 'delta', dtype: '<u2' }] });
    expect(m.codecs.map(c => c.name)).toEqual(['transpose', 'bytes', 'delta', 'blosc']);
    expect(m.chunk_key_encoding).toEqual({ name: 'v2', configuration: { separator: '/' } });
    expect(m.data_type).toBe('uint16');
    const le = v2ToV3ArrayMetadata({ ...zarray, dtype: '<f4', compressor: null });
    expect(le.codecs).toEqual([]);
    expect(le.data_type).toBe('float32');
  });

  it('labels compression like detectCompression does', () => {
    expect(compressionLabel(zarray.compressor)).toBe('blosc/lz4');
    expect(compressionLabel({ id: 'zstd', level: 3 })).toBe('zstd');
    expect(compressionLabel(null)).toBeUndefined();
  });

  it('rejects unknown dtypes', () => {
    expect(() => v2ToV3ArrayMetadata({ ...zarray, dtype: '<x9' })).toThrow(/dtype/);
  });
});
