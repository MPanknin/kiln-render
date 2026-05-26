import type { NetworkStats } from './data-provider.js';

/**
 * Fixed-capacity rolling average over the last N samples.
 * Used for per-stage pipeline timing across all data providers.
 */
export class RollingAvg {
  private samples: number[] = [];
  constructor(private readonly capacity = 32) {}

  add(value: number): void {
    this.samples.push(value);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  get value(): number {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }

  get count(): number { return this.samples.length; }
}

/**
 * Tracks download volume and throughput for a data provider.
 */
export class NetworkTracker {
  private totalBytesDownloaded = 0;
  private requestCount = 0;
  private recentDownloads: { timestamp: number; bytes: number }[] = [];

  record(bytes: number): void {
    this.totalBytesDownloaded += bytes;
    this.requestCount++;
    this.recentDownloads.push({ timestamp: performance.now(), bytes });
  }

  getStats(): NetworkStats {
    const now = performance.now();
    const windowMs = 2000;
    const cutoff = now - windowMs;
    this.recentDownloads = this.recentDownloads.filter(d => d.timestamp > cutoff);
    const recentBytes = this.recentDownloads.reduce((sum, d) => sum + d.bytes, 0);
    return {
      totalBytesDownloaded: this.totalBytesDownloaded,
      recentBytesPerSecond: (recentBytes / windowMs) * 1000,
      requestCount: this.requestCount,
    };
  }
}
