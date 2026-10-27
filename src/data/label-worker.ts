/**
 * Label worker: reads label bricks for any number of label images (sources) off the main
 * thread, with one decoded-chunk cache per worker shared by all sources. Assembly and palette
 * compression are label-assembly.ts; results are transferred zero-copy.
 */

import { Array as ZarrArray, registry } from 'zarrita';
import type { AbsolutePath, ArrayMetadata, DataType, Readable } from 'zarrita';
import blosc from 'numcodecs/blosc';
import lz4 from 'numcodecs/lz4';
import zstd from 'numcodecs/zstd';
import { TolerantFetchStore } from './tolerant-fetch-store.js';
import { SharedFetchRegistry } from './shared-fetch.js';
import { assembleLabelBrick } from './label-assembly.js';
import type { DecodedChunk } from './label-assembly.js';
import type { LabelLevelParams } from './label-image.js';

// Static codec imports: zarrita's dynamic imports fail in Vite dev workers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set('blosc', async () => blosc as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set('lz4', async () => lz4 as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registry.set('zstd', async () => zstd as any);

export type LabelWorkerRequest =
  | { type: 'addSource'; id: number; source: number; url: string; arrays: Array<{ path: string; metadata: ArrayMetadata<DataType> }> }
  | { type: 'removeSource'; id: number; source: number }
  | { type: 'load'; id: number; source: number; level: LabelLevelParams; bx: number; by: number; bz: number }
  | { type: 'cancel'; id: number };

export type LabelWorkerResponse =
  | { type: 'done'; id: number; error?: string }
  | { type: 'load'; id: number; kind: 'empty' | 'uniform' | 'mixed'; palette: ArrayBuffer; indices: ArrayBuffer | null; bytes: number };

interface Source {
  store: TolerantFetchStore;
  arrays: ZarrArray<DataType, Readable>[];
}

const sources = new Map<number, Source>();

// Decoded chunks of every source, least recently used first; bounded by bytes
const MIN_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const cache = new Map<string, { chunk: DecodedChunk; bytes: number }>();
let cacheBytes = 0;
let largestChunk = 0;
const inFlight = new SharedFetchRegistry<DecodedChunk>();
const active = new Map<number, AbortController>();

function chunkBytes(chunk: DecodedChunk): number {
  const data = chunk.data as { byteLength?: number; length: number };
  return data.byteLength ?? data.length * 8;
}

function cachePut(key: string, chunk: DecodedChunk): void {
  const bytes = chunkBytes(chunk);
  largestChunk = Math.max(largestChunk, bytes);
  const budget = Math.min(MAX_CACHE_BYTES, Math.max(MIN_CACHE_BYTES, 8 * largestChunk));
  const old = cache.get(key);
  if (old) { cacheBytes -= old.bytes; cache.delete(key); }
  while (cacheBytes + bytes > budget && cache.size > 0) {
    const [oldest, entry] = cache.entries().next().value!;
    cacheBytes -= entry.bytes;
    cache.delete(oldest);
  }
  cache.set(key, { chunk, bytes });
  cacheBytes += bytes;
}

function getChunk(sourceId: number, source: Source, signal: AbortSignal) {
  return async (array: number, coords: number[], key: string): Promise<DecodedChunk | null> => {
    const cacheKey = `${sourceId}:${key}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      cache.delete(cacheKey);
      cache.set(cacheKey, hit);
      return hit.chunk;
    }
    const arr = source.arrays[array];
    if (!arr) return null;
    return inFlight.run(cacheKey, (fetchSignal) => arr.getChunk(coords, { signal: fetchSignal } as RequestInit).then(c => {
      const chunk = { data: c.data as DecodedChunk['data'], shape: c.shape, stride: c.stride };
      cachePut(cacheKey, chunk);
      return chunk;
    }), signal);
  };
}

const post = (msg: LabelWorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (event: MessageEvent<LabelWorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'addSource': {
      const store = new TolerantFetchStore(msg.url);
      sources.set(msg.source, {
        store,
        arrays: msg.arrays.map(a => new ZarrArray(store as Readable, `/${a.path}` as AbsolutePath, a.metadata)),
      });
      post({ type: 'done', id: msg.id });
      return;
    }
    case 'removeSource': {
      sources.delete(msg.source);
      const prefix = `${msg.source}:`;
      for (const [key, entry] of cache) {
        if (key.startsWith(prefix)) { cacheBytes -= entry.bytes; cache.delete(key); }
      }
      post({ type: 'done', id: msg.id });
      return;
    }
    case 'cancel':
      active.get(msg.id)?.abort();
      active.delete(msg.id);
      return;
    case 'load': {
      const source = sources.get(msg.source);
      if (!source) { post({ type: 'done', id: msg.id, error: 'Unknown label source' }); return; }
      const controller = new AbortController();
      active.set(msg.id, controller);
      const before = source.store.bytesFetched;
      assembleLabelBrick(msg.level, msg.bx, msg.by, msg.bz, getChunk(msg.source, source, controller.signal), controller.signal)
        .then((brick) => {
          if (controller.signal.aborted) return;
          const palette = brick.palette.buffer as ArrayBuffer;
          const indices = brick.indices ? brick.indices.buffer as ArrayBuffer : null;
          post({ type: 'load', id: msg.id, kind: brick.kind, palette, indices, bytes: source.store.bytesFetched - before }, indices ? [palette, indices] : [palette]);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          post({ type: 'done', id: msg.id, error: e instanceof Error ? e.message : String(e) });
        })
        .finally(() => active.delete(msg.id));
    }
  }
};
