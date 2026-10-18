import { afterEach, describe, expect, it, vi } from 'vitest';
import * as zarr from 'zarrita';
import { TolerantFetchStore } from '../src/data/tolerant-fetch-store.js';
import { summarizeBorderBytes } from '../src/data/chunk-math.js';

afterEach(() => vi.unstubAllGlobals());

// A real Zarr v3 shard: two one-byte chunks followed by a 32-byte index and CRC32C.
function shardFixture(): Uint8Array {
  const shard = new Uint8Array(38);
  shard.set([10, 20]);
  const view = new DataView(shard.buffer);
  [0n, 1n, 1n, 1n].forEach((v, i) => view.setBigUint64(2 + i * 8, v, true));
  let crc = 0xffffffff;
  for (const byte of shard.subarray(2, 34)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  view.setUint32(34, (crc ^ 0xffffffff) >>> 0, true);
  return shard;
}

describe('border-byte attribution through Zarrita', () => {
  it.each([true, false])('excludes the shared index regardless of whether border loads first (%s)', async (borderFirst) => {
    const shard = shardFixture();
    const metadata = {
      zarr_format: 3, node_type: 'array', shape: [2], data_type: 'uint8', fill_value: 0,
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [2] } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      codecs: [{ name: 'sharding_indexed', configuration: {
        chunk_shape: [1], codecs: [{ name: 'bytes' }], index_location: 'end',
        index_codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'crc32c' }],
      } }], attributes: {},
    };
    const ranges: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/zarr.json')) return Response.json(metadata);
      if (!String(url).endsWith('/c/0')) return new Response(null, { status: 404 });
      if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': String(shard.length) } });
      const range = new Headers(init?.headers).get('range')!;
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const body = shard.slice(Number(match[1]), Number(match[2]) + 1);
      return new Response(body.buffer, { status: 206 });
    }));
    const store = new TolerantFetchStore('https://fixture.invalid/array');
    store.bytesByTag = new Map();
    const array = await zarr.open(store, { kind: 'array' });
    const before = store.bytesFetched;
    for (const index of borderFirst ? [0, 1] : [1, 0]) {
      const chunk = await array.getChunk([index], { kilnTag: index === 0 ? 'border' : 'core' } as RequestInit);
      expect(Array.from(chunk.data)).toEqual([index === 0 ? 10 : 20]);
    }
    expect(ranges.filter(r => r.startsWith('bytes=2-'))).toHaveLength(1);
    expect(store.bytesFetched - before).toBe(38); // includes the shared index
    expect(summarizeBorderBytes(store.bytesByTag, new Set(['core']))).toEqual({
      chunkBytes: 2, borderOnlyBytes: 1,
    });
  });

  it('still attributes full unsharded chunk responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    const store = new TolerantFetchStore('https://fixture.invalid');
    store.bytesByTag = new Map();
    await store.get('/0.0.0', { kilnTag: 'border' } as RequestInit);
    expect(summarizeBorderBytes(store.bytesByTag, new Set())).toEqual({ chunkBytes: 3, borderOnlyBytes: 3 });
    expect(store.bytesFetched).toBe(3);
  });
});
