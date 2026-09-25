/**
 * Main-thread chunk fetch broker (?p23=1). Workers ask it for raw chunk bytes
 * instead of fetching themselves, so identical in-flight requests from
 * different workers coalesce into one HTTP request (the browser cache only
 * dedupes *completed* responses) and the total number of concurrent fetches
 * is bounded and served in request order — the first brick's chunks are not
 * starved by the eleven bricks dispatched behind it.
 */

import type { AbsolutePath } from 'zarrita';
import { SharedFetchRegistry } from './shared-fetch.js';

export interface ChunkSource {
  get(key: AbsolutePath, options?: RequestInit): Promise<Uint8Array | undefined>;
}

export class ChunkFetchBroker {
  private registry = new SharedFetchRegistry<Uint8Array | undefined>();
  private queue: (() => void)[] = [];
  private active = 0;
  /** Distinct fetches actually started (after dedupe) — for diagnostics. */
  started = 0;

  constructor(private readonly source: ChunkSource, readonly maxInFlight = 16) {}

  /** Bytes for one chunk key, shared with any concurrent waiter; undefined = not found. */
  get(key: AbsolutePath, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    return this.registry.run(key, s => this.limited(() => this.source.get(key, { signal: s }), s), signal);
  }

  /** Number of fetch slots currently in use plus queued requests — for tests/diagnostics. */
  get pending(): number { return this.active + this.queue.length; }

  private limited<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', onAbortQueued);
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        this.active++;
        this.started++;
        fn().then(resolve, reject).finally(() => {
          this.active--;
          this.next();
        });
      };
      // Cancelled while still queued: drop it so it never occupies a slot.
      const onAbortQueued = () => {
        const i = this.queue.indexOf(start);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (this.active < this.maxInFlight) start();
      else {
        this.queue.push(start);
        signal.addEventListener('abort', onAbortQueued, { once: true });
      }
    });
  }

  private next(): void {
    while (this.active < this.maxInFlight && this.queue.length > 0) this.queue.shift()!();
  }
}
