/**
 * Reads label bricks of remote label images through one small worker pool per engine
 * (label-worker.ts), however many images are shown. Assembly is label-assembly.ts.
 */

import { TolerantFetchStore } from './tolerant-fetch-store.js';
import type { LabelBrickData } from './label-assembly.js';
import { alignLabelLevels, readLabelImage } from './label-image.js';
import type { ImageGeometry, LabelImageInfo, LabelLevelParams } from './label-image.js';
import type { LabelWorkerRequest, LabelWorkerResponse } from './label-worker.js';

/** Loads label bricks of one label image. */
export interface LabelReader {
  /** Brick (bx, by, bz) of image level `level`; rejects on errors, AbortError when aborted. */
  load(level: LabelLevelParams, bx: number, by: number, bz: number, signal?: AbortSignal): Promise<LabelBrickData>;
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
 * use so that its codecs only load with the first label image.
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

/** Worker pool shared by the label images of one engine. */
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
      load: (level, bx, by, bz, signal) => {
        if (disposed || this.disposed) return Promise.reject(new DOMException('Aborted', 'AbortError'));
        // Neighbouring bricks share chunks: route by the first chunk the brick reads
        const chunk = (b: number, a: 0 | 1 | 2) => Math.floor(Math.max(0, b * 64 - 1) * level.scale[a] / level.chunks[a]);
        let h = (source * 2654435761) ^ (level.array * 40503) ^ (chunk(bx, 0) * 73856093) ^ (chunk(by, 1) * 19349663) ^ (chunk(bz, 2) * 83492791);
        h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
        const worker = this.workers[((h ^ (h >>> 15)) >>> 0) % this.workers.length]!;
        return this.request(worker, { type: 'load', id: 0, source, level, bx, by, bz }, signal).then((msg) => {
          if (msg.type !== 'load') throw new Error('Unexpected label worker response');
          bytes += msg.bytes;
          return { kind: msg.kind, palette: new Float64Array(msg.palette), indices: msg.indices && new Uint16Array(msg.indices) };
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

/** Open the label image at `url`, align it to the image (see alignLabelLevels) and get a reader for it. */
export async function openLabelImage(
  url: string, name: string, image: ImageGeometry, pool: () => LabelWorkerPool,
): Promise<OpenedLabelImage> {
  const base = url.replace(/\/$/, '');
  const info = await readLabelImage(new TolerantFetchStore(base), name);
  const { levels, notes } = alignLabelLevels(image, info);
  const reader = await pool().addSource(base, info);
  return { info, levels, notes, reader };
}
