/**
 * Kiln fetch-pattern benchmark driver (in-page, single-shot).
 *
 * Activates only on `?bench=1`. Measures the initial load of whatever dataset
 * the URL points at: time-to-converge, number of fetches, bytes, brick
 * lifecycle counts, and the per-stage pipeline breakdown. No camera
 * interaction — you point the URL at a dataset, it measures the load, prints a
 * compact block you can copy-paste for A/B comparison.
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
 *   ?benchScenarios=zoom,pan,orbit,glide-zoom,glide-pan,return   after converging, run camera
 *                         scenarios (glide-* animate over 2.5 s) and time each re-converge
 *   ?report=<url>         POST the JSON report here when done
 */

import type { LoadMilestones } from '@kiln/core/milestones.js';

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
  pipelineTimings: {
    avgQueueMs: number;
    avgFetchMs: number;
    avgAssemblyMs: number;
    avgUploadMs: number;
    chunkCacheHitRatio?: number;
  };
}

/** Minimal structural view of KilnViewer — only what the bench reads. */
type OrbitState = [number, number, number, number, number, number];

export interface BenchViewer {
  renderer: { isConverged: boolean; numChannels: number };
  streamingManager: { baseLodLoaded: boolean; getStats(): BenchStats };
  metadata: { name: string };
  milestones: LoadMilestones;
  camera: { getOrbitState(): OrbitState; setOrbitState(s: OrbitState): void };
  captureImage(): Promise<Blob>;
}

/** Signature of a converged frame: SHA-256 of the pixels plus a 64×40 luminance thumbnail. */
export interface ImageSignature { hash: string; thumb: number[] }

/** One camera scenario after convergence and the streaming it triggers. */
export interface ScenarioReport {
  name: string;
  /** ms from the camera change to the first newly committed brick; null if none. */
  firstCommitMs: number | null;
  /** ms until pending work fell to ≤50% / ≤10% of its peak after the change; null if never. */
  desired50Ms: number | null;
  desired90Ms: number | null;
  /** Peak pending bricks (queued + in flight) observed after the change. */
  peakPending: number;
  chunkCacheHitRatio: number;
  /** ms from the camera change until pipeline idle + converged again. */
  reconvergeMs: number;
  /** Camera animation length (0 = jump) and ms from the end of motion to re-converge. */
  motionMs: number;
  afterStopMs: number;
  /** Bytes the bench proxy actually served during the scenario (NaN when not behind the proxy). */
  wireBytes: number;
  timedOut: boolean;
  requests: number;
  bytesDownloaded: number;
  committed: number;
  cancelled: number;
  discarded: number;
  desiredCount: number;
  image: ImageSignature | null;
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
  avgBrickLatencyMs: number;
  chunkCacheHitRatio: number;
  timings: { queueMs: number; fetchMs: number; assemblyMs: number; uploadMs: number };
  userAgent: string;
  /** Signature of the converged initial view. */
  image?: ImageSignature | null;
  scenarios?: ScenarioReport[];
}

const POLL_MS = 100;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function num(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Wait until the pipeline is idle and the image has converged, held stable for
 * `stablePolls` consecutive polls (debounce: a transient `pendingCount===0`
 * mid-stream doesn't count). Returns whether it settled before the timeout.
 */
async function waitForConverged(v: BenchViewer, timeoutMs: number, stablePolls: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  let stable = 0;
  while (performance.now() < deadline) {
    const s = v.streamingManager.getStats();
    const idle = s.pendingCount === 0 && v.streamingManager.baseLodLoaded && v.renderer.isConverged;
    stable = idle ? stable + 1 : 0;
    if (stable >= stablePolls) return true;
    await sleep(POLL_MS);
  }
  return false;
}

function formatReport(r: BenchReport): string {
  const mb = (b: number) => (b / 1e6).toFixed(1);
  const ms = (v: number | null) => (v === null ? 'n/a' : Math.round(v) + ' ms');
  const pad = (label: string) => (label + ':').padEnd(20);
  const m = r.milestones;
  return [
    '=== KILN BENCH ===',
    `${pad('dataset')}${r.dataset} (${r.numChannels}ch)`,
    `${pad('label')}${r.label}`,
    `${pad('flags')}${r.query || '(none)'}`,
    `${pad('time to converge')}${Math.round(r.convergeMs)} ms${r.timedOut ? '  ⚠ TIMED OUT (did not converge)' : ''}`,
    `${pad('setup')}open ${ms(m.datasetOpenStart)} · device ${ms(m.deviceReady)} · metadata ${ms(m.metadataReady)} · gpu ${ms(m.gpuReady)}`,
    `${pad('first content')}submit ${ms(r.firstContentSubmitMs)} · frame ${ms(r.firstContentFrameMs)}`,
    `${pad('base coverage')}50% ${ms(m.baseCoverage50)} · 90% ${ms(m.baseCoverage90)} · ch0 ${ms(m.baseChannel0Complete)} · done ${ms(r.baseCompleteMs)}`,
    `${pad('requests')}${r.requestCount}`,
    `${pad('downloaded')}${mb(r.bytesDownloaded)} MB`,
    `${pad('bricks')}dispatched ${r.bricksDispatched} · committed ${r.bricksCommitted} · cancelled ${r.bricksCancelled} · discarded ${r.bricksDiscarded}`,
    `${pad('evicted')}${r.evicted}`,
    `${pad('avg brick latency')}${Math.round(r.avgBrickLatencyMs)} ms`,
    `${pad('chunk cache hit')}${(r.chunkCacheHitRatio * 100).toFixed(0)}%`,
    `${pad('pipeline avg ms')}queue ${r.timings.queueMs.toFixed(0)} · fetch ${r.timings.fetchMs.toFixed(0)} · assembly ${r.timings.assemblyMs.toFixed(0)} · upload ${r.timings.uploadMs.toFixed(0)}`,
    `${pad('resident/desired')}${r.loadedCount} / ${r.desiredCount}`,
    ...(r.scenarios ?? []).flatMap(sc => [
      `${pad(sc.name)}first ${ms(sc.firstCommitMs)} · 50% ${ms(sc.desired50Ms)} · 90% ${ms(sc.desired90Ms)} · reconverge ${Math.round(sc.reconvergeMs)} ms${sc.timedOut ? '  ⚠ TIMED OUT' : ''}`,
      `${pad('')}${sc.requests} req · ${mb(sc.bytesDownloaded)} MB (wire ${mb(sc.wireBytes)}) · committed ${sc.committed} · cancelled ${sc.cancelled} · discarded ${sc.discarded} · desired ${sc.desiredCount}`,
    ]),
    '==================',
  ].join('\n');
}

/** Full-resolution frames per phase, collected by the runner for PSNR / detail comparison. */
const frames: Record<string, { png: string; gray: string; w: number; h: number }> = {};
(window as unknown as { __KILN_BENCH_FRAMES?: typeof frames }).__KILN_BENCH_FRAMES = frames;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Capture the converged frame: hash + thumbnail in the report, full-res frame for the runner. */
async function signImage(v: BenchViewer, phase: string): Promise<ImageSignature | null> {
  try {
    const blob = await v.captureImage();
    const bmp = await createImageBitmap(blob);
    const full = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = full.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const gray = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = Math.round(px[i]! * 0.299 + px[i + 1]! * 0.587 + px[i + 2]! * 0.114);
    let bin = '';
    for (let i = 0; i < gray.length; i += 0x8000) bin += String.fromCharCode(...gray.subarray(i, i + 0x8000));
    frames[phase] = { png: await blobToDataUrl(blob), gray: btoa(bin), w: bmp.width, h: bmp.height };
    const digest = await crypto.subtle.digest('SHA-256', px);
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    const small = new OffscreenCanvas(64, 40);
    const sctx = small.getContext('2d')!;
    sctx.drawImage(bmp, 0, 0, 64, 40);
    const sp = sctx.getImageData(0, 0, 64, 40).data;
    const thumb: number[] = [];
    for (let i = 0; i < sp.length; i += 4) thumb.push(Math.round((sp[i]! * 0.299 + sp[i + 1]! * 0.587 + sp[i + 2]! * 0.114)));
    bmp.close();
    return { hash, thumb };
  } catch {
    return null;
  }
}

/** Camera targets per scenario, relative to the start state; glide-* are animated versions. */
function scenarioCamera(name: string, start: OrbitState, current: OrbitState): OrbitState | null {
  const [rx, ry, dist, tx, ty, tz] = current;
  switch (name) {
    case 'zoom':
    case 'glide-zoom': return [rx, ry, Math.max(0.1, dist / 3), tx, ty, tz];
    case 'pan':
    case 'glide-pan':  return [rx, ry, dist, tx + 0.15, ty, tz];
    case 'orbit':  return [rx, ry + (35 * Math.PI) / 180, dist, tx, ty, tz];
    case 'tilt':   return [rx + (25 * Math.PI) / 180, ry, dist, tx, ty, tz];
    case 'return': return start;
    default:       return null;
  }
}

/** Bytes served by the bench proxy so far; NaN outside the proxy (direct mode serves plain http). */
async function proxyBytes(): Promise<number> {
  if (location.protocol !== 'https:') return NaN;
  try {
    const r = await fetch('/__bench/stats', { cache: 'no-store' });
    return ((await r.json()) as { bytes: number }).bytes;
  } catch {
    return NaN;
  }
}

/** Apply one camera scenario (jump, or animated for glide-*) and measure how streaming recovers. */
async function runScenario(v: BenchViewer, name: string, target: OrbitState, timeoutMs: number, stablePolls: number): Promise<ScenarioReport> {
  const s0 = v.streamingManager.getStats();
  const wire0 = await proxyBytes();
  const motionMs = name.startsWith('glide-') ? 2500 : 0;
  const from = v.camera.getOrbitState();
  const t0 = performance.now();
  let moving = motionMs > 0;
  let stopAt = t0;
  if (moving) {
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / motionMs);
      v.camera.setOrbitState(from.map((a, i) => a + (target[i]! - a) * k) as OrbitState);
      if (k < 1) requestAnimationFrame(step);
      else { moving = false; stopAt = performance.now(); }
    };
    requestAnimationFrame(step);
  } else {
    v.camera.setOrbitState(target);
  }

  let firstCommitMs: number | null = null;
  let desired50Ms: number | null = null;
  let desired90Ms: number | null = null;
  let stable = 0;
  let timedOut = true;
  let peakPending = 0;
  const deadline = t0 + timeoutMs;
  while (performance.now() < deadline) {
    const s = v.streamingManager.getStats();
    const now = performance.now() - t0;
    if (firstCommitMs === null && s.bricksCommitted > s0.bricksCommitted) firstCommitMs = now;
    // Progress = pending work drained relative to its peak after the camera change.
    if (s.pendingCount > peakPending) { peakPending = s.pendingCount; desired50Ms = null; desired90Ms = null; }
    if (peakPending > 0) {
      if (desired50Ms === null && s.pendingCount <= peakPending * 0.5) desired50Ms = now;
      if (desired90Ms === null && s.pendingCount <= peakPending * 0.1) desired90Ms = now;
    }
    const idle = !moving && s.pendingCount === 0 && v.renderer.isConverged;
    stable = idle ? stable + 1 : 0;
    if (stable >= stablePolls) { timedOut = false; break; }
    await sleep(POLL_MS);
  }
  const reconvergeMs = performance.now() - t0;
  const wire1 = await proxyBytes();
  const s1 = v.streamingManager.getStats();
  if (peakPending === 0) { desired50Ms = 0; desired90Ms = 0; } // nothing new was needed
  return {
    name,
    firstCommitMs,
    desired50Ms,
    desired90Ms,
    reconvergeMs,
    motionMs,
    afterStopMs: t0 + reconvergeMs - stopAt,
    wireBytes: wire1 - wire0,
    timedOut,
    requests: s1.requestCount - s0.requestCount,
    bytesDownloaded: s1.totalBytesDownloaded - s0.totalBytesDownloaded,
    committed: s1.bricksCommitted - s0.bricksCommitted,
    cancelled: s1.bricksCancelled - s0.bricksCancelled,
    discarded: s1.bricksDiscarded - s0.bricksDiscarded,
    desiredCount: s1.desiredCount,
    peakPending,
    chunkCacheHitRatio: s1.pipelineTimings.chunkCacheHitRatio ?? 0,
    image: timedOut ? null : await signImage(v, name),
  };
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

  const settled = await waitForConverged(viewer, timeoutMs, stablePolls);
  // performance.now() is ms since page navigation start, so this is the full
  // open→converge wall-clock (WebGPU init + metadata + base load + refinement).
  const convergeMs = performance.now();
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
    avgBrickLatencyMs: s.avgBrickLatencyMs,
    chunkCacheHitRatio: s.pipelineTimings.chunkCacheHitRatio ?? 0,
    timings: {
      queueMs: s.pipelineTimings.avgQueueMs,
      fetchMs: s.pipelineTimings.avgFetchMs,
      assemblyMs: s.pipelineTimings.avgAssemblyMs,
      uploadMs: s.pipelineTimings.avgUploadMs,
    },
    userAgent: navigator.userAgent,
  };

  if (settled) report.image = await signImage(viewer, 'load');
  const scenarioNames = (params.get('benchScenarios') ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (scenarioNames.length > 0 && settled) {
    const start = viewer.camera.getOrbitState();
    report.scenarios = [];
    for (const name of scenarioNames) {
      const target = scenarioCamera(name, start, viewer.camera.getOrbitState());
      if (!target) continue;
      report.scenarios.push(await runScenario(viewer, name, target, timeoutMs, stablePolls));
    }
  }

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
