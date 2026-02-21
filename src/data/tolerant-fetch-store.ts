/**
 * TolerantFetchStore - FetchStore wrapper that treats HTTP 403 as "not found"
 *
 * CloudFront (and some S3 configurations with OAI/OAC) returns 403 instead of
 * 404 for missing objects. zarrita's FetchStore only handles 404 gracefully,
 * so this wrapper catches 403 errors and returns undefined — matching the 404
 * behavior that zarrita expects for optional metadata files like .zattrs.
 *
 * An alternative is to configure a CloudFront Custom Error Response that maps
 * 403 → 404. We handle it in code instead so kiln works against any HTTP
 * backend without requiring specific CDN configuration.
 */

import { FetchStore } from 'zarrita';
import type { AbsolutePath, AsyncReadable, RangeQuery } from 'zarrita';

export class TolerantFetchStore implements AsyncReadable<RequestInit> {
  private inner: FetchStore;

  constructor(url: string | URL, options?: { overrides?: RequestInit }) {
    this.inner = new FetchStore(url, options);
  }

  async get(key: AbsolutePath, options?: RequestInit): Promise<Uint8Array | undefined> {
    try {
      return await this.inner.get(key, options);
    } catch (e) {
      if (e instanceof Error && e.message.includes('403')) {
        return undefined;
      }
      throw e;
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
