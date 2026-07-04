/**
 * TolerantFetchStore - Zarr store that handles quirky HTTP backends
 *
 * 1. CloudFront / S3 with OAI/OAC returns HTTP 403 instead of 404 for missing
 *    objects. zarrita's FetchStore only treats 404 as "not found", so we map
 *    403 → undefined as well.
 *
 * 2. Vite's dev server (and other SPA hosts) return index.html with HTTP 200
 *    for any unmatched path. zarrita's FetchStore accepts any 200 response as
 *    valid data, so when zarrita probes for zarr.json (v3 format detection) it
 *    receives index.html, tries to JSON-parse it, and throws
 *    "Unexpected token '<'". We detect HTML responses by Content-Type and
 *    return undefined instead.
 *
 * 3. Fetch concurrency is bounded by a per-store semaphore. Each worker creates
 *    its own store, so the limit is per-worker. This prevents exhausting
 *    Chrome's socket pool (ERR_INSUFFICIENT_RESOURCES) when many bricks are
 *    assembled concurrently — especially on HTTP/1.1 where ~6 connections
 *    per origin is the hard browser limit.
 *
 * 4. Transient failures (5xx, network errors) are retried with bounded
 *    exponential backoff and THROW after exhaustion — they must never map to
 *    undefined, because zarrita interprets undefined as "chunk does not exist"
 *    and silently fills the region with zeros (permanent data holes).
 */

import { FetchStore } from 'zarrita';
import type { AbsolutePath, AsyncReadable, RangeQuery } from 'zarrita';

/** Replicate zarrita's internal URL resolution: base URL + absolute key path */
function resolveUrl(base: string | URL, key: AbsolutePath): string {
  const url = new URL(typeof base === 'string' ? base : base.href);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const resolved = new URL(key.slice(1), url);
  resolved.search = url.search;
  return resolved.href;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [250, 1000, 4000];

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class TolerantFetchStore implements AsyncReadable<RequestInit> {
  private inner: FetchStore;
  private baseUrl: string | URL;
  private overrides?: RequestInit;

  /** Fetch concurrency control — limits active HTTP requests per store instance */
  private activeFetches = 0;
  private fetchQueue: (() => void)[] = [];
  private readonly maxConcurrentFetches: number;

  /**
   * Per-request abort signal — set by the worker before each brick assembly,
   * cleared after. With serialized brick processing (one brick at a time per
   * worker), this is safe: only one signal is active at any moment.
   *
   * IMPORTANT: get()/getRange() capture this signal BEFORE the semaphore wait.
   * If captured after, queued fetches from a cancelled brick would wake up with
   * currentSignal=null and proceed as orphan requests that never abort.
   */
  currentSignal: AbortSignal | null = null;

  constructor(url: string | URL, options?: { overrides?: RequestInit; maxConcurrentFetches?: number }) {
    this.inner = new FetchStore(url, options);
    this.baseUrl = url;
    this.overrides = options?.overrides;
    this.maxConcurrentFetches = options?.maxConcurrentFetches ?? 6;
  }

  private async acquireFetchSlot(): Promise<void> {
    if (this.activeFetches < this.maxConcurrentFetches) {
      this.activeFetches++;
      return;
    }
    await new Promise<void>(resolve => this.fetchQueue.push(resolve));
  }

  private releaseFetchSlot(): void {
    const next = this.fetchQueue.shift();
    if (next) {
      // Hand the slot directly to the next waiter (no decrement/increment)
      next();
    } else {
      this.activeFetches--;
    }
  }

  async get(key: AbsolutePath, options?: RequestInit): Promise<Uint8Array | undefined> {
    // Capture signal BEFORE the semaphore wait — if the brick is cancelled
    // while this fetch is queued, the signal is already aborted when we
    // finally get a slot, and fetch() rejects immediately instead of
    // proceeding as an orphan request with no abort signal.
    const signal = this.currentSignal;
    await this.acquireFetchSlot();
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const href = resolveUrl(this.baseUrl, key);
      const init: RequestInit = { ...this.overrides, ...options, ...(signal ? { signal } : {}) };

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let response: Response;
        try {
          response = await fetch(href, init);
        } catch (e) {
          // AbortError — don't retry, rethrow immediately
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          // Network error — retry with backoff
          if (attempt < MAX_RETRIES) {
            await delay(RETRY_DELAYS[attempt]!);
            continue;
          }
          throw new Error(`Network error fetching ${key} after ${MAX_RETRIES + 1} attempts`);
        }

        // 403/404 are intentional "not found" (CloudFront OAI, missing chunks)
        if (response.status === 404 || response.status === 403) return undefined;

        if (response.status === 200 || response.status === 206) {
          const ct = response.headers.get('content-type') ?? '';
          if (ct.includes('text/html')) return undefined;
          return new Uint8Array(await response.arrayBuffer());
        }

        // 5xx or unexpected status — retry with backoff
        if (attempt < MAX_RETRIES) {
          await delay(RETRY_DELAYS[attempt]!);
          continue;
        }
        throw new Error(`HTTP ${response.status} fetching ${key} after ${MAX_RETRIES + 1} attempts`);
      }

      return undefined; // unreachable, satisfies TS
    } finally {
      this.releaseFetchSlot();
    }
  }

  async getRange(key: AbsolutePath, range: RangeQuery, options?: RequestInit): Promise<Uint8Array | undefined> {
    const signal = this.currentSignal;
    await this.acquireFetchSlot();
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const mergedOptions = signal ? { ...options, signal } : options;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          return await this.inner.getRange!(key, range, mergedOptions);
        } catch (e) {
          // AbortError — don't retry, rethrow immediately
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          // Intentional "not found" semantics (CloudFront OAI) — not an error
          if (e instanceof Error && e.message.includes('403')) {
            return undefined;
          }
          if (attempt < MAX_RETRIES) {
            await delay(RETRY_DELAYS[attempt]!);
            continue;
          }
          throw e;
        }
      }
      return undefined; // unreachable, satisfies TS
    } finally {
      this.releaseFetchSlot();
    }
  }
}
