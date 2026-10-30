/**
 * Kiln fetch-pattern benchmark driver (in-page, single-shot).
 *
 * Activates only on `?bench=1`. Measures the initial load of whatever dataset
 * the URL points at: time-to-converge, number of fetches, bytes, brick
 * lifecycle counts, the per-stage pipeline breakdown, and GPU and cache memory
 * (current and peak). No camera interaction unless `?benchSweep=1`, which
 * orbits the camera once after the first convergence so eviction and the
 * caches get exercised, then waits for convergence again. Prints a compact
 * block you can copy-paste for A/B comparison.
 *
 * Results are emitted three ways:
 *   1. a human-readable block + `KILN_BENCH_RESULT <json>` in the console
 *   2. `window.__KILN_BENCH_RESULT = report`  (pollable via CDP/puppeteer)
 *   3. POST to `?report=<url>` if present
 *
 * Structural typing (BenchViewer) keeps this decoupled from the library types.
 *
 * URL params:
 *   ?bench=1              enable
 *   ?benchTimeout=120000  give-up timeout (ms) if it never converges
 *   ?benchStable=8        consecutive stable polls required to call it converged
 *   ?benchLabel=<name>    label echoed into the report
 *   ?benchSweep=1         orbit the camera once after converging, then converge again
 *   ?benchSweepMs=6000    duration of the orbit (ms)
 *   ?report=<url>         POST the JSON report here when done
 */

import type { LoadMilestones } from '@kiln/core/milestones.js';
import type { MemoryStats } from '@kiln/core/memory-stats.js';

interface BenchStats {
  desiredCount: number;
  loadedCount: number;
  pendingCount: number;
  requestCount: number;
  totalBytesDownloaded: number;
  bricksDispatched: number;
  bricksCommitted: number;
  bricksCancelled: number;
  bricksDiscarded: number;
  evictedCount: number;
  avgBrickLatencyMs: number;
  rayCulledCount: number;
  pipelineTimings: {
    avgQueueMs: number;
    avgFetchMs: number;
    avgAssemblyMs: number;
    avgUploadMs: number;
    chunkCacheHitRatio?: number;
    chunkBytes?: number;
    borderOnlyBytes?: number;
  };
}

type OrbitState = [number, number, number, number, number, number];

/** Minimal structural view of KilnViewer — only what the bench reads. */
export interface BenchViewer {
  renderer: { isConverged: boolean; numChannels: number };
  streamingManager: { baseLodLoaded: boolean; getStats(): BenchStats };
  metadata: { name: string };
  milestones: LoadMilestones;
  getMemoryStats(): MemoryStats;
  camera: { getOrbitState(): OrbitState; setOrbitState(state: OrbitState): void };
}

export interface BenchMemory {
  /** GPU bytes at the end, and the most seen at any poll */
  gpuBytes: number;
  gpuPeakBytes: number;
  atlasBytes: number;
  renderTargetBytes: number;
  labelBytes: number;
  brickCacheBytes: number;
  brickCachePeakBytes: number;
  brickCacheHitRatio: number;
  chunkCacheBytes: number;
  chunkCacheHitRatio: number;
  /** Chrome only, else null */
  jsHeapPeakBytes: number | null;
  allocationsRefused: number;
  atlasEvictions: number;
  brickCacheEvictions: number;
}

export interface BenchSweep {
  durationMs: number;
  /** ms from the end of the orbit until converged again (null if never) */
  reconvergeMs: number | null;
  /** Bricks dispatched and bytes downloaded from the start of the orbit to reconvergence */
  bricksDispatched: number;
  bytesDownloaded: number;
}

export interface BenchReport {
  label: string;
  /** Raw URL query string — makes which feature flags (?p2=1 etc.) were active self-evident when pasted. */
  query: string;
  dataset: string;
  numChannels: number;
  /** ms from navigation start to converged (the headline number). */
  convergeMs: number;
  /** Same origin as convergeMs; null if never reached. See LoadMilestones. */
  firstContentSubmitMs: number | null;
  firstContentFrameMs: number | null;
  baseCompleteMs: number | null;
  milestones: LoadMilestones;
  timedOut: boolean;
  requestCount: number;
  bytesDownloaded: number;
  bricksDispatched: number;
  bricksCommitted: number;
  bricksCancelled: number;
  bricksDiscarded: number;
  evicted: number;
  loadedCount: number;
  desiredCount: number;
  /** Bricks ray guidance left out of the final desired set. */
  rayCulled: number;
  avgBrickLatencyMs: number;
  chunkCacheHitRatio: number;
  /** Chunk bytes downloaded, and the part only the one-voxel brick border needed (Zarr only, else null). */
  chunkBytes: number | null;
  borderOnlyBytes: number | null;
  timings: { queueMs: number; fetchMs: number; assemblyMs: number; uploadMs: number };
  memory: BenchMemory;
  /** Present with ?benchSweep=1 */
  sweep: BenchSweep | null;
  userAgent: string;
}

const POLL_MS = 100;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function num(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Peak memory over every poll of the run. */
class PeakTracker {
  gpu = 0;
  brickCache = 0;
  jsHeap: number | null = null;

  sample(m: MemoryStats): void {
    this.gpu = Math.max(this.gpu, m.gpu.totalBytes);
    this.brickCache = Math.max(this.brickCache, m.cpu.brickCacheBytes);
    if (m.cpu.jsHeapBytes !== null) this.jsHeap = Math.max(this.jsHeap ?? 0, m.cpu.jsHeapBytes);
  }
}

/**
 * Wait until the pipeline is idle and the image has converged, held stable for
 * `stablePolls` consecutive polls (debounce: a transient `pendingCount===0`
 * mid-stream doesn't count). Returns whether it settled before the timeout.
 */
async function waitForConverged(v: BenchViewer, peaks: PeakTracker, timeoutMs: number, stablePolls: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  let stable = 0;
  while (performance.now() < deadline) {
    peaks.sample(v.getMemoryStats());
    const s = v.streamingManager.getStats();
    const idle = s.pendingCount === 0 && v.streamingManager.baseLodLoaded && v.renderer.isConverged;
    stable = idle ? stable + 1 : 0;
    if (stable >= stablePolls) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/** One full orbit around the target, zooming to half distance midway and back out. */
async function sweepCamera(v: BenchViewer, peaks: PeakTracker, durationMs: number): Promise<void> {
  const [rx, ry, dist, tx, ty, tz] = v.camera.getOrbitState();
  const start = performance.now();
  let lastSample = 0;
  for (;;) {
    const t = Math.min(1, (performance.now() - start) / durationMs);
    v.camera.setOrbitState([rx, ry + 2 * Math.PI * t, dist * (1 - 0.5 * Math.sin(Math.PI * t)), tx, ty, tz]);
    if (performance.now() - lastSample >= POLL_MS) {
      peaks.sample(v.getMemoryStats());
      lastSample = performance.now();
    }
    if (t >= 1) return;
    await new Promise<void>(r => requestAnimationFrame(() => r()));
  }
}

function benchMemory(m: MemoryStats, peaks: PeakTracker): BenchMemory {
  return {
    gpuBytes: m.gpu.totalBytes,
    gpuPeakBytes: peaks.gpu,
    atlasBytes: m.gpu.atlasBytes,
    renderTargetBytes: m.gpu.renderTargetBytes,
    labelBytes: m.gpu.labelBytes,
    brickCacheBytes: m.cpu.brickCacheBytes,
    brickCachePeakBytes: peaks.brickCache,
    brickCacheHitRatio: m.cpu.brickCacheHitRatio,
    chunkCacheBytes: m.cpu.chunkCacheBytes,
    chunkCacheHitRatio: m.cpu.chunkCacheHitRatio,
    jsHeapPeakBytes: peaks.jsHeap,
    allocationsRefused: m.pressure.allocationsRefused,
    atlasEvictions: m.pressure.atlasEvictions,
    brickCacheEvictions: m.pressure.brickCacheEvictions,
  };
}

function formatReport(r: BenchReport): string {
  const mb = (b: number) => (b / 1e6).toFixed(1);
  const ms = (v: number | null) => (v === null ? 'n/a' : Math.round(v) + ' ms');
  const pct = (v: number) => (v * 100).toFixed(0) + '%';
  const pad = (label: string) => (label + ':').padEnd(20);
  const m = r.milestones;
  const mem = r.memory;
  return [
    '=== KILN BENCH ===',
    `${pad('dataset')}${r.dataset} (${r.numChannels}ch)`,
    `${pad('label')}${r.label}`,
    `${pad('flags')}${r.query || '(none)'}`,
    `${pad('time to converge')}${Math.round(r.convergeMs)} ms${r.timedOut ? '  ⚠ TIMED OUT (did not converge)' : ''}`,
    `${pad('setup')}open ${ms(m.datasetOpenStart)} · device ${ms(m.deviceReady)} · metadata ${ms(m.metadataReady)} · gpu ${ms(m.gpuReady)}`,
    `${pad('first content')}submit ${ms(r.firstContentSubmitMs)} · frame ${ms(r.firstContentFrameMs)}`,
    `${pad('base coverage')}50% ${ms(m.baseCoverage50)} · 90% ${ms(m.baseCoverage90)} · done ${ms(r.baseCompleteMs)}`,
    `${pad('requests')}${r.requestCount}`,
    `${pad('downloaded')}${mb(r.bytesDownloaded)} MB`,
    `${pad('bricks')}dispatched ${r.bricksDispatched} · committed ${r.bricksCommitted} · cancelled ${r.bricksCancelled} · discarded ${r.bricksDiscarded}`,
    `${pad('evicted')}${r.evicted}`,
    `${pad('avg brick latency')}${Math.round(r.avgBrickLatencyMs)} ms`,
    `${pad('chunk cache hit')}${pct(r.chunkCacheHitRatio)}`,
    ...(r.chunkBytes && r.borderOnlyBytes !== null
      ? [`${pad('border-only')}${mb(r.borderOnlyBytes)} of ${mb(r.chunkBytes)} MB chunk data (${(100 * r.borderOnlyBytes / r.chunkBytes).toFixed(0)}%)`]
      : []),
    `${pad('pipeline avg ms')}queue ${r.timings.queueMs.toFixed(0)} · fetch ${r.timings.fetchMs.toFixed(0)} · assembly ${r.timings.assemblyMs.toFixed(0)} · upload ${r.timings.uploadMs.toFixed(0)}`,
    `${pad('resident/desired')}${r.loadedCount} / ${r.desiredCount}${r.rayCulled > 0 ? ` · ray-culled ${r.rayCulled}` : ''}`,
    `${pad('gpu memory')}${mb(mem.gpuBytes)} MB (peak ${mb(mem.gpuPeakBytes)}) · atlas ${mb(mem.atlasBytes)} · targets ${mb(mem.renderTargetBytes)} · labels ${mb(mem.labelBytes)}`,
    `${pad('cpu caches')}bricks ${mb(mem.brickCacheBytes)} MB (peak ${mb(mem.brickCachePeakBytes)}, hit ${pct(mem.brickCacheHitRatio)}) · chunks ${mb(mem.chunkCacheBytes)} MB (hit ${pct(mem.chunkCacheHitRatio)})` +
      (mem.jsHeapPeakBytes !== null ? ` · js heap peak ${mb(mem.jsHeapPeakBytes)} MB` : ''),
    `${pad('pressure')}refused ${mem.allocationsRefused} · atlas evictions ${mem.atlasEvictions} · brick cache evictions ${mem.brickCacheEvictions}`,
    ...(r.sweep
      ? [`${pad('sweep')}orbit ${Math.round(r.sweep.durationMs)} ms · reconverge ${ms(r.sweep.reconvergeMs)} · dispatched ${r.sweep.bricksDispatched} · downloaded ${mb(r.sweep.bytesDownloaded)} MB`]
      : []),
    '==================',
  ].join('\n');
}

/**
 * Run the benchmark if `?bench=1`. Call once, right after the viewer is created.
 */
export async function maybeRunBench(viewer: BenchViewer): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  if (params.get('bench') !== '1') return;

  const timeoutMs = num(params, 'benchTimeout', 120000);
  const stablePolls = num(params, 'benchStable', 8);
  const label = params.get('benchLabel') ?? 'run';
  const reportUrl = params.get('report');
  const peaks = new PeakTracker();

  const settled = await waitForConverged(viewer, peaks, timeoutMs, stablePolls);
  // performance.now() is ms since page navigation start, so this is the full
  // open→converge wall-clock (WebGPU init + metadata + base load + refinement).
  const convergeMs = performance.now();

  let sweep: BenchSweep | null = null;
  if (params.get('benchSweep') === '1') {
    const durationMs = num(params, 'benchSweepMs', 6000);
    const before = viewer.streamingManager.getStats();
    await sweepCamera(viewer, peaks, durationMs);
    const orbitEnd = performance.now();
    const reconverged = await waitForConverged(viewer, peaks, timeoutMs, stablePolls);
    const after = viewer.streamingManager.getStats();
    sweep = {
      durationMs,
      reconvergeMs: reconverged ? performance.now() - orbitEnd : null,
      bricksDispatched: after.bricksDispatched - before.bricksDispatched,
      bytesDownloaded: after.totalBytesDownloaded - before.totalBytesDownloaded,
    };
  }

  const s = viewer.streamingManager.getStats();
  const m = viewer.milestones;

  const report: BenchReport = {
    label,
    query: window.location.search,
    dataset: viewer.metadata.name,
    numChannels: viewer.renderer.numChannels,
    convergeMs,
    firstContentSubmitMs: m.firstContentSubmit,
    firstContentFrameMs: m.firstContentFrame,
    baseCompleteMs: m.baseComplete,
    milestones: m,
    timedOut: !settled,
    requestCount: s.requestCount,
    bytesDownloaded: s.totalBytesDownloaded,
    bricksDispatched: s.bricksDispatched,
    bricksCommitted: s.bricksCommitted,
    bricksCancelled: s.bricksCancelled,
    bricksDiscarded: s.bricksDiscarded,
    evicted: s.evictedCount,
    loadedCount: s.loadedCount,
    desiredCount: s.desiredCount,
    rayCulled: s.rayCulledCount,
    avgBrickLatencyMs: s.avgBrickLatencyMs,
    chunkCacheHitRatio: s.pipelineTimings.chunkCacheHitRatio ?? 0,
    chunkBytes: s.pipelineTimings.chunkBytes ?? null,
    borderOnlyBytes: s.pipelineTimings.borderOnlyBytes ?? null,
    timings: {
      queueMs: s.pipelineTimings.avgQueueMs,
      fetchMs: s.pipelineTimings.avgFetchMs,
      assemblyMs: s.pipelineTimings.avgAssemblyMs,
      uploadMs: s.pipelineTimings.avgUploadMs,
    },
    memory: benchMemory(viewer.getMemoryStats(), peaks),
    sweep,
    userAgent: navigator.userAgent,
  };

  const json = JSON.stringify(report);
  // eslint-disable-next-line no-console
  console.log(formatReport(report) + '\nKILN_BENCH_RESULT ' + json);
  (window as unknown as { __KILN_BENCH_RESULT?: BenchReport }).__KILN_BENCH_RESULT = report;

  if (reportUrl) {
    try {
      await fetch(reportUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[bench] failed to POST report:', e);
    }
  }
}
