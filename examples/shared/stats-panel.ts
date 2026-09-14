/**
 * Shared telemetry: an always-on status strip (streaming state + dataset info)
 * plus the full diagnostics panel, gated behind a debug trigger (click the
 * strip, press 'd', or load with ?debug=1) — IA-5. Dependency-free (Phase 3
 * — Tweakpane removed from user-facing UI entirely, including this panel).
 */

import type { StreamingManager } from '@kiln/streaming/streaming-manager.js';
import type { VolumeMetadata } from '@kiln/data/data-provider.js';
import type { LoadMilestones } from '@kiln/core/milestones.js';
import { createPanel, createSection, createRow } from './controls/widgets.js';

export interface DatasetInfoOptions {
  /** Multiplies the raw-size estimate — multichannel viewers store N channels per voxel. */
  fileSizeChannelMultiplier?: number;
  /** Append the compression codec to the LODs line, when known. */
  includeCodec?: boolean;
}

export class StatsPanel {
  private debugContainer: HTMLElement;
  private debugVisible = false;

  private rows: Record<string, HTMLElement> = {};

  private frameTimes: number[] = [];
  private lastFrameTime = 0;
  private streamingManager: StreamingManager | null = null;
  private milestones: (() => LoadMilestones) | null = null;
  private statsUpdateInterval: number | null = null;

  private stripDot: HTMLElement | null = null;
  private stripStreamText: HTMLElement | null = null;
  private stripDatasetText: HTMLElement | null = null;

  /** `debugContainer` hosts the full diagnostics panel — hidden until a debug trigger fires. */
  constructor(debugContainer: HTMLElement) {
    this.debugContainer = debugContainer;
    this.debugContainer.style.display = 'none';

    this.buildDebugPanel();
    this.mountStatusStrip();
    this.wireDebugTriggers();
  }

  private addRow(section: HTMLElement, key: string, label: string): void {
    const { el, valueEl } = createRow(label);
    section.appendChild(el);
    this.rows[key] = valueEl;
  }

  private buildDebugPanel(): void {
    const { el: panelEl, body } = createPanel('Stats');
    this.debugContainer.appendChild(panelEl);

    const perf = createSection('Performance');
    body.appendChild(perf);
    this.addRow(perf, 'fps', 'FPS');
    this.addRow(perf, 'frameTime', 'Frame');
    this.addRow(perf, 'firstContent', 'First Content');

    const dataset = createSection('Dataset');
    body.appendChild(dataset);
    this.addRow(dataset, 'dimensions', 'Size');
    this.addRow(dataset, 'fileSize', 'File Size');
    this.addRow(dataset, 'spacing', 'Spacing');
    this.addRow(dataset, 'lodLevels', 'LODs');
    this.addRow(dataset, 'textureFormat', 'Format');

    const streaming = createSection('Streaming');
    body.appendChild(streaming);
    this.addRow(streaming, 'cacheUsage', 'Cache');
    this.addRow(streaming, 'pendingBricks', 'Pending');
    this.addRow(streaming, 'evictedBricks', 'Evicted');
    this.addRow(streaming, 'throughput', 'Throughput');
    this.addRow(streaming, 'totalDownloaded', 'Downloaded');
    this.addRow(streaming, 'brickLatency', 'Latency');

    const pipeline = createSection('Pipeline');
    body.appendChild(pipeline);
    this.addRow(pipeline, 'pipelineQueue', 'Queue');
    this.addRow(pipeline, 'pipelineFetch', 'Fetch');
    this.addRow(pipeline, 'pipelineAssembly', 'Assembly');
    this.addRow(pipeline, 'pipelineUpload', 'Upload');
    this.addRow(pipeline, 'brickLifecycle', 'Lifecycle');
    this.addRow(pipeline, 'wastedRate', 'Wasted');
    this.addRow(pipeline, 'chunkCacheHit', 'Cache hit');
  }

  private mountStatusStrip(): void {
    const strip = document.createElement('div');
    strip.className = 'status-strip';
    strip.title = 'Click for diagnostics (or press d)';
    strip.innerHTML = `
      <div class="status-strip-left">
        <span class="status-dot"></span>
        <span class="status-stream-text">idle</span>
      </div>
      <div class="status-strip-right">
        <span class="status-dataset-text"></span>
      </div>
    `;
    document.body.appendChild(strip);
    strip.addEventListener('click', () => this.setDebugVisible(!this.debugVisible));

    this.stripDot = strip.querySelector('.status-dot');
    this.stripStreamText = strip.querySelector('.status-stream-text');
    this.stripDatasetText = strip.querySelector('.status-dataset-text');
  }

  private wireDebugTriggers(): void {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') this.setDebugVisible(true);

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'd' && e.key !== 'D') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      this.setDebugVisible(!this.debugVisible);
    });
  }

  private setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    this.debugContainer.style.display = visible ? '' : 'none';
  }

  /** Sets the static (dataset-level) info fields and starts the periodic update loop. */
  setDatasetInfo(
    metadata: VolumeMetadata,
    textureFormat: GPUTextureFormat,
    opts: DatasetInfoOptions = {},
  ): void {
    const dims = metadata.dimensions;
    const chSuffix = metadata.numChannels > 1 ? ` × ${metadata.numChannels}ch` : '';
    this.rows.dimensions!.textContent = `${dims[0]} × ${dims[1]} × ${dims[2]}${chSuffix}`;

    const totalVoxels = dims[0] * dims[1] * dims[2];
    const bytesPerVoxel = metadata.bitDepth === 16 ? 2 : 1;
    const channelMultiplier = opts.fileSizeChannelMultiplier ?? 1;
    const fileSizeMB = (totalVoxels * bytesPerVoxel * channelMultiplier) / (1024 * 1024);
    this.rows.fileSize!.textContent = `${fileSizeMB.toFixed(1)} MB (raw ${metadata.bitDepth}-bit)`;

    const spacing = metadata.voxelSpacing ?? [1, 1, 1];
    this.rows.spacing!.textContent = `${spacing[0].toFixed(2)} × ${spacing[1].toFixed(2)} × ${spacing[2].toFixed(2)}`;

    const codec = opts.includeCodec ? metadata.compression : undefined;
    this.rows.lodLevels!.textContent = `${metadata.levels.length} (LOD 0-${metadata.maxLod})${codec ? ` · ${codec}` : ''}`;

    this.rows.textureFormat!.textContent = textureFormat + (textureFormat === 'r8unorm' && metadata.bitDepth === 16 ? ' (⚠️ downsampled)' : '');

    const stripSummary = `${dims[0]}×${dims[1]}×${dims[2]}${chSuffix} · ${metadata.bitDepth}-bit`;
    if (this.stripDatasetText) this.stripDatasetText.textContent = stripSummary;
  }

  /** Wires the streaming manager (and optional milestone source) and starts the 4×/s update loop. */
  bindStreaming(manager: StreamingManager, milestones?: () => LoadMilestones): void {
    this.streamingManager = manager;
    this.milestones = milestones ?? null;
    if (this.statsUpdateInterval !== null) return;
    this.statsUpdateInterval = window.setInterval(() => this.updateStats(), 250); // 4x/s
  }

  private updateStats(): void {
    if (this.frameTimes.length > 0) {
      const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      this.rows.fps!.textContent = `${(1000 / avgFrameTime).toFixed(1)}`;
      this.rows.frameTime!.textContent = `${avgFrameTime.toFixed(2)} ms`;
    }

    if (this.streamingManager) {
      const stats = this.streamingManager.getStats();

      // Streaming
      const atlasPercent = ((stats.atlasUsage / stats.atlasCapacity) * 100).toFixed(0);
      this.rows.cacheUsage!.textContent = `${stats.atlasUsage}/${stats.atlasCapacity} (${atlasPercent}%)`;
      this.rows.pendingBricks!.textContent = `${stats.pendingCount}`;
      this.rows.evictedBricks!.textContent = `${stats.evictedCount}`;
      const throughputMBps = stats.bytesPerSecond / (1024 * 1024);
      this.rows.throughput!.textContent = `${throughputMBps.toFixed(2)} MB/s`;
      const totalMB = stats.totalBytesDownloaded / (1024 * 1024);
      this.rows.totalDownloaded!.textContent = `${totalMB.toFixed(2)} MB`;
      this.rows.brickLatency!.textContent = stats.avgBrickLatencyMs > 0 ? `${stats.avgBrickLatencyMs.toFixed(1)} ms` : '—';

      // Pipeline
      const pt = stats.pipelineTimings;
      this.rows.pipelineQueue!.textContent = pt.sampleCount > 0 ? `${pt.avgQueueMs.toFixed(1)} ms` : '—';
      this.rows.pipelineFetch!.textContent = pt.sampleCount > 0 ? `${pt.avgFetchMs.toFixed(1)} ms` : '—';
      this.rows.pipelineAssembly!.textContent = pt.sampleCount > 0 ? `${pt.avgAssemblyMs.toFixed(1)} ms` : '—';
      this.rows.pipelineUpload!.textContent = pt.sampleCount > 0 ? `${pt.avgUploadMs.toFixed(1)} ms` : '—';
      const d = stats.bricksDispatched;
      const c = stats.bricksCommitted;
      const x = stats.bricksCancelled;
      const w = stats.bricksDiscarded;
      this.rows.brickLifecycle!.textContent = `D:${d} C:${c} X:${x} W:${w}`;
      const wastedDenom = c + w;
      this.rows.wastedRate!.textContent = wastedDenom > 0 ? `${((w / wastedDenom) * 100).toFixed(1)}%` : '—';
      const hitRatio = pt.chunkCacheHitRatio;
      this.rows.chunkCacheHit!.textContent = hitRatio !== undefined ? `${(hitRatio * 100).toFixed(1)}%` : '—';

      // Dataset open → first frame with resident data (presentation proxy, else submit)
      const m = this.milestones?.();
      const firstContent = m?.firstContentFrame ?? m?.firstContentSubmit ?? null;
      this.rows.firstContent!.textContent = m && firstContent !== null
        ? `${(firstContent - m.datasetOpenStart).toFixed(0)} ms`
        : 'Loading...';

      // Status strip — always-on subset (IA-5). The center spinner only covers
      // the pre-first-render phase; ongoing streaming activity lives here.
      const isActive = stats.pendingCount > 0;
      this.stripDot?.classList.toggle('active', isActive);
      if (this.stripStreamText) {
        this.stripStreamText.textContent = isActive
          ? `Streaming ${stats.pendingCount} bricks · ${throughputMBps.toFixed(1)} MB/s`
          : 'Idle';
      }
    }
  }

  /** Record a frame time for performance tracking. Call once per frame from the render loop. */
  recordFrame(): void {
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      const delta = now - this.lastFrameTime;
      this.frameTimes.push(delta);
      // Keep last 60 frames for averaging
      if (this.frameTimes.length > 60) {
        this.frameTimes.shift();
      }
    }
    this.lastFrameTime = now;
  }
}
