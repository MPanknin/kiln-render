# Volume Renderer "Kiln" — Audit v3.1 (handover document)

Scope: Standalone handover for continuing performance/correctness work on Kiln, a WebGPU brick-streaming volume renderer. This document is self-contained — a fresh agent with no prior conversation history can resume from it. It records (a) which v2-audit items are done and verified against source, (b) which fixes were **implemented and delivered as copy-paste files in the last session but not yet verified in a running build**, (c) open items with full specs, and (d) the agreed architecture/feature roadmap (multichannel scaling, advanced WebGPU features, new render modes).

How to use this document: First read "Session state & deliverables" and "File manifest" below, then work Parts A → E in order unless stated otherwise. Each item states problem, affected files, concrete fix, and acceptance criteria. [BUG] = correctness; [PERF] = performance; [QUALITY] = image quality; [ARCH] = structural. v2 priority numbers are referenced as P1…P17 for traceability.

## Architecture summary (context for a fresh agent)
Front-to-back DVR ray marcher over a virtual-textured volume. Bricks are 64³ logical / 66³ physical (1-voxel ghost border) packed into 660³ atlas textures (one per channel, currently capped at 4; r8unorm or r16float). A flat rgba8uint 3D indirection texture at LOD0-brick granularity maps virtual bricks → atlas slots; the w component encodes lod+1 (0 = unloaded, 255 = known-empty). Streaming: SSE-based LOD selection with frustum culling in `StreamingManager`, LRU atlas eviction with parent-LOD fallback (`AtlasAllocator` + `IndirectionTable`), CPU-side brick LRU cache (`BrickCache`), pinned coarsest ("base") LOD loaded first.

Data source is OME-Zarr (NGFF v0.5) over HTTP via zarrita. A pool of ≤8 Web Workers (`ZarrWorkerPool` / `zarr-chunk-worker`) runs the full fetch → decompress (blosc/zstd/lz4) → assemble-66³-brick → min/max/avg stats pipeline; assembled bricks transfer zero-copy to the main thread, which only does `queue.writeTexture`. Each worker holds a 128 MB LRU chunk cache with in-flight dedup; dispatch uses a spatial-affinity hash; each worker's `TolerantFetchStore` has a 6-slot fetch semaphore, maps 403/404 → "missing", and retries 5xx/network errors with backoff (throws on exhaustion).

Rendering (`Renderer` + WGSL modules assembled in `shaders/index.ts`): compute-shader ray march at renderScale ∈ {0.25, 0.5, 1.0} (0.25 forced during camera interaction, with 200 ms hysteresis; per-scale resources preallocated as `ScaleSet`s) → temporal accumulation (rgba16float ping-pong, frame-count-weighted running average, camera-move reset, 64-frame cap) → merged blit+overlay render pass (`loadOp:'clear'`, depth `discard`). LOD-adaptive step size with exact Beer-Lambert compositing via exp2; per-brick affine atlas transform replaces fmod/divides in the hot loop; jitter phase preserved across skipped bricks. The frame loop (`KilnViewer.frame`) is render-on-demand: renders only when dirty / interacting / streaming active / not converged.

---

## Status ledger (v2 → current source)

**Done, verified:** P1 (rgba16float accumulation, all three textures + both WGSL storage declarations). P4 (5xx/network retry with backoff, throw on exhaustion; cache-poisoning fixed by construction). P7 + P13a/b/c/e (LOD-adaptive stepping, affine atlas transform, extinction hoist + exp2, jitter-phase preservation, scale-sensitive epsilon — verified mathematically equivalent). P8a/b (merged blit+overlay pass with `loadOp:'clear'`, depth `discard`). P10a/b/c (touch pan/pinch in `isInteracting`, unified 200 ms `lastInteractionTime` hysteresis, per-scale `ScaleSet` preallocation). P14c (`hasEmptyAncestor` on eviction; bonus: `setEmpty` refuses to overwrite loaded cells). P16a (high-performance adapter), P16b (debounced resize), P16c (worker cache LRU refresh), P16e (camera matrix scratch buffers). P2 core plumbing (dirty flag, `onDirty`, `isConverged`, streaming return value consumed, `getCurrentTexture` skipped when clean) — but see A1 for gaps. P5 streaming path via post-fetch `isBrickEmpty` re-check — but see A3 for gaps.

**Open, unchanged from v2:** P3, P6, P8c, P11, P12, P13d (ortho jitter — only if an orthographic camera mode is added: `rayToSeed(rayDir)` is direction-only, so under ortho all rays share one jitter value → full-screen banding; seed from pixel coordinates instead, e.g. `hash(px + py*9781u + frameIndex*26699u)`), P13f (comment), P14a, P14b, P14d misc, P15, P16d, P16f (the `DecompressionPool` gzip path for the sharded provider duplicates the uint16→float16 conversion logic — extract the shared conversion if both providers live on, delete if superseded), P17 all.

**New findings from this review:** A1.1–A1.4, A2.2, A3.1–A3.3, B7.1–B7.3 below.

**Implemented last session, delivered as files, NOT yet verified in a running build:** A1.1, A1.2, A1.3, A1.4 (decision taken: jitter gated on TAA), A2.1, A2.2, A3.1, A3.2, A3.3, B1, B7.1, B7.2. The full specs remain in Parts A/B below as the verification reference. **First task on resume: confirm these were integrated (diff against the deliverables), compile, and run the 9-point verification checklist in `PATCHES.md`.**

---

# Session state & deliverables (last session)

Four files were handed to the project owner for copy-paste integration. Whether they have been integrated by the time you read this is unknown — verify first.

**Full drop-in replacements:**
- `streaming-manager.ts` — implements A1.1 (base-LOD bricks fire the debounced accumulation reset; direct reset on base-LOD completion), A2.1 (`clear()` uses `allocator.reset()` instead of per-slot frees), A2.2 (backpressure: `allocationStalled` flag cleared each `computeDesiredSet`, pre-dispatch `hasEvictableSlot` check in `processLoadQueue`, silent allocation refusal), A3.1 (post-fetch emptiness re-check in `loadBaseLod` before allocation/pinning), A3.2 (`brickCache.put` moved after the empty re-check, with `fromCache[]` tracking), A3.3 (ch0-mandatory channel policy; failed channels zero-filled via cached `getZeroBrick(bitDepth)` to clear stale evicted-slot data), B1 (`public renderScale` scales `projectionFactor`). New public surface: `StreamingManager.renderScale`, `StreamingStats.allocationsRefused`.
- `atlas-allocator.ts` — `free()` now unpins (A2.1); new `hasEvictableSlot(currentFrame)` helper (free slot exists, or `findLRUSlot` would succeed).
- `tolerant-fetch-store.ts` — `getRange` now goes through the fetch semaphore and the shared retry/backoff schedule, preserving the 403 → undefined tolerance (B7.2).

**Patch document `PATCHES.md`** — six exact find/replace edits:
- `camera.ts`: monotonic `version_` counter incremented in `updatePosition()` + public `version` getter (A1.2 — catches programmatic `setOrbitState`/`setUpAxis`/`resetPan`).
- `renderer.ts`: `isConverged` returns true for slice mode (A1.3 — slice mode previously never converged and defeated render-on-demand); jitter uniform gated on `enableJitter && enableTAA` (A1.4 decision — TAA-off must freeze a clean frame, not a jittered one).
- `kiln-viewer.ts`: `lastCameraVersion` field + per-frame version check sets `dirty`; `streamingManager.renderScale = renderer.renderScale` sync each frame (B1 wiring); `prepareScale(this.userRenderScale)` in `resize()` (B7.1); `renderScale` setter calls `prepareScale` + sets `dirty`.
Plus a 9-point verification checklist mapping to the acceptance criteria of every delivered item.

**Integration caveats to check on resume:**
1. `StreamingStats.allocationsRefused` is a new field — any UI that consumes stats exhaustively needs a one-line addition.
2. Two APIs were inferred from call sites, never seen in source: `BrickCache.get/put` and `VolumeCanvas.bitDepth`. A compile pass confirms; if signatures differ, the fixes are confined to `getZeroBrick` and the `fromCache` block in `streaming-manager.ts`.
3. The delivered `streaming-manager.ts` was written against the version reviewed last session. If the owner has since edited that file, merge rather than overwrite.

---

# File manifest — what a fresh instance needs

**Category 1 — reviewed last session, request current versions on resume** (they contain the delivered changes, or should — and may have drifted): `streaming-manager.ts`, `atlas-allocator.ts`, `tolerant-fetch-store.ts`, `camera.ts`, `kiln-viewer.ts`, `renderer.ts`, `indirection.ts`, `zarr-provider.ts`, `zarr-worker-pool.ts`, `zarr-chunk-worker.ts`, `volume.ts`, `shaders/index.ts`, `sampling.wgsl`, `raymarching.wgsl`, `dvr.wgsl`, `compositing.wgsl`, `accumulate.wgsl`.

**Category 2 — never seen, required for the next work batch** (unlocks B2, B3, B4, B5, B6, C2, C3, C4, P14a/b, and anything adding uniform fields):
- `data-provider.ts` — DataProvider interface, BrickData, PipelineTimings (needed by B2 signal plumbing, C3 stats return type)
- `base-zarr-provider.ts` — `isBrickEmpty`, `cacheBrickStats`, `scanFloatRange`, `scanChannelRanges`, `recordDownload` (needed by C3, B5, B6)
- `shaders/uniform-layout.js` (or `.ts`) — COMPUTE_UNIFORMS / SLICE_UNIFORMS field descriptions and offsets (needed by C4, B7.4, P8c, all Part E modes)
- `network-tracker.ts` — RollingAvg, network stats (needed by B6)
- `brick-cache.ts` — confirms the inferred get/put API; needed by C2 and the C1 cache-key change
- `core/config.ts` — CONFIG, DatasetConfig, GRID_SIZE, ATLAS_SIZE, emptyBrickThreshold (needed by C1 atlas sizing, C4 override constants)

**Category 3 — never seen, required for C1 (packed atlas) and Part E (render modes):** `volume-resources.ts`, `common.wgsl`, `mip.wgsl`, `iso.wgsl`, `blit.wgsl`, `slice-planes.wgsl`, `utils/float16.ts`, `sharded-provider.ts`.

**Not needed** (unless the roadmap changes): `lod-debug.wgsl`, `wireframe.wgsl`, `axis.wgsl`, `geometry.ts`, `zarr-validator.ts`, `transfer-function.ts` (needed only when E1's 2D TF UI starts), `decompression-pool.ts` (only if P16f is pursued), `main.ts`/UI layer.

**Ready-to-implement queue once Category 2 arrives** (in order): B3 — assembly-loop rewrite, with a Node-side synthetic byte-identity harness (replicate old and new loops against randomized chunk layouts covering scale ≠ 1, partial edge chunks, and the float32 path; assert byte equality before delivery); B4 — affinity coarsening + per-worker queue-depth spill; P14a — indirection dirty-region flush + one `flush()` call in `renderCompute`; B2 — worker-side cancellation (note: adds an optional `AbortSignal` parameter to `DataProvider.loadBrick`); then C2 + C3 as one streaming-manager refactor.

---

# Part A — Correctness: regressions and remainders (delivered last session — verify on resume)

## A1 — [BUG] Render-on-demand gaps: the dirty flag misses real scene changes
Files: `streaming-manager.ts` (loadBaseLod), `kiln-viewer.ts` (frame), `camera.ts` (setOrbitState/setUpAxis/resetPan), `renderer.ts` (isConverged, renderCompute)

The P2 implementation is structurally right but leaks four cases where the scene changes and no render happens (or the inverse):

**A1.1 — Base LOD arrival never dirties.** `loadBaseLod` uploads bricks and writes indirection but never calls `scheduleAccumulationReset()` or `markDirty()`. During initial load the viewer renders a near-empty scene, converges at 64 frames, and freezes. Worse: when `baseLodLoaded` flips true and the base LOD *is* the desired set (zoomed-out view), `update()` returns false (empty queue, nothing in flight) — the fully loaded volume is never displayed until the user moves the camera.
Fix: in `processBrick` inside `loadBaseLod`, call `this.scheduleAccumulationReset()` after each successful upload (the 100 ms debounce coalesces the burst), and unconditionally call `this.onResetAccumulation()` once when `baseLodLoaded` is set true.
Acceptance: cold-load with a static camera → image progressively appears and refines with zero input; final frame shows the full base LOD.

**A1.2 — Programmatic camera changes don't render.** `setOrbitState`, `setUpAxis`, `resetPan` update position but not `lastInteractionTime`; the frame loop only checks `isInteracting()` and `dirty`. The renderer's `vpChanged` detection would catch it — but it lives inside `render()`, which never runs. A share-URL restore or a UI "reset view" button silently shows a stale frame.
Fix (pick one): (a) have those three camera methods update `lastInteractionTime` — smallest diff; or (b) hoist a cheap VP-hash comparison into `frame()` as v2 originally suggested — more robust, catches any future mutation path. Prefer (b).
Acceptance: with a static mouse, calling `viewer.camera.setOrbitState(...)` from the console re-renders within one frame.

**A1.3 — Slice mode never converges → renders every frame forever.** In slice mode the compute + accumulation passes are skipped, so `accumFrameCount` never advances; with TAA enabled `isConverged` is false forever, so `needsRender` is true every rAF — render-on-demand is fully defeated in slice mode (continuous full-pipeline rendering of a static image).
Fix: `isConverged` must account for mode: slice mode has no accumulation, so it is converged after one frame — `return this.volumeRenderMode === 'slice' || !this.enableTAA || this.active.accumFrameCount >= 64;` (slice parameter setters already go through `resetAccumulation` → `onDirty`, so slider changes still render).
Acceptance: switch to slice mode, hold still → GPU utilization drops to ~0; moving a slice slider re-renders immediately.

**A1.4 — [decision needed] TAA-off freezes one jittered frame.** `isConverged` returns true when `enableTAA` is false, so with jitter on / TAA off the display freezes on a single noisy frame instead of animating noise (v2 suggested the opposite). Either behavior is defensible; the current one saves power. Decide and document. If keeping it, consider auto-disabling jitter when TAA is off so the frozen frame is at least clean: `jitter = enableJitter && enableTAA` when writing uniforms.

## A2 — [BUG] Allocator lifecycle: pinned-slot leaks and missing backpressure (P9 remainder)
Files: `atlas-allocator.ts` (free, reset), `streaming-manager.ts` (clear, processLoadQueue, loadBrick)

The `MIN_EVICTION_AGE = 30` thrash guard is in and `findLRUSlot` can return −1. Two pieces of P9 remain, one of them now compounded:

**A2.1 — `free()` doesn't unpin (v2 P9), now compounded by `clear()`.** `free()` returns a slot to the free list but leaves it in `pinned`; after reuse, `findLRUSlot` skips it forever. `StreamingManager.clear()` makes this systematic: it frees *all* slots — including every pinned base-LOD slot — without touching the pinned set, then reloads the base LOD into fresh slots. After one dataset clear, up to a full base LOD's worth of slot indices are permanently unevictable.
Fix: add `this.pinned.delete(idx)` in `free()`; and in `StreamingManager.clear()`, replace the per-slot free loop with `this.resources.allocator.reset()` (it exists and does exactly this).
Acceptance: call `clear()` twice on a dataset whose base LOD is a significant fraction of the atlas; `pinnedCount` after each reload equals the base-LOD brick count (not 2×, 3×…).

**A2.2 — No load-queue backpressure on allocation failure.** When `allocate()` returns null, `loadBrick` warns and returns — but `processLoadQueue` keeps draining, so every queued brick is still fully fetched, decompressed, assembled, and transferred before failing allocation. Under atlas pressure this is the full network + worker cost for zero pixels.
Fix (as v2 P9): drop the `console.warn`; signal refusal to the caller (return a sentinel or set a flag), and in `processLoadQueue` stop draining for this frame on the first refusal. Refused bricks stay desired and retry next update; the shader falls back to the resident parent via indirection, so refusal is visually free. Ideally check `allocator.freeCount`/evictability *before* dispatching the fetch, not after the data arrives — the cheapest brick is the one never requested.
Acceptance: shrink the atlas below demand, zoom into a dense region, hold still: loading settles; network traffic stops; no warn-spam; accumulation converges.

## A3 — [BUG][PERF] Empty-brick and channel-failure handling inconsistencies (P5 remainder)
Files: `streaming-manager.ts` (loadBaseLod, loadBrick), `brick-cache.ts` interaction, `data-provider.ts` (interface)

**A3.1 — Base LOD never re-checks emptiness post-fetch; empty bricks get pinned forever.** The streaming path re-calls `isBrickEmpty` after the fetch (when stats are cached) — good. `loadBaseLod` does not: its only check is pre-fetch (always false on cold load), so on sparse datasets every empty base brick is fetched, uploaded, allocated, **and pinned** — permanently occupying atlas capacity for bricks that render nothing. This is the exact sparse-microscopy waste case P5 targeted, made worse by pinning.
Fix: mirror the streaming path — after `channelData` resolves in `processBrick`, re-check `isBrickEmpty`; if empty, `emptyBricks.add`, `indirection.setEmpty`, and return *before* allocation. (Better: see C3 — have `loadBrick` return stats and check `max < emptyBrickThreshold` directly, deleting both async round-trips.)
Acceptance: cold-load a sparse dataset: pinned count equals non-empty base bricks; `atlasUsage` proportional to occupancy.

**A3.2 — CPU brick cache polluted with empty bricks.** In `loadBrick`, channel data is `brickCache.put(...)` inside the fetch closure, *before* the empty re-check. Empty bricks evict useful entries from the 256 MB/channel budget.
Fix: buffer the fetched channels locally; only `put` after the brick is known non-empty (and after the desired-set check, while at it — a brick fetched but no longer desired is still worth caching, so put after the empty check but before the desired check).

**A3.3 — Any-channel failure drops the whole brick (inconsistent with base LOD).** `loadBrick`: `if (signal.aborted || channelData.some(d => !d)) return;` — one failed channel out of four discards all four. `loadBaseLod` instead treats ch0 as mandatory and degrades gracefully on the rest. One transient failure on ch3 costs the brick entirely (and the successful channels' bandwidth); the failure also isn't recorded, so the brick silently retries on the next desired-set pass — acceptable, but wasteful.
Fix: adopt the base-LOD rule in `loadBrick`: require ch0, upload whatever channels succeeded (missing channels read as zero at that slot — the slot memory may contain stale data from a previous brick, so zero-fill or re-upload the failed channel's region… simplest correct option: `writeToCanvas` a cached zero brick for failed channels). Unify via C2 so this policy lives in one place.
Acceptance: block one channel's chunks in devtools: bricks render with remaining channels; no whole-brick holes.

---

# Part B — Performance (carried forward + new)

## B1 — [PERF] SSE LOD selection ignores render scale (P3 — DELIVERED last session, verify on resume)
File: `streaming-manager.ts` (computeDesiredSet)
Still `this.projectionFactor = canvas.height / (2 * Math.tan(...))`. One line:
`this.projectionFactor = (canvas.height * this.renderer.renderScale) / (2 * Math.tan(this.cameraFovRad / 2));`
(Requires the streaming manager to see the renderer's current scale — pass the renderer or the scale into `update()`.) Now that P7 is implemented this *multiplies*: coarser bricks × larger steps during interaction. Acceptance: camera moving at renderScale 0.25 → streaming stats show substantially smaller `desiredCount` than at 1.0 for the same view; on stop, the camera-stopped path re-runs `computeDesiredSet` and fine bricks stream in.

## B2 — [PERF] Worker request cancellation never reaches the network (new)
Files: `zarr-worker-pool.ts`, `zarr-chunk-worker.ts`, `streaming-manager.ts`, `tolerant-fetch-store.ts`
`controller.abort()` in the streaming manager only gates post-arrival handling; `workerPool.loadBrick` has no cancellation, so every brick requested mid-gesture is fully fetched, decompressed, and assembled regardless. With B1 fixed the volume of stale requests drops, but gestures still waste bandwidth and worker slots on cancelled bricks.
Fix, in increasing depth: (1) `cancelBrick(id)` message → worker checks a cancelled-set before starting assembly and between pipeline stages; (2) plumb an `AbortSignal` into `TolerantFetchStore.get`'s `fetch(href, init)` (init already accepts `signal`) so in-flight HTTP aborts — but beware the in-flight dedup map: a shared chunk promise must only abort when *all* interested bricks cancelled (reference-count the inflight entry). Stage (1) alone captures most of the win.
Acceptance: rapid orbit gesture on a cold view, then stop: wire bytes (B6) for the gesture drop substantially vs. before; no errors from shared-chunk aborts.

## B3 — [PERF] Worker brick-assembly inner loop (P11 — unchanged)
File: `zarr-chunk-worker.ts` (assembleBrick)
Verified still present: 287k iterations × (string cacheKey + Map lookup + 3 divisions + Math.round/min/max ×3 + `Number()`), per brick per channel; per-voxel `float32ToFloat16Bits` on the float path. Fix exactly as v2 P11: three per-axis lookup tables (length 66) for `gx/cxi/lcx`; dense ≤3×3×3 chunk array resolved once; optional run-length inner loop with contiguous copy when `scaleX === 1`; float16 conversion as a flat post-pass (or native `Float16Array` with fallback). Instrument first (B6) so the ≥3–5× `avgAssemblyMs` claim is measured.
Acceptance: as v2 P11 — byte-identical bricks, integer-factor `avgAssemblyMs` drop.

## B4 — [PERF] Affinity hash coarsening + load-balance spill (P12 — unchanged)
File: `zarr-worker-pool.ts` (getAffinityWorker)
Verified still hashing the brick's center chunk. Fix as v2 P12: hash `(cx>>1, cy>>1, cz>>1, lod)`; add per-worker outstanding-request counters and spill to least-loaded when the affinity worker's queue exceeds a threshold. Do after B6 instrumentation so the duplicate-fetch reduction is measurable. Longer-term alternatives (server-side ghost borders P17g, SharedArrayBuffer cache) remain documented-not-scheduled.

## B5 — [PERF] Startup: coarsest LOD downloaded 1 + N_channels times (P15 — unchanged)
Files: `base-zarr-provider.ts`, `zarr-provider.ts`, `streaming-manager.ts`
Verified: `initialize()` still runs `scanFloatRange` and per-channel `scanChannelRanges` on the main thread before the workers re-fetch the same chunks in `loadBaseLod`. Fix as v2 P15: derive ranges from per-brick min/max the workers already compute (C3 makes this trivial — stats arrive with every brick); set preliminary windows from first arrivals, finalize when base LOD completes; keep scans only as fallback. Sequencing note: do after C3.
Acceptance: cold multichannel float load: bytes before first render ≈ 1× coarsest LOD.

## B6 — [PERF][INSTRUMENTATION] Wire-byte accounting and worker counters (P16d, expanded — prerequisite for B2/B3/B4)
Files: `tolerant-fetch-store.ts`, `zarr-chunk-worker.ts`, `zarr-worker-pool.ts`, `zarr-provider.ts`
`recordDownload(result.data.byteLength)` still counts decompressed assembled bricks. Fix: the fetch store returns byte counts per fetch (it has the `arrayBuffer`); the worker sums compressed bytes on cache misses per brick and returns them alongside timings; record that. Add three counters surfaced in `getPipelineTimings`/streaming stats: chunk-cache hit rate, duplicate-fetch count across workers (same key fetched by >1 worker within a window — needs a lightweight main-thread tally keyed on chunk key from worker reports), and cancelled-but-completed request count (for B2). These quantify B2/B3/B4 before and after.

## B7 — Small performance/consistency items
**B7.1** [DELIVERED] `kiln-viewer.ts`: `resize()` calls `prepareScale(0.25)` but not `prepareScale(this.userRenderScale)` — if the user scale ≠ constructor default (0.5), the first gesture-end after a resize builds a scale set on the spot (one-time allocation spike, exactly what P10c removed). Preallocate both. (In `PATCHES.md`, also added to the `renderScale` setter.)
**B7.2** [DELIVERED] `tolerant-fetch-store.ts`: `getRange` bypasses both the semaphore and the retry logic (delegates to inner `FetchStore`). Used by the sharded provider path; make it consistent (acquire slot; reuse the retry loop) or document why not. (Delivered: semaphore + retry around `inner.getRange`, 403 tolerance preserved.)
**B7.3** Retry-while-holding-semaphore: a failing endpoint holds a fetch slot for up to ~5.25 s of backoff, throttling healthy requests behind it. Acceptable for now; if flaky CDNs are common, release the slot during the backoff sleep and re-acquire.
**B7.4** `dvr.wgsl`: `maxDim` still computed per-ray from `datasetSize` — move to a uniform (P13b leftover, trivial).
**B7.5** P14a — indirection dirty-region flush: every `setBrick`/`setEmpty`/`clearBrick` currently issues its own `writeTexture` (including 4-byte single-cell writes); bursts spray dozens onto a texture sampled every frame. The class already keeps a full CPU mirror: track a dirty AABB across calls, expose `flush()`, call it once per frame from `renderCompute` before command encoding; upload the union region via the existing subregion-extraction loop (fall back to the full table if the dirty region exceeds ~50%). Side benefit: per-frame-atomic indirection updates eliminate one-frame inconsistency windows by construction. P14b — `computeDesiredSet` allocation diet: `levelsByLod[lod]` array instead of `levels.find(...)` per node, reusable AABB scratch objects, replace the reassigned-per-call `addDesiredBrick` closure property with a plain method, consider throttling to every 2–3 frames while moving. P14d leftovers: `accumulate.wgsl` compares `screenSize: vec2f` via `i32()` per thread → use `vec2u` vs `gid.xy` (moot if P8c lands); add a data-type vs texture-format assert in `writeToCanvas` (uint16 bytes into r16float = garbage; conversion lives in the worker, assert as insurance). P13f (documentation only): `composeSampleWindowed` culls on `windowedDensity > 0.01` before the TF lookup, so TF entries in [0, 0.01] are unreachable — if users colorize near-zero densities (haze/context), samples vanish silently; comment it, or cull on `tfColor.a` (costs the fetch always).
**B7.6** P8c — fuse accumulation into the main compute kernel (3 passes → 2): the main kernel reads the history accum texture and writes `mix(history, result, weight)` directly to the write-side accum texture, eliminating `computeOutputTexture` entirely and one full-screen read+write dispatch. Needs two compute bind-group configurations (ping-pong) — these slot naturally into `rebuildScaleSetBindGroups` since the ping-pong now lives per `ScaleSet` — and the blend weight folded into the main uniforms (written every frame anyway); `weight = 1.0` reproduces TAA-off exactly. Requires a new uniform field, so gated on C4 (or a separate small uniform buffer binding to avoid touching the main layout).

---

# Part C — Architecture consolidation (prerequisites for Parts D/E)

Verdict from review: the skeleton (virtual texturing + indirection + worker pipeline + accumulation + render-on-demand) is sound; no general refactor. The four items below are targeted consolidations that every subsequent feature multiplies against. Do C2/C3 early (small); C1 is the largest single change in this document; C4 before adding any new render mode.

## C1 — [ARCH][PERF] Packed RGBA atlas + active-channel-set (subsumes P6; unblocks the channel limit)
Files: `volume.ts`, `volume-resources.ts`, `renderer.ts`, `shaders/index.ts`, `sampling.wgsl`, `dvr.wgsl` (+ mip/iso/slice), `streaming-manager.ts`, `zarr-chunk-worker.ts`, `zarr-worker-pool.ts`, `zarr-provider.ts`

**Design decision (agreed): decouple dataset channel count from GPU channel slots.** The dataset may have unlimited channels; the GPU pipeline supports K concurrently *visible* channels (recommend K = 8 = two packed atlases). Users toggle channels; toggling swaps membership in the active set and streams the delta.

Rationale recap: WGSL cannot dynamically index arrays of texture bindings (no `binding_array` in core WebGPU), so per-channel textures scale as bindings × switch-cases × fetches — a dead end. RGBA packing gives 4 channels per fetch, and `vec4` components *are* dynamically indexable (`raw4[ch]`).

Implementation outline:
1. **Atlas:** `ceil(K/4)` textures of `rgba16float`/`rgba8unorm` replace the 4 single-channel atlases + dummies. Memory: 660³ rgba16float ≈ 2.3 GB per texture — too big. Shrink `ATLAS_SIZE` for packed variants: 528³ (8³ = 512 slots, ≈1.18 GB) or 396³ (6³ = 216 slots, ≈0.50 GB) per texture. Slot indices stay well under the rgba8uint 255/axis cap. Keep the existing single-channel r16float/r8unorm path for `numChannels === 1` (avoid 4× waste); select pipeline variant at init.
2. **Worker interleaving:** extend `assembleBrick` to take a channel-group list and write `out[i*4 + ch]` directly. This collapses N per-brick worker round-trips into one per group and shares one assembly pass across the group's chunk fetches — it is simultaneously the P6 bandwidth fix, a large chunk of the P11 win for multichannel, and the mechanism for streaming "the active subset". Per-channel chunks still fetch independently (OME-Zarr `c` axis chunking is typically size-1), but through one cache/dedup pass.
3. **Shader:** one fetch → `vec4f`; multichannel loop indexes `raw4[ch % 4]` per group; second group = second fetch. Delete `volumeTexture1/2/3` bindings, `atlasView()` plumbing, and both `switch(ch)` samplers. The affine transform (P13a) is unchanged — same indirection, same slot math.
4. **Streaming:** brick cache keys become `(brick, channelGroup)`; `writeToCanvas` `bytesPerRow = size[0] * bytesPerVoxel * 4`; one upload per group per brick.
5. **Emptiness semantics change:** "empty = all channels below threshold" must be evaluated **per active set**. A brick empty in visible channels but dense in a hidden one is empty *for the current set only*. Key `emptyBricks` by (brick, active-set generation) or store per-channel max in the stats cache (C3 provides it) and evaluate on the fly — prefer the latter: `emptyBricks` becomes a derived check, not a set.
6. **Active-set switch:** on toggle, bump a generation counter; desired-set computation requests missing groups; slots holding stale-group data are evicted normally by LRU. Per-channel colors/windows: keep fixed-K uniform arrays (K=8) — no storage buffer needed yet; map dataset channel index → active slot index on the CPU.
7. **Rendering model note (verified legit):** the additive weighted-color + max-density extinction composite matches standard fluorescence practice (napari/Viv-style); keep it. The `channelColor/maxDensity` hue normalization is a known heuristic; leave as-is.

Trade-offs & checks: device `maxSampledTexturesPerShaderStage` (typ. 16) comfortably fits 2 packed atlases + TF + indirection; verify `maxTextureDimension3D ≥` chosen atlas size. >K visible channels: refuse in UI (K=8 covers real usage).
Acceptance: multichannel output pixel-identical within float tolerance at same window settings; GPU frame time drops 1.5–3× on 4-channel bandwidth-bound views; toggling channel 5 on an 8-channel dataset streams only that channel's bricks; memory within plan.

## C2 — [ARCH] Unified brick commit path
Files: `streaming-manager.ts`
`loadBaseLod.processBrick` and `loadBrick` duplicate empty-check → allocate → upload → indirection → track, and have already diverged (A3.1, A3.3). Extract `commitBrick(request, channelData, stats, {pin})` used by both, containing: post-fetch empty check, allocation (with A2.2 backpressure), eviction handling (including the P14c ancestor logic), per-channel/group upload, indirection update, metadata + tracking, debounced reset. `loadBaseLod` keeps only its ordering/concurrency/retry logic. This is where the A3.3 channel-failure policy lives once.
Acceptance: behavior identical on both paths; the A3 fixes exist in exactly one place; diff shrinks `streaming-manager.ts`.

## C3 — [ARCH] Provider returns brick stats
Files: `data-provider.ts` (interface), `zarr-provider.ts`, `sharded-provider.ts`, `streaming-manager.ts`
`BrickResult.min/max/avg` still dies in the provider's stats cache; the streamer learns emptiness only via a second async `isBrickEmpty` round-trip. Change `loadBrick` to return `{ data, min, max, avg } | null`. Consumers: emptiness checks become synchronous comparisons (deleting both `await isBrickEmpty` re-checks), B5 gets its per-brick ranges, C1's per-channel-max emptiness gets its data, and P17a/h occupancy structures get their input. Keep `isBrickEmpty` for the pre-fetch fast path only.
Acceptance: no behavioral change; `isBrickEmpty` called at most once per brick load (pre-fetch).

## C4 — [ARCH] Uniform layout generation + pipeline-overridable constants (P17e — promoted)
Files: `shaders/uniform-layout.js`, `shaders/index.ts`, `renderer.ts`
Do before any Part E mode work: every new mode adds uniform fields, and the hand-padded WGSL structs + hand-maintained JS offsets (already duplicated across compute and slice layouts) will desync silently. Generate the WGSL struct text *and* the JS offsets from one field-list description (the `COMPUTE_UNIFORMS.offsets` object suggests half of this exists — complete the loop by emitting the WGSL from the same source). Replace the `injectConfig` regex substitution (fails silently on drift) with pipeline-overridable constants (`override LOGICAL_BRICK_SIZE: f32 = 64.0;` + `constants:` at pipeline creation); keep `MAX_BRICK_TRAVERSALS` injected if any driver refuses an override loop bound.
Acceptance: adding a dummy field to the description compiles and round-trips a sentinel value through the shader with no manual offset edits.

---

# Part D — Advanced WebGPU roadmap (ordered by payoff; after Parts A–C)

## D1 — GPU streaming feedback buffer
The ray-march kernel appends (brickKey, desiredLod) to a storage buffer (atomic counter + fixed-size array, deduplicated coarsely by hashing into a small per-frame table) for bricks rays actually traverse with non-saturated alpha; async `mapAsync` readback (double-buffered, 1–2 frame latency) feeds the streamer alongside or instead of the CPU SSE traversal. Ground-truth demand: occluded bricks (behind `EARLY_EXIT_ALPHA`) are never requested — no frustum/SSE heuristic can do this. Keep the CPU path as prefetch for camera-motion prediction. Largest structural win available; touches shader, renderer (readback plumbing), streaming manager (merge two demand sources).

## D2 — Subgroup early exit
Request the `subgroups` feature when available; in the march loop, replace per-invocation `if (alpha > EARLY_EXIT_ALPHA) break;` checks with `if (subgroupAll(alpha > EARLY_EXIT_ALPHA)) { break; }` at the brick-loop level (keep the per-invocation sample-loop break). Whole subgroups retire together instead of dragging stragglers with masked lanes. Cheap; measurable on dense views. Guard with a shader variant when the feature is absent.

## D3 — Bounds prepass + indirect dispatch (evolves P17c)
Tiny compute pass (or CPU, per v2) projects the proxy box to a screen rect, writes `dispatchWorkgroupsIndirect` args and a pixel offset uniform; main pass covers only the rect. Meaningful whenever the volume occupies a minority of the screen (zoomed out, wide aspect).

## D4 — Tile interval prepass (screen-space empty skipping)
Low-res compute pass (1 thread per 8×8 tile) marches the *indirection table only* (or a coarse occupancy mip once P17a exists) to produce conservative per-tile [tmin, tmax] and a "tile fully empty" flag into a small texture. Main pass starts rays at the refined tmin and discards empty tiles. Composes with D3; simpler than full per-ray brick hierarchy and captures most of P17a's win for typical views.

## D5 — shader-f16
Request `shader-f16`; use `f16` for the compositing accumulators and channel math in the sample loop (keep positions/t in f32). Bandwidth/ALU relief on the mobile/Apple-Silicon class hardware P8 already targets. Shader variant behind the feature flag.

## D6 — Progressive stochastic effects framework
Recognize the existing jitter + frame-weighted accumulation + reset-on-change as a progressive Monte Carlo integrator. Any effect expressible as "one noisy sample per frame" converges for free during stillness: stochastic shadow rays (E7), AO rays, TF-space dithering. Prerequisite for E7; requires only that per-frame randomness be seeded by `frameIndex` (already is) and that new effects reset via the existing `resetAccumulation` choke point.

Also request `timestamp-query` unconditionally in dev builds — prerequisite for validating everything above (v2 measurement notes still apply).

Not available in WebGPU (do not design toward): `binding_array` / dynamically-indexed texture bindings, push constants, 3D texture arrays, multi-queue.

**Carried structural note (v2 P17d) — flat indirection table ceiling:** the LOD0-granularity table scales with the finest grid: a 16k³-voxel dataset → 256³ cells → 67 MB CPU mirror + 67 MB texture, and one coarse `setBrick` fills 16.7M cells on the main thread. For very large datasets, migrate to a per-LOD table pyramid (shader walks fine→coarse, 2–3 indirection loads worst case). Schedule only when dataset sizes demand it; P14a's flush mitigates the write cost in the meantime.

---

# Part E — New render modes (ranked by impact ÷ effort; after C4)

## E1 — Gradient-modulated opacity + local shading (do together)
Reuse the existing `computeGradient` (iso mode). DVR loop: where a sample's alpha contribution exceeds a small threshold, compute the gradient; (a) modulate opacity by a gradient-magnitude curve (2D TF on value × |∇|: start with a simple multiplicative curve before building full 2D TF UI) — boundaries pop, homogeneous interiors clear; (b) Blinn-Phong with a headlight on the normalized gradient. Uniforms: shading on/off, ambient/diffuse/specular, gradient-opacity curve params (C4 makes adding these safe). Cost control: threshold gate means empty/faint samples pay nothing.
Acceptance: side-by-side on a microscopy dataset shows boundary enhancement; frame-time increase < 30% on dense views (gate threshold tunable).

## E2 — MinIP / Average-IP + depth cueing (trivial batch)
MinIP: MIP loop with `min` (initialize to 1.0, skip unloaded bricks correctly — an unloaded region must not contribute 0 as a false minimum; use the empty/invalid brick skip). AvgIP: sum + count, divide at exit. Depth cueing: attenuate composited color by `exp(-k·(t−tStart))`, uniform k, applies to all modes — a few lines, large depth-perception gain.

## E3 — MIDA (Maximum Intensity Difference Accumulation)
DVR variant: track running max density; when a sample exceeds it, boost that sample's opacity weight by the delta (β-interpolation between DVR and MIP). ~15 lines of delta on `rayMarchDVR`; one uniform (β slider from DVR to MIP). Well-loved in microscopy for structure-preserving overviews.

## E4 — Thick-slab projections
Unify clip planes + slice mode: MIP/mean/DVR restricted between two parallel planes (reuse `applyClippingPlanes` with a slab defined by slice position ± thickness along an axis). One thickness uniform per axis; renders through the existing compute path (unlike current rasterized slice mode) so it accumulates and windows identically. High clinical/microscopy utility.

## E5 — First-hit depth output → picking
Write the t (or world position) of the first sample whose cumulative alpha crosses a threshold into a second storage texture (`r32float`). Enables: click-to-pick 3D positions (readback of one texel), measurement tools, and correct depth compositing with future geometry. Pairs with P17f (stop baking `bgColor` into the compute output; store premultiplied `vec4f(rgb, a)` and composite background at blit) — do P17f as part of this item.

## E6 — Pre-integrated transfer function (P17b — unchanged)
Single-channel TF mode only; 256² table of analytically integrated TF between consecutive sample densities; permits 2–4× larger steps at equal quality, multiplying with P7. Rebuild table on TF edit.

## E7 — Progressive stochastic shadows / AO (after D6, E1)
One shadow ray (toward a directional light, jittered) or one short AO ray per contributing sample per frame; noisy result averaged by the existing accumulation → soft shadows/AO that resolve over ~30 still frames and gracefully degrade to unshadowed during motion (accumulation resets). The visual differentiator; implement last.

---

# Suggested implementation order

| Phase | Items | Rationale |
|---|---|---|
| 0 | Verify last session's deliverables | Confirm integration, compile, run the 9-point checklist in `PATCHES.md`; request Category 1 + 2 files |
| 1 | ~~A1.1–A1.4~~ DELIVERED | User-visible regressions from the render-on-demand round; small diffs |
| 2 | ~~A2, A3~~ DELIVERED; C2, C3 remain | C2/C3 (unified commit path + stats plumbing) refactor the streaming manager the delivered fixes live in — do next, needs Category 2 files |
| 3 | ~~B1~~ DELIVERED | One line, multiplies with shipped P7 |
| 4 | B6 | Instrumentation before worker-side optimization |
| 5 | B2, B3, B4 | Worker side: cancellation, assembly rewrite, affinity — measured against B6 counters |
| 6 | B5 | Startup scans deletion (trivial after C3) |
| 7 | C1 | Packed atlas + active channel set — the big one; clean baseline from phases 1–6 first |
| 8 | C4 | Uniform generation, gate for Part E |
| 9 | E1, E2, E3 | First mode batch (shading + trivial projections) |
| 10 | D2, D3, B7.6/P8c | Cheap GPU-side wins |
| 11 | D1, D4 | Feedback-driven streaming + tile intervals |
| 12 | E4, E5/P17f, E6 | Second mode batch |
| 13 | D5, D6, E7 | f16, stochastic framework, shadows |
| — | B7.x, P14a/b/d as opportunistic hygiene alongside touched files | |

# Measurement notes
GPU: timestamp queries (`timestamp-query` feature) around compute/accum/render passes; Chrome `--enable-dawn-features=allow_unsafe_apis` for deeper paths; Xcode/PIX captures through Chrome for TBDR verification of pass-structure changes. Worker pipeline telemetry (`avgFetchMs`, `avgAssemblyMs`) is already in place — record before/after for B3.

Baseline scenarios to capture before each optimization phase: (a) static camera, converged, single-channel; (b) static, 4-channel; (c) orbiting at each renderScale; (d) zoom gesture into a dense region on a cold atlas; (e) idle for 60 s with a static camera (GPU utilization — the render-on-demand metric); (f) cold load of a sparse dataset and of a multichannel float dataset (empty-brick and startup-scan metrics). New scenarios from this cycle: (g) dataset-clear → reload cycle ×3 with pinned-count assertion (A2.1); (h) one channel's chunks blocked in devtools during a multichannel load (A3.3); (i) rapid-gesture wire-byte totals before/after B2; (j) channel-toggle streaming delta on an 8-channel dataset (C1); (k) slice-mode idle GPU utilization (A1.3).

Counters to add to streaming stats: `allocationsRefused` (delivered), cancelled-but-completed worker requests (B2), chunk-cache hit rate + duplicate-fetch count + wire bytes (B6), indirection flushes + dirty-region size (P14a), samples-per-ray debug toggle (validates P7/LOD stepping).

