/**
 * TolerantFetchStore - Zarr store that handles quirky HTTP backends.
 * Maps 403→undefined, rejects HTML 200s, retries 5xx with backoff.
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

/**
 * @internal — internal zarrita store wrapper; uses zarrita types on its surface
 *   but is not part of the public API. Stripped from emitted .d.ts so `zarrita`
 *   doesn't leak into published types.
 */
export class TolerantFetchStore implements AsyncReadable<RequestInit> {
  private inner: FetchStore;
  private baseUrl: string | URL;
  private overrides?: RequestInit;

  /**
   * Cumulative real network activity for this store instance — every fetch
   * attempt (including retries) counts as a request; bytes are counted only
   * on successful body reads. Never reset, so callers can diff two snapshots
   * to get an exact delta regardless of concurrent in-flight requests.
   */
  bytesFetched = 0;
  requestCount = 0;
  /**
   * Bench only (null otherwise): chunk payload bytes per request tag. A caller tags a request
   * by passing `kilnTag` in its options, which zarrita forwards unchanged.
   */
  bytesByTag: Map<string, number> | null = null;

  private tagBytes(options: RequestInit | undefined, bytes: number): void {
    const tag = (options as { kilnTag?: string } | undefined)?.kilnTag;
    if (tag && this.bytesByTag) this.bytesByTag.set(tag, (this.bytesByTag.get(tag) ?? 0) + bytes);
  }

  constructor(url: string | URL, options?: { overrides?: RequestInit }) {
    this.inner = new FetchStore(url, options);
    this.baseUrl = url;
    this.overrides = options?.overrides;
  }

  async get(key: AbsolutePath, options?: RequestInit): Promise<Uint8Array | undefined> {
    const href = resolveUrl(this.baseUrl, key);
    const init: RequestInit = { ...this.overrides, ...options };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      this.requestCount++;
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
        const bytes = new Uint8Array(await response.arrayBuffer());
        this.bytesFetched += bytes.byteLength;
        this.tagBytes(options, bytes.byteLength);
        return bytes;
      }

      // 5xx or unexpected status — retry with backoff
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAYS[attempt]!);
        continue;
      }
      throw new Error(`HTTP ${response.status} fetching ${key} after ${MAX_RETRIES + 1} attempts`);
    }

    return undefined; // unreachable, satisfies TS
  }

  async getRange(key: AbsolutePath, range: RangeQuery, options?: RequestInit): Promise<Uint8Array | undefined> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.requestCount++;
      try {
        const result = await this.inner.getRange!(key, range, options);
        if (result) {
          this.bytesFetched += result.byteLength;
          // Zarrita reads a shared shard index with a suffix range using the
          // first chunk's options. It is metadata needed by other chunks too,
          // so keep it in network totals but never charge it to that chunk.
          if (!('suffixLength' in range)) this.tagBytes(options, result.byteLength);
        }
        return result;
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
  }
}
