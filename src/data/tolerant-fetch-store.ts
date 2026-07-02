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

export class TolerantFetchStore implements AsyncReadable<RequestInit> {
  private inner: FetchStore;
  private baseUrl: string | URL;
  private overrides?: RequestInit;

  /** Fetch concurrency control — limits active HTTP requests per store instance */
  private activeFetches = 0;
  private fetchQueue: (() => void)[] = [];
  private readonly maxConcurrentFetches: number;

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
    await this.acquireFetchSlot();
    try {
      const href = resolveUrl(this.baseUrl, key);
      const init: RequestInit = { ...this.overrides, ...options };

      let response: Response;
      try {
        response = await fetch(href, init);
      } catch {
        return undefined; // network error
      }

      // 403/404 are intentional "not found" (CloudFront OAI, missing chunks)
      if (response.status === 404 || response.status === 403) return undefined;

      if (response.status === 200 || response.status === 206) {
        const ct = response.headers.get('content-type') ?? '';
        if (ct.includes('text/html')) return undefined;
        return new Uint8Array(await response.arrayBuffer());
      }

      // 5xx or unexpected status — treat as missing (don't throw, don't retry)
      return undefined;
    } finally {
      this.releaseFetchSlot();
    }
  }

  async getRange(key: AbsolutePath, range: RangeQuery, options?: RequestInit): Promise<Uint8Array | undefined> {
    try {
      return await this.inner.getRange!(key, range, options);
    } catch (e) {
      if (e instanceof Error && e.message.includes('403')) {
        return undefined;
      }
      throw e;
    }
  }
}
