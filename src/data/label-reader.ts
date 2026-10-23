/**
 * Readers for label bricks. Remote label images share one small worker pool per engine
 * (label-worker.ts), however many are shown; local folders are read on the main thread, like
 * local images. Both assemble with label-assembly.ts.
 */

import { Array as ZarrArray } from 'zarrita';
import type { AbsolutePath, DataType, Readable } from 'zarrita';
import { TolerantFetchStore } from './tolerant-fetch-store.js';
import { FileSystemStore } from './filesystem-store.js';
import { SharedFetchRegistry } from './shared-fetch.js';
import { assembleLabelBrick } from './label-assembly.js';
import type { DecodedChunk, LabelBrickData } from './label-assembly.js';
import { alignLabelLevels, readLabelImage } from './label-image.js';
import type { ImageGeometry, LabelImageInfo, LabelLevelParams, LabelLocation } from './label-image.js';
import type { LabelWorkerRequest, LabelWorkerResponse } from './label-worker.js';

/** Loads label bricks of one label image. */
export interface LabelReader {
  /** Brick (bx, by, bz) of image level `level`; rejects on errors, AbortError when aborted. */
  load(level: LabelLevelParams, bx: number, by: number, bz: number, timepoint: number, signal?: AbortSignal): Promise<LabelBrickData>;
  /** Network bytes read so far */
  readonly bytesFetched: number;
  dispose(): void;
}

/** A label image ready to read: its metadata, how each image level reads it, and the reader. */
export interface OpenedLabelImage {
  info: LabelImageInfo;
  levels: Array<LabelLevelParams | null>;
  notes: string[];
  reader: LabelReader;
}

/**
 * Dev: module worker for Vite imports. Prod: the pre-bundled inline worker, imported on first
 * use so that its codecs only load with the first remote label image.
 */
async function workerFactory(): Promise<() => Worker> {
  if (import.meta.env.DEV) {
    const path = './label-worker.ts';
    return () => new Worker(new URL(path, import.meta.url), { type: 'module' });
  }
  const { default: LabelWorkerInline } = await import('./label-worker.ts?worker&inline');
  return () => new LabelWorkerInline();
}

interface Pending {
  resolve: (msg: LabelWorkerResponse) => void;
  reject: (e: Error) => void;
}

/** Worker pool shared by the remote label images of one engine. */
export class LabelWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly started: Promise<void>;
  private nextId = 1;
  private nextSource = 1;
  private disposed = false;

  constructor(size = Math.max(2, Math.min(4, Math.floor((navigator.hardwareConcurrency ?? 4) / 2)))) {
    this.started = workerFactory().then((create) => {
      for (let i = 0; i < size && !this.disposed; i++) {
        const worker = create();
        worker.onmessage = (event: MessageEvent<LabelWorkerResponse>) => {
          const pending = this.pending.get(event.data.id);
          if (!pending) return;
          this.pending.delete(event.data.id);
          if (event.data.type === 'done' && event.data.error) pending.reject(new Error(event.data.error));
          else pending.resolve(event.data);
        };
        worker.onerror = (e) => console.error('[Kiln] label worker error:', e);
        this.workers.push(worker);
      }
    });
  }

  /** Register the label image at `url` with every worker; the reader routes its bricks. */
  async addSource(url: string, info: LabelImageInfo): Promise<LabelReader> {
    await this.started;
    if (this.disposed) throw new DOMException('Aborted', 'AbortError');
    const source = this.nextSource++;
    const arrays = info.arrays.map(a => ({ path: a.path, metadata: a.metadata }));
    await Promise.all(this.workers.map(w => this.request(w, { type: 'addSource', id: 0, source, url, arrays })));
    let bytes = 0;
    let disposed = false;
    return {
      load: (level, bx, by, bz, timepoint, signal) => {
        if (disposed || this.disposed) return Promise.reject(new DOMException('Aborted', 'AbortError'));
        // Neighbouring bricks share chunks: route by the first chunk the brick reads
        const chunk = (b: number, a: 0 | 1 | 2) => Math.floor(Math.max(0, b * 64 - 1) * level.scale[a] / level.chunks[a]);
        let h = (source * 2654435761) ^ (level.array * 40503) ^ (chunk(bx, 0) * 73856093) ^ (chunk(by, 1) * 19349663) ^ (chunk(bz, 2) * 83492791);
        h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
        const worker = this.workers[((h ^ (h >>> 15)) >>> 0) % this.workers.length]!;
        return this.request(worker, { type: 'load', id: 0, source, level, bx, by, bz, timepoint }, signal).then((msg) => {
          if (msg.type !== 'load') throw new Error('Unexpected label worker response');
          bytes += msg.bytes;
          return { kind: msg.kind, palette: new Float64Array(msg.palette), planes: msg.planes.map(p => new Uint8Array(p)) };
        });
      },
      get bytesFetched() { return bytes; },
      dispose: () => {
        if (disposed || this.disposed) return;
        disposed = true;
        for (const w of this.workers) void this.request(w, { type: 'removeSource', id: 0, source }).catch(() => {});
      },
    };
  }

  private request(worker: Worker, msg: LabelWorkerRequest, signal?: AbortSignal): Promise<LabelWorkerResponse> {
    if (this.disposed) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id });
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        worker.postMessage({ type: 'cancel', id } satisfies LabelWorkerRequest);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new DOMException('Aborted', 'AbortError'));
    this.pending.clear();
  }
}

/** Reads a local label image on the main thread, with a small decoded-chunk cache. */
class InlineLabelReader implements LabelReader {
  private readonly arrays: ZarrArray<DataType, Readable>[];
  private readonly cache = new Map<string, DecodedChunk>();
  private readonly inFlight = new SharedFetchRegistry<DecodedChunk>();
  private static readonly MAX_CHUNKS = 64;
  bytesFetched = 0;

  constructor(store: Readable, info: LabelImageInfo) {
    this.arrays = info.arrays.map(a => new ZarrArray(store, `/${a.path}` as AbsolutePath, a.metadata));
  }

  load(level: LabelLevelParams, bx: number, by: number, bz: number, timepoint: number, signal?: AbortSignal): Promise<LabelBrickData> {
    return assembleLabelBrick(level, bx, by, bz, timepoint, (array, coords, key) => {
      const hit = this.cache.get(key);
      if (hit) return Promise.resolve(hit);
      const arr = this.arrays[array];
      if (!arr) return Promise.resolve(null);
      return this.inFlight.run(key, (s) => arr.getChunk(coords, { signal: s } as RequestInit).then(c => {
        const chunk = { data: c.data as DecodedChunk['data'], shape: c.shape, stride: c.stride };
        if (this.cache.size >= InlineLabelReader.MAX_CHUNKS) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, chunk);
        return chunk;
      }), signal);
    }, signal);
  }

  dispose(): void {
    this.cache.clear();
  }
}

/** Store rooted at a sub-folder of a local folder. */
async function localStore(dir: FileSystemDirectoryHandle, path: string[]): Promise<FileSystemStore> {
  let handle = dir;
  for (const name of path) handle = await handle.getDirectoryHandle(name);
  return new FileSystemStore(handle);
}

/**
 * Open the label image at `location`, align it to the image (see alignLabelLevels) and get a
 * reader for it: remote ones read through `pool`, local ones on the main thread.
 */
export async function openLabelImage(
  location: LabelLocation, name: string, image: ImageGeometry, pool: () => LabelWorkerPool,
): Promise<OpenedLabelImage> {
  const store = location.kind === 'url'
    ? new TolerantFetchStore(location.url.replace(/\/$/, ''))
    : await localStore(location.dir, location.path);
  const info = await readLabelImage(store, name);
  const { levels, notes } = alignLabelLevels(image, info);
  const reader = location.kind === 'url'
    ? await pool().addSource(location.url.replace(/\/$/, ''), info)
    : new InlineLabelReader(store as unknown as Readable, info);
  return { info, levels, notes, reader };
}
