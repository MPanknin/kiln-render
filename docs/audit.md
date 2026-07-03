Volume Renderer — Performance & Correctness Review (v2, complete)
Scope: Full end-to-end review of the WebGPU brick-streaming volume renderer ("Kiln"). Every stage has been reviewed: WGSL shaders (ray marching, sampling, compositing, accumulation), shader assembly, JS render loop (renderer.ts), streaming policy (streaming-manager.ts, atlas-allocator.ts, brick-cache.ts, indirection.ts), the Zarr data pipeline (zarr-provider.ts, zarr-chunk-worker.ts, zarr-worker-pool.ts, base-zarr-provider.ts, tolerant-fetch-store.ts, decompression-pool.ts), upload path (volume.ts), the viewer driver (kiln-viewer.ts), and the camera (camera.ts). There are no remaining blind spots.
Changes from v1: Adds the data-pipeline, viewer-driver, and camera findings; adds two new top-tier items (render-on-demand, the 5xx-caching data-integrity bug); retracts v1 finding 9c (isBrickEmpty is a Map lookup, not a network call — the serialized round trip concern does not apply; a worse variant of the problem replaces it as Priority 5); amends P7 with hysteresis and a mobile interaction bug.
How to use this document: Items are ordered by priority (impact × confidence ÷ effort). Each item states the problem, the affected files, the concrete fix, and acceptance criteria. [BUG] = correctness; [PERF] = performance; [QUALITY] = image quality. Dependencies are called out; some items must be implemented together.

Architecture summary (context for the implementer)
Front-to-back DVR ray marcher over a virtual-textured volume. Bricks are 64³ logical / 66³ physical (1-voxel ghost border) packed into 660³ atlas textures (one per channel, up to 4; r8unorm or r16float). A flat rgba8uint indirection texture at LOD0-brick granularity maps virtual bricks → atlas slots; w encodes lod+1 (0 = unloaded, 255 = empty). Streaming: SSE-based LOD selection with frustum culling, LRU atlas eviction with parent-LOD fallback, CPU-side brick LRU cache, pinned base LOD.
Data source is OME-Zarr over HTTP via zarrita. A pool of up to 8 Web Workers runs the full fetch → decompress (blosc/zstd/lz4 WASM) → assemble-66³-brick → stats pipeline; assembled bricks transfer zero-copy to the main thread, which only does queue.writeTexture. Workers each hold a 128 MB chunk cache with in-flight dedup; dispatch uses a spatial-affinity hash. Each worker's fetch store has a 6-slot semaphore and maps 403/404 (and, buggily, 5xx) to "missing".
Rendering: compute-shader ray march at renderScale ∈ {0.25, 0.5, 1.0} (0.25 forced during camera interaction) → temporal accumulation (ping-pong, frame-count-weighted running average, camera-move reset, 64-frame cap) → blit → overlay pass. Per-frame jitter; exact Beer-Lambert compositing 1 − exp(−σ·Δt). The frame loop is an unconditional requestAnimationFrame.

Priority 1 — [QUALITY][BUG] Temporal accumulation quantizes to 8-bit and never converges
Files: renderer.ts (resizeComputeTexture, constructor), accumulate.wgsl, shaders/index.ts (computeShader binding 7)
Problem. The ping-pong accumulation textures and the compute output texture are rgba8unorm. The accumulation shader computes mix(history, current, weight) with weight = 1/(frameCount+1) and stores into rgba8unorm, so every update is quantized to 1/255 steps. A channel only changes when weight · |current − history| ≥ 0.5/255. As the average converges, residual jitter noise shrinks below this threshold and pixels freeze with visible residual noise and banding, well before the 64-frame cap. The ping-pong re-quantizes history itself every frame, so rounding errors compound — the accumulator drifts rather than converges. Dark gradients band; the image cannot get darker by less than 1 LSB per frame.
Fix.
renderer.ts: both accumTextures → format: 'rgba16float' (in resizeComputeTexture() and the constructor's dummy initializer).
accumulate.wgsl: @group(0) @binding(3) var outputTexture: texture_storage_2d<rgba16float, write>; — the WGSL storage format must match the texture; this edit is mandatory.
computeOutputTexture → rgba16float too, and the computeShader's binding 7 declaration. Otherwise the input to the average is pre-quantized and dark-gradient banding survives.
Notes. rgba16float supports STORAGE_BINDING in core WebGPU — no feature check. The blit samples texture_2d<f32> with a linear sampler; float16 is filterable — no blit change. Memory: 3 textures × w × h × 8 B ≈ 66 MB total at renderScale 0.5 on 4K — negligible vs. atlases.
Acceptance. Static camera, jitter+TAA on: image visibly refines up to the frame cap; no banding in dark smooth gradients; accumulated image strictly cleaner than a single frame.

Priority 2 — [PERF] The frame loop renders unconditionally forever — implement render-on-demand
Files: kiln-viewer.ts (frame()), renderer.ts (dirty-flag plumbing), streaming-manager.ts (return value)
Problem. frame() runs the full pipeline — streamingManager.update → full-screen compute ray march → accumulation → blit → overlay — every rAF tick, even when the camera is static, accumFrameCount has hit its 64-frame cap, and no streaming is in flight. At that point every frame is pixel-identical. On a 120 Hz laptop this is continuous full-screen ray marching for zero visual change: the single largest idle power/thermal cost in the app, and invisible to per-frame profiling because each frame individually looks fine. Note: streamingManager.update() already returns a boolean "work pending" designed for exactly this — it is currently ignored.
Fix. Add a dirty flag. Render when ANY of:
camera.isInteracting() or the view-projection changed since last frame (the renderer already computes vpChanged; hoist or duplicate that check into the loop)
accumFrameCount < 64 (still converging) — expose a getter on the renderer
TAA disabled (!enableTAA — every frame differs due to jitter; alternatively also skip when jitter is off and nothing changed)
streamingManager.update(...) returned true, or bricks arrived since the last render (the debounced resetAccumulation already fires on arrival — see below)
any parameter changed: resetAccumulation() is already the universal choke point every setter calls — have it also set the viewer's dirty flag (add a callback or event from renderer → viewer)
When clean: skip context.getCurrentTexture(), all uniform writes, and all GPU submission entirely. The browser keeps the last presented frame. Keep the rAF ticking (it's cheap) or decimate it to ~10 Hz to keep polling streamingManager.update.
Caution. streamingManager.update must still run while dirty-idle if there are in-flight requests, so arriving bricks trigger a render. The simplest correct structure: always call update(), and let its return value + the reset-callback set the dirty flag.
Acceptance. With a static camera and converged accumulation: GPU utilization drops to ~0 (verify in a system GPU monitor); the canvas still updates immediately on any input, parameter change, or brick arrival; no stale-frame flashes on resize.

Priority 3 — [PERF] SSE LOD selection ignores render scale (one-line fix)
Files: streaming-manager.ts (computeDesiredSet)
Problem. projectionFactor = canvas.height / (2·tan(fov/2)) uses full-resolution canvas height; maxPixelError = 8 is in full-res pixels. During interaction the renderer drops to renderScale 0.25, but the streamer still selects LODs sized for full resolution — the shader marches unnecessarily fine bricks exactly when frame-rate-limited, and the streamer requests fine bricks mid-gesture (atlas churn, network traffic, accumulation-reset ghosting).
Fix.
this.projectionFactor =
  (canvas.height * this.renderer.renderScale) / (2 * Math.tan(this.cameraFovRad / 2));

(Or divide maxPixelError by renderScale — one or the other, not both.)
Cascade. Coarser desired set during interaction → fewer mid-gesture loads → less eviction pressure (P9) → fewer accumulation resets. Multiplies with P7 (LOD-adaptive stepping): coarser bricks + larger steps = far fewer samples during interaction.
Acceptance. Camera moving at scale 0.25: streaming stats show substantially smaller desiredCount than at 1.0 for the same view; on stop, the camera-stopped path re-runs computeDesiredSet and fine bricks stream in.

Priority 4 — [BUG] Transient 5xx / network errors become permanent zero-filled holes, and get cached
Files: tolerant-fetch-store.ts (get), zarr-chunk-worker.ts (chunk cache interaction)
Problem. TolerantFetchStore.get maps every non-200/206 status — including 500/502/503 — and every thrown fetch error to undefined. zarrita interprets undefined as "chunk does not exist" and fills the region with the array fill value (0). The zeroed chunk then enters the worker's chunk cache, so the hole persists across all future brick assemblies touching that chunk until page reload. The streamer's retry logic never fires because loadBrick "succeeds" — the brick is just partially zero. Worse, the brick's min/max stats are computed from the zeroed data, so the brick can be permanently marked empty in emptyBricks and never re-requested. A single blip from a flaky CDN silently deletes a chunk-sized cube of data from the visualization.
Fix.
In get(): only 404 and 403 map to undefined (genuine "missing chunk" semantics for CloudFront/S3). For 5xx and thrown network errors: retry with bounded exponential backoff inside the store (e.g., 3 attempts, 250/1000/4000 ms), and if still failing, throw. The thrown error propagates: assembleBrick rejects → ZarrDataProvider.loadBrick catches, returns null → the streamer's existing failure handling (skip/retry, base-LOD retry pass) takes over.
Ensure the worker never caches a chunk whose fetch went through an error path (with fix 1 this falls out automatically, since errors now throw instead of resolving).
getRange has the same 403-only tolerance but re-throws other errors — verify it stays consistent after the change.
Acceptance. Simulate with devtools request blocking or a proxy returning 502 intermittently: bricks affected by transient errors eventually load correctly; no permanent black regions; nothing gets marked empty due to an error.

Priority 5 — [PERF][BUG-adjacent] Empty bricks pay the full pipeline cost and occupy atlas slots
Files: streaming-manager.ts (loadBrick, loadBaseLod), base-zarr-provider.ts (context), zarr-worker-pool.ts (BrickResult)
Replaces v1 item 9c (retracted). isBrickEmpty is a Map lookup against brickStatsCache — not a network call — so v1's "serialized round trip" concern was wrong. The real problem is the inverse: the stats cache is only populated by loadBrick, so on first encounter isBrickEmpty always returns false (no stats → return false). Consequently every empty brick is fully fetched, decompressed, assembled (287k-voxel scatter), transferred, uploaded to the GPU, and given an atlas slot. The streamer never inspects the min/max returned in BrickResult. Emptiness is only discovered if the brick is later evicted and re-desired. In sparse datasets (common in microscopy), a large fraction of first-visit bandwidth, worker CPU, and atlas capacity is spent on bricks that render nothing.
Fix. In streaming-manager.ts loadBrick (and the equivalent spot in loadBaseLod), after the channel data resolves and before allocating a slot:
// result.max is in [0, 65535] stat space (worker guarantees this incl. float data)
const allEmpty = channelResults.every(r => r.max < this.config.emptyBrickThreshold);
if (allEmpty) {
  this.emptyBricks.add(key);
  this.renderer.indirection.setEmpty(bx, by, bz, lod);
  return; // no slot, no upload
}

Note the streamer currently receives only BrickData (the typed array) from the provider, not the stats — plumb min/max through ZarrDataProvider.loadBrick's return (it already has them from BrickResult; it currently discards them into the stats cache only). Multichannel: a brick is empty only if all channels are below threshold (the stats-cache merge in cacheBrickStats already encodes this rule — reuse it or check per-channel results directly).
Bandwidth is still spent once (you must fetch to learn a brick is empty). To eliminate even that, the durable fix is offline: emit a per-LOD occupancy bitmap/manifest at dataset creation and load it at init — then isBrickEmpty is truly free pre-fetch. Track as a data-pipeline feature. Bonus: per-brick min/max is exactly the input a min/max occupancy structure needs (item 15a) — this fix is a step toward proper occupancy skipping.
Acceptance. Load a sparse dataset cold: empty bricks appear in emptyBricks after first fetch without consuming atlas slots (atlasUsage stays proportional to non-empty bricks); repeat visits skip them entirely.

Priority 6 — [PERF] Pack multi-channel atlases into one RGBA texture
Files: volume.ts, renderer.ts, shaders/index.ts, sampling.wgsl, streaming-manager.ts, zarr-chunk-worker.ts (interleave at assembly)
Problem. sampleAtlasCh computes an identical atlasPos for every channel, then performs up to 4 separate trilinear fetches into 4 separate textures via a switch. All channels share the same indirection, layout, and slot coordinates. The volume fetch is the hottest operation in the renderer (per sample per channel) and the shader is texture-bandwidth-bound: 4 fetches where 1 would do is a 2–4× bandwidth multiplier on multichannel data. The format-detection code confirms atlases are r16float (16-bit) or r8unorm — so the packed variant is rgba16float/rgba8unorm: same bytes per channel, one address computation, one filtering op.
Fix.
One atlas texture of rgba16float / rgba8unorm replaces the N single-channel atlases + dummy texture.
Interleave channels at brick assembly. Best place: the worker — extend assembleBrick to accept a channel list and write out[i*4+ch] directly (this also collapses N per-channel loadBrick round trips into one worker request per brick, and lets the per-channel chunk fetches share one assembly pass). Simpler fallback: interleave on the main thread before writeTexture (a flat loop over 287k×4 values — measurable but acceptable).
writeToCanvas: bytesPerRow = size[0] * bytesPerVoxel * 4.
Shader: one fetch returning vec4f; the multichannel loop indexes raw4[ch] (WGSL allows vec indexing by loop variable). Delete volumeTexture1/2/3 bindings and atlasView() plumbing.
Trade-offs. Single-channel datasets would waste 4× texel memory — keep the single-channel r16float/r8unorm path and select the packed pipeline only when numChannels > 1. A 660³ rgba16float atlas ≈ 2.3 GB — check device limits; consider a smaller ATLAS_SIZE for the packed variant. >4 channels needs a second atlas (current cap is 4 — fine).
Acceptance. Multichannel output pixel-identical within float tolerance; GPU frame time drops 1.5–3× in bandwidth-bound multichannel views; memory within plan.

Priority 7 — [PERF] LOD-adaptive ray step size
Files: dvr.wgsl (rayMarchDVR), raymarching.wgsl (setupBrick)
Problem. stepSize = brickWorldSize / STEPS_PER_BRICK where brickWorldSize is the constant world-space brick diagonal — the step never adapts to LOD. A brick at LOD 3 (lodScale = 8) holds 8× coarser data yet is marched at LOD0 spacing: ~8× more trilinear fetches than the data justifies. Zoomed-out views and interaction at low render scale (after P3, deliberately coarse bricks) pay this fully.
Why safe. Compositing uses exact Beer-Lambert 1 − exp(−σ·Δt) — correct for any step size, unlike the pow(1−α, Δt/Δt₀) approximation. Pass the true per-brick step into the extinction term and the integral stays consistent across LOD transitions with no density shift at boundaries.
Fix.
setupBrick: info.stepSize = (brickWorldSize / STEPS_PER_BRICK) * min(info.lodScale, 4.0); — tune the clamp (2–8) visually. numSteps already derives from stepSize, staying consistent.
rayMarchDVR: stop freezing rayStepSize at the first valid brick; use brick.stepSize per brick and pass it to compositing (brick.stepSize * uniforms.densityScale).
Jitter with variable steps: compute the per-ray jitter fraction j ∈ [0,1) once before the brick loop; at each valid brick entry set the sampling comb from t + j * brick.stepSize if starting fresh in that brick, ensuring tSample never goes backwards and j is reused, never re-randomized. A per-brick phase reset is visually fine because the comb spacing changed at the boundary anyway.
Implement together with P13c (jitter phase at skipped bricks) — same lines.
Acceptance. No density/brightness discontinuity at LOD boundaries (screenshot compare); a debug sample-count counter drops proportionally in coarse-LOD views; frame time improves zoomed out and during interaction.

Priority 8 — [PERF] Render pass hygiene: merge blit+overlay, discard depth, optionally fuse accumulation
Files: renderer.ts (renderCompute, renderFragment), optionally shaders/index.ts + accumulate.wgsl
(a) Merge blit into the overlay pass. Current compute path: compute → accum (compute) → blit render pass (store to colorView) → overlay render pass (loadOp: 'load' on the same view). On tile-based GPUs (Apple Silicon, mobile) ending a pass and re-loading the same attachment forces a full-screen tile flush + reload. Make the blit the first draw of the overlay pass (which keeps loadOp: 'clear'), then slice/wireframe/axis on top. The blit pipeline needs a depthStencil state matching the pass (depthWriteEnabled: false, depthCompare: 'always'). Delete the standalone blit pass.
(b) Depth is stored but never sampled. Both paths set depthStoreOp: 'store'; nothing reads the depth texture. Set 'discard' in both passes — on TBDR that's a full-screen main-memory depth write eliminated every frame. (Verify getDepthView() consumers don't load depth in a separate pass first.)
(c) Optional: fuse accumulation into the main compute kernel. The main kernel can read the history accum texture and write mix(history, result, weight) directly to the write-side accum texture — eliminating computeOutputTexture entirely and one full-screen read+write dispatch. Needs two compute bind-group configs (ping-pong) and weight folded into main uniforms (written every frame anyway); weight = 1.0 reproduces TAA-off. Do together with P1 (same declarations). With (a)+(c), per-frame passes drop from 4 to 2.
Acceptance. Identical output; GPU time drops on Apple Silicon (timestamp queries); pass count per frame = 2 with (c), 3 without.

Priority 9 — [BUG] Atlas eviction can thrash: evicts bricks in the current desired set
Files: atlas-allocator.ts (findLRUSlot, allocate, free), streaming-manager.ts (loadBrick, processLoadQueue)
Problem. allocate() evicts the LRU slot even if it was touched this frame. When resident + pinned + desired bricks exceed atlas capacity (zoom into a dense region; multichannel makes it likelier), eviction hits currently visible, desired bricks. The evicted brick is re-requested on the next computeDesiredSet, loaded, evicting another visible brick — permanent churn: network traffic, upload storms, and the 100 ms debounced accumulation reset firing forever with a stationary camera. The only guard (maxDesiredBricks = 256 < 1000 slots) counts queued bricks, not residency, so it does not prevent this.
Fix.
findLRUSlot(currentFrame): skip slots with currentFrame − lastUsedFrame < RECENT (≈ 2 × update interval ≈ 20 frames; tune). Return −1 when nothing evictable.
Streamer: treat allocation failure as backpressure — return silently from loadBrick (drop the warn), and in processLoadQueue stop draining the queue for this frame on the first refusal (bricks stay desired and retry next update).
Why failure is harmless: a refused finer-LOD load leaves the coarser parent resident; the shader falls back seamlessly via the indirection table. Allocation failure costs nothing visually.
Also fix here (same files):
free() doesn't unpin: a freed pinned slot re-enters the free list but stays in pinned, so after reuse findLRUSlot skips it forever. Add this.pinned.delete(idx).
findLRUSlot is O(totalSlots)/eviction with Set lookups — fine at 1000 slots; if the atlas grows or it profiles hot during bursts, replace with a clock/second-chance sweep (O(1) amortized, ~15 lines) and a Uint8Array used-flag instead of the Set.
Acceptance. Shrink the atlas so demand exceeds capacity, zoom into a dense region, hold still: loading settles, evictedCount stabilizes, accumulation converges (vs. today's perpetual churn).

Priority 10 — [PERF][BUG] Interaction render-scale machinery: touch bug, hysteresis, per-scale preallocation
Files: camera.ts (isInteracting, event handlers), kiln-viewer.ts (frame()), renderer.ts (resizeComputeTexture, recreateComputeBindGroups)
(a) [BUG] isInteracting() ignores touch pan and pinch. It returns isDragging || isPanning || isZooming — but two-finger touch gestures set isTouchPanning = true and isDragging = false, and pinch zoom sets nothing checked. On mobile/tablet, pan and pinch render at full user scale with no 0.25 interaction drop — the platform that needs it most. (One-finger orbit works, it sets isDragging.) Fix: include isTouchPanning, and set an interaction timestamp during pinch (see (b)).
(b) No upshift hysteresis (except wheel). Wheel zoom already has a 200 ms timer — the right pattern. But mouse-drag release flips isDragging = false instantly → immediate reallocation + one full-res frame on the very next frame; drag→pause→drag thrashes. Generalize: one lastInteractionTime updated by all input handlers; isInteracting() returns true until ~200–250 ms after the last event. This subsumes the wheel timer.
(c) Scale changes reallocate everything. resizeComputeTexture() destroys/recreates 3 textures and rebuilds ~5 bind groups — an allocation storm exactly on the gesture-start and gesture-end frames. The scale set is fixed ({0.25, 0.5, 1.0}): preallocate textures + bind groups per scale at resize() (full-res change), keyed by scale; a scale change becomes a pointer swap + resetAccumulation(). Memory dominated by the 1.0 set (with rgba16float at 4K ≈ 100 MB + 25 + 6) — acceptable; drop to two scales if not.
Acceptance. A trace of gesture start/end shows zero createTexture/createBindGroup calls; no first-interaction-frame spike; on a touch device, two-finger pan/pinch visibly drops to interaction resolution.

Priority 11 — [PERF] Worker brick-assembly inner loop: per-voxel string keys, Map lookups, and float16 conversion
Files: zarr-chunk-worker.ts (assembleBrick)
Problem. The assembly loop runs 66³ = 287,496 iterations per brick per channel. Each iteration does: 3× Math.max/min/round coordinate mappings, 3 divisions for chunk coords, a template-string cacheKey(...) construction, a string-hashed localChunks.get(key) Map lookup, and a Number() call. That's ~287k string allocations + hashed lookups per brick — in a burst (8 concurrent bricks × 4 channels), millions per second inside the workers, all GC pressure. The float32 path additionally calls float32ToFloat16Bits (JS bit-twiddling) per voxel. This is almost certainly the dominant term in avgAssemblyMs.
Fix (mechanical restructure — everything is separable per axis).
Precompute three per-axis lookup tables of length 66: for each local coord lx store gx (scaled+rounded+clamped), cxi (chunk index minus minCx), and lcx (offset in chunk). All Math.* and divisions leave the inner loop.
Resolve chunks once into a dense 3D array (max 3×3×3) indexed (czi, cyi, cxi) before the loop; the inner loop does integer-indexed array access. Zero strings, zero Map lookups.
Optional further step: iterate x in runs between chunk boundaries — hoist the chunk data pointer and row stride per run; when scaleX === 1 (the aligned common case) the run is a candidate for a straight contiguous copy.
Float path: scatter raw values first, convert to float16 in a single flat pass afterward — or use native Float16Array / DataView.setFloat16 (shipping in modern browsers) with the manual function as fallback.
Acceptance. avgAssemblyMs in the pipeline telemetry drops by an integer factor (expect ≥ 3–5×); worker CPU during streaming bursts visibly lower in a performance profile; assembled bricks byte-identical to the old path on a test dataset.

Priority 12 — [PERF] Worker affinity hash keys on the brick's center chunk — defeats cache sharing in the common layout
Files: zarr-worker-pool.ts (getAffinityWorker)
Problem. The spatial-affinity dispatch is the right idea (each worker's 128 MB chunk cache + in-flight dedup exist to amortize ghost-border amplification: a 66³ brick spanning [64b−1, 64b+64] touches up to 27 chunks when chunk size = brick size = 64³, the typical layout — ~26× fetch amplification without reuse). But the hash keys on the chunk containing the brick's center — and with 64³ chunks, every brick's center is in its own chunk, so adjacent bricks hash to different workers. Adjacent bricks are exactly the ones sharing border chunks (brick b needs chunks b−1,b,b+1; brick b+1 needs b,b+1,b+2). On different workers, shared chunks are fetched and decompressed multiple times, invisible to per-worker dedup; with 8 workers and dense traversal, each chunk can be fetched up to ~8×. Most of the amplification survives the current scheme.
Fix.
Hash a coarsened chunk region: ((cx>>1) , (cy>>1), (cz>>1), lod) groups 2³ chunk neighborhoods per worker (border sharing inside each group becomes cache hits; duplication only at group boundaries). >>2 shares more at the cost of balance.
Load-balance guard: coarse hashing concentrates a zoomed-in region onto few workers while others idle, capping effective concurrency below the streamer's 8–12 in-flight limit. Add queue-depth-aware spill: prefer the affinity worker, but if its pending count exceeds a threshold (track per-worker outstanding requests — the pool already tracks all pending requests, add a per-worker counter), send to the least-loaded worker instead.
Longer-term alternatives (document, don't build now): bake ghost borders server-side (one fetch per brick, zero amplification — the right answer if the data pipeline is controlled); or a SharedArrayBuffer shared chunk cache (complex; needs COOP/COEP).
Acceptance. Instrument workers to report chunk-cache hit rate and duplicate-fetch count (same chunk key fetched by >1 worker within a window). After the change: hit rate up substantially during dense streaming; wire bytes (see P16d) drop for the same navigation.

Priority 13 — [PERF][QUALITY] Shader hot-loop batch (implement as one change)
Files: sampling.wgsl, raymarching.wgsl, dvr.wgsl, compositing.wgsl
13a. Affine atlas transform hoisted into BrickInfo (ALU + precision fix)
sampleAtlas recomputes per sample: posInBrick = (voxelPos % (LOGICAL_BRICK_SIZE * lodScale)) / lodScale (fmod + divides) and atlasBase = vec3f(indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE (brick-constant). The mapping is affine within a brick: extend BrickInfo with atlasOffset: vec3f, atlasScale: f32 computed once in setupBrick such that atlasPos = atlasOffset + voxelPos * atlasScale reproduces the current math exactly (derive the constant from brickMinVoxel, BORDER, lodScale; validate against the old formula before deleting it). Hot loop becomes one FMA. Precision bonus: eliminates f32 fmod on large voxel coordinates, which quantizes at voxelPos ≳ 100k (shimmering in distant bricks on huge datasets). Cold paths (sampleWithIndirection, iso bisection, gradients) keep the standalone form.
13b. Extinction-scale hoisting + exp2
Hoist extinctionScale = stepSize * densityScale * maxDim * 0.5 * 1.442695 per ray/brick; per sample: 1.0 - exp2(-density * extinctionScale) — three multiplies out of the loop, guaranteed native exp2. Move the per-ray maxDim = max(datasetSize…) to a uniform. In the multichannel loop, precompute per-channel lower/invWidth into local arrays (currently wc − ww*0.5 + a divide per sample per channel); same for the single-channel 1/(floatMax − floatMin).
13c. Jitter phase preserved when skipping invalid bricks
The invalid-brick path snaps tSample = t, discarding the jitter offset — all rays re-align at skipped-brick boundaries, reintroducing wood-grain banding behind empty regions. Replace with whole-step advancement: tSample += ceil((t - tSample) / rayStepSize) * rayStepSize; If P7 is implemented, follow its per-brick phase rule instead — do together.
13d. Jitter seed fails under orthographic projection
rayToSeed(rayDir) is direction-only: under an ortho camera all rays share one direction → identical jitter per pixel → full-screen banding. If ortho is ever a mode, seed from pixel coordinates (hash(px + py*9781u + frameIndex*26699u) in compute; from position.xy in fragment).
13e. Scale-sensitive brick-boundary epsilon
t = brick.tEnd + 0.0001: at large t, f32 rounding can make the addition a no-op → the same brick re-processes, silently burning MAX_BRICK_TRAVERSALS. Use t = brick.tEnd + max(0.0001, brick.tEnd * 1e-6).
13f. TF near-zero cull (document)
composeSampleWindowed culls on windowedDensity > 0.01 before the TF lookup — TF entries in [0, 0.01] are unreachable. If users colorize near-zero densities (haze/context), samples vanish silently. Comment it, or cull on tfColor.a (costs the fetch always).
Acceptance (batch). Visually identical on a reference dataset except: banding behind empty regions gone (13c), distant-brick shimmer on huge datasets gone (13a). Frame time improves in ALU-bound views.

Priority 14 — [PERF] Streaming-layer and main-thread hygiene
14a. Batch indirection-texture writes into a per-frame dirty-region flush
File: indirection.ts. Every setBrick/setEmpty/clearBrick issues its own writeTexture — including 4-byte single-cell writes. Each pays full validation/staging/scheduling and can inject a usage transition on a texture sampled every frame; bursts spray dozens (each eviction = clear-region write + new-brick write). The class already keeps a full CPU mirror: track a dirty AABB, expose flush(), call once per frame from the renderer before encoding; upload the union region via the existing subregion-extraction loop (full table if dirty region > ~50%). Side benefit: per-frame-atomic indirection updates eliminate one-frame inconsistency windows by construction.
14b. computeDesiredSet allocation diet
File: streaming-manager.ts. Runs every frame during motion on the main thread; per node: levels.find(...) linear search, fresh AABB objects, template-string keys; full desiredKeys rebuild. Fixes: levelsByLod[lod] array; reusable AABB scratch; consider throttling to every 2–3 frames while moving (3-frame cancellation latency is fine); replace the addDesiredBrick instance-property closure (reassigned per call) with a plain method. Worker candidate only if still hot after.
14c. Empty-marker regression after eviction
Files: indirection.ts, streaming-manager.ts. Sequence: parent region marked empty (255) → fine brick loads over it → fine brick evicted → clearBrick finds no loaded parent (parent was empty, never loaded) → cells revert to 0 (unloaded) instead of 255. No visual bug (shader skips both), but the streamer re-checks the region forever. Fix in the eviction handler: when findParentBrick fails, check ancestors against emptyBricks; if found, setEmpty the evicted brick's region instead of bare-clearing. Implement with P9 (same code path). While in the file: extract the three near-identical covered-cell loops (subtly different predicates, all currently correct) into forEachCoveredCell(base, scale, cb); comment the implicit constraints (LOD cap 253 from the 255 marker; rgba8uint caps slot indices at 255/axis).
14d. Misc
renderer.ts: wireframeUniformBuffer written every frame even when hidden — guard.
accumulate.wgsl: screenSize: vec2f compared via i32() per thread → vec2u vs gid.xy. (Moot with P8c.)
Streaming/accumulation ghosting: the 100 ms debounced reset makes fresh bricks blend against stale history (fade-in). Alternative: no reset, clamp minimum blend weight (weight = max(1/(N+1), 0.1)) so the accumulator is a bounded EMA absorbing content changes. Pairs with P1.
volume.ts: assert data type vs. texture format in writeToCanvas (uint16 bytes into r16float = garbage; the conversion lives in the worker, assert as insurance).
Atlas upload batching: queue.writeTexture from packed buffers is correct (Dawn staging absorbs it). Only if profiling shows burst hitches: batch the frame's arrived bricks adjacent to the render submit.

Priority 15 — [PERF] Startup: coarsest LOD downloaded multiple times; init-time scans
Files: base-zarr-provider.ts (scanFloatRange, scanChannelRanges), zarr-provider.ts (initialize), streaming-manager.ts (loadBaseLod)
Problem. For float datasets without OMERO windows, scanFloatRange fetches every chunk of the coarsest LOD on the main thread at init (two full passes over the data for the histogram); for multichannel without windows, scanChannelRanges does it again per channel, sequentially. Then loadBaseLod has the workers fetch the same chunks yet again for brick assembly. A multichannel float dataset downloads the coarsest level 1 + N_channels times before first render — directly inflating the tracked time-to-first-render.
Fix. Derive ranges from what the workers already compute: base-LOD assembly produces per-brick min/max. Set preliminary windows from the first arriving bricks (or after base LOD completes — onBaseLodLoaded already delivers brick data), refine/finalize once all base bricks are in. This deletes both scan functions' network cost and overlaps range discovery with useful loading. Keep the scans only as a fallback for providers without the worker path. (Histogram-based percentile windowing can also run over the assembled base-LOD bricks instead of raw chunks.)
Acceptance. Cold load of a multichannel float dataset: network bytes before first render drop to ~1× the coarsest LOD; time-to-first-render improves accordingly; auto-windowing results remain visually equivalent.

Priority 16 — Small fixes and instrumentation corrections
(a) requestAdapter power preference. kiln-viewer.ts: no powerPreference — dual-GPU laptops may hand a bandwidth-hungry ray marcher the integrated GPU. Add navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).
(b) Undebounced resize. kiln-viewer.ts: the ResizeObserver fires resize() per event during window drags — a depth+compute+accum+bind-group recreate storm. Debounce ~100 ms (render at stale size until settled). Interacts with P10c: with per-scale preallocation, a resize rebuilds all scale sets — debouncing matters more.
(c) Worker chunk cache is FIFO, not LRU. zarr-chunk-worker.ts: chunkCache.get doesn't refresh recency (no delete/re-set) — Map-order eviction is FIFO. For border-chunk reuse, LRU is meaningfully better; copy the refresh idiom from BrickCache.
(d) Download stats measure the wrong thing. zarr-provider.ts: recordDownload(result.data.byteLength) counts the decompressed assembled brick, not wire bytes. With ghost-border amplification (P12) and compression, reported bandwidth can be off by an order of magnitude either way. Have the worker sum actual fetched (compressed) bytes on cache misses and return them alongside timings; record that.
(e) Camera matrix allocations. camera.ts: getViewMatrix/getProjectionMatrix allocate per call (wgpu-matrix allocates without dst) — 2×/frame in render + 2×/computeDesiredSet; worse, getScreenSpaceVectors() calls getViewMatrix() per mousemove while panning (up to 1000 Hz on high-polling mice). Pass scratch dst arrays; cache the view matrix per updatePosition().
(f) DecompressionPool/DecompressionWorker. Parallel gzip path for the sharded provider; stateless so round-robin is correct there — but it duplicates the uint16→float16 conversion logic. If both providers live on, extract the shared conversion; if superseded, delete.
(g) Concurrency context (no action). 8 workers × 6-per-store semaphore = up to 48 concurrent requests. Fine on HTTP/2; on HTTP/1.1 the browser's ~6/origin cap means the network stack, not the semaphore, is the limiter. Know which the CDN speaks when interpreting throughput stats.

Priority 17 — Structural / future (documented, not scheduled)
(a) Hierarchical empty-space skipping. Empty/invalid bricks skip one at a time (indirection load + slab test each); rays through sparse volumes burn dozens–hundreds of no-op iterations (why MAX_BRICK_TRAVERSALS = 512). Escalations if timestamp queries show traversal dominating: a coarse occupancy mip over the indirection table (skip 4³ empties per test), or at minimum DDA through the brick grid (removes the per-brick slab test and the 13e epsilon hazard). P5's per-brick min/max is the natural data source.
(b) Pre-integrated transfer function (single-channel TF mode): 256×256 table indexed by consecutive sample densities; integrates the TF analytically between samples, permitting 2–4× larger steps at equal quality; multiplies with P7. Costs: one register, table rebuild on TF edit, inapplicable to additive multichannel.
(c) Compute dispatch covers the whole screen. Compute the proxy box's screen-space bounding rect on the CPU per frame and dispatch only that region (offset pixelCoord). Meaningful when the volume covers a minority of the screen.
(d) Flat indirection table ceiling. LOD0-granularity table scales with the finest grid: 16k³ voxels → 256³ cells → 67 MB CPU + 67 MB texture, and one coarse setBrick fills 16.7M cells on the main thread. For very large datasets, migrate to a per-LOD table pyramid (shader walks fine→coarse; 2–3 loads worst case).
(e) Uniform struct duplication. volumeShader and computeShader embed hand-padded Uniforms structs with different field orders, mirrored by hand-maintained JS offsets — a layout-desync bug waiting for the next field. Generate WGSL struct + JS offsets from one description. Replace the injectConfig regex substitution (fails silently) with pipeline-overridable constants (override LOGICAL_BRICK_SIZE: f32 = 64.0; + constants: at pipeline creation); keep MAX_BRICK_TRAVERSALS injected if any driver refuses an override loop bound.
(f) Background compositing location. The compute kernel bakes bgColor in and writes alpha=1, so accumulation can't distinguish volume from background, and fragment/compute paths aren't interchangeable downstream. Store premultiplied vec4f(result.rgb, result.a) through accumulation (the accum shader already blends alpha correctly); composite background at blit. Required if the volume ever composites over anything but a solid color.
(g) Server-side ghost borders. The durable fix for P12's 27× amplification: bake the 1-voxel border into each stored brick so one fetch = one brick. Requires control of the data-preparation pipeline; makes the worker chunk cache nearly unnecessary.
(h) Per-LOD occupancy manifest. Offline-computed empty-brick bitmaps loaded at init make isBrickEmpty free pre-fetch (completes P5) and feed (a).
(i) BrickCache multichannel granularity. Per-channel cache keys with global LRU can half-cache a brick — handled correctly (per-channel network fallback), just cache-inefficient. Disappears if P6 caches interleaved bricks as one entry.

Suggested implementation order & grouping
Phase
Items
Rationale
1
P1 + P8c
Same declarations; fixes quality ceiling, removes a full-screen pass
2
P2, P3
Frame-loop dirty flag + one-line SSE fix — the two biggest cheap wins
3
P4
Data-integrity bug; small, isolated in the fetch store
4
P5
Plumb worker stats to the streamer; large sparse-dataset win
5
P9 + P14c
Same eviction code path: thrash guard + empty-marker regression + free() unpin
6
P7 + P13 (all)
One shader-refactor batch
7
P8a/b
Pass merge + depth discard
8
P10 (a→c)
Touch bug first (tiny), then hysteresis, then preallocation
9
P11, P12
Worker-side: assembly loop rewrite, affinity coarsening (instrument first — see below)
10
P6
Largest change (data path + shader + renderer); measure phases 1–9 first for a clean baseline
11
P14a/b, P15, P16
Hygiene, startup, small fixes
12
P17
Structural, as product needs dictate

Measurement notes
GPU: timestamp queries (timestamp-query feature) around compute/accum/render passes; Chrome --enable-dawn-features=allow_unsafe_apis for deeper paths; Xcode/PIX captures through Chrome for TBDR verification of P8.
Workers: the pipeline telemetry (avgFetchMs, avgAssemblyMs) is already in place — record before/after for P11. Add: chunk-cache hit rate, duplicate-fetch count across workers, wire bytes (P16d) — these three quantify P12.
Scenarios to baseline before Phase 1: (a) static camera, converged, single-channel; (b) static, 4-channel; (c) orbiting at each renderScale; (d) zoom gesture into a dense region on a cold atlas; (e) idle for 60 s with static camera (GPU utilization — P2's metric); (f) cold load of a sparse dataset (P5) and of a multichannel float dataset (P15).
Add counters to streaming stats: allocations refused (P9), indirection flushes + dirty size (P14a), samples/ray debug toggle (P7).



######

additional remarks regarding architectur and proposed next steps
Good timing for this question — the perf work in the document will go significantly smoother or rougher depending on what you fix structurally first. Here's my honest read of the whole system.
The good — keep and protect
The layering is fundamentally right. DataProvider as an abstraction (Zarr/sharded/local behind one interface), streaming policy (StreamingManager) separated from mechanism (AtlasAllocator, IndirectionTable, BrickCache as small focused units), renderer separated from the viewer driver, UI kept out of the library entirely. The dependency direction is mostly clean and acyclic. Many projects at this stage are a single 3000-line file; this isn't.
The worker pipeline is the correct architecture. Full fetch→decompress→assemble off the main thread, zero-copy transfers, telemetry built in from day one. The affinity dispatch and in-flight dedup show someone thought about the actual access patterns. The fixes needed (P11, P12) are tuning within a sound design, not redesign.
The virtual-texturing core is simple and correct. Flat indirection + LOD-in-w + parent-fallback eviction is an elegant minimal design — the shader lookup is one textureLoad, and eviction gracefully degrades instead of holing. The small classes (BrickCache, AtlasAllocator) are genuinely single-purpose and readable.
Modular WGSL files with a clear common/sampling/compositing/raymarching/mode split — much better than the monolithic shader strings most WebGPU projects have.
The bad — structural debt
Renderer is a god class, and it's the biggest problem. It owns: atlas textures, the indirection table, the allocator, seven pipelines (volume, wireframe, axis, slice, compute, blit, accum), all their bind groups, all uniform packing for three different layouts, TAA ping-pong state, render modes, channel colors/windows, windowing, clipping, slice state, and two complete render paths. It's simultaneously a rendering engine, a GPU resource registry, and a settings bag. The symptom that proves it: StreamingManager reaches into renderer.indirection, renderer.allocator, renderer.canvases, renderer.resetAccumulation — the streamer's real dependency is "volume GPU resources," but it gets the whole renderer. Every planned perf item (P1, P6, P7, P10c) touches this class, and each will make it worse if you don't split first.
The dual fragment/compute paths with divergent hand-packed uniform structs. Two Uniforms structs with different field orders, mirrored by hand-maintained offset comments and DataView writes. This is the single most likely source of your next mysterious bug — one added field, one missed offset, and you get silently-wrong rendering on one path only. And the fragment path is half-abandoned: no renderScale, no TAA, yet it's fully maintained. You're paying dual-path tax for one working path.
Shader assembly via string concatenation + regex constant injection. injectConfig fails silently if a pattern drifts; module composition order is implicit; the same constants live in both TS config and WGSL source. It works today, but it's the kind of infrastructure that punishes every future shader change.
Invalidation is scattered and implicit. resetAccumulation() is called from ~15 places: every renderer setter, every KilnViewer property wrapper (each hand-written, each forgettable), the streamer's debounce. There's no single notion of "the image is stale" — which is exactly the concept P2 (render-on-demand) needs. Right now adding a new parameter means remembering to sprinkle resets in two or three places.
The so-so
StreamingManager does a lot — visibility, LOD selection, queue management, loading, eviction bookkeeping, base-LOD bootstrap, stats — but it's internally coherent and reads well. It's at the size where the next feature should trigger a split (desired-set computation vs. load executor are the natural seam), but it doesn't need one today.
Stringly-typed brick identity. `lod${lod}:${bz}/${by}/${bx}` as the universal key works, but keys are constructed in at least five places with the coordinate order as an unwritten convention, and they allocate. A packed integer key (bitfields) would be faster and typo-proof — nice-to-have, not urgent.
KilnViewer.create is a 200-line procedural factory with a long repetitive options-application block. Factories are allowed to be procedural; the repetition is mild ugliness, not debt.
Two provider families with duplicated conversion logic (ZarrDataProvider workers vs. DecompressionPool/Worker for the sharded provider, each with their own uint16→float16 and 16→8 code). Tolerable if both providers are actively used; wasteful if the sharded path is legacy.
Vestigial code: Renderer.loadBrick/unloadBrick duplicate streamer logic and appear to be a pre-streaming legacy path; rayMarchSimple/useIndirection=false and sampleDirect are debug modes carried in production shaders; renderMode: 'fragment' as discussed.
What to rewrite before proceeding with the perf work
Three things, in order, and I'd genuinely gate the perf phases on the first two:
1. Uniform/binding single source of truth (do before P1/P6/P7 — i.e., before touching any shader). One TS description of each uniform struct that generates both the WGSL struct text and the JS packing offsets (a ~100-line codegen function, no build step needed — generate at module load). This isn't gold-plating: P1 changes texture formats and bindings, P6 removes three bindings and changes the sampling signature, P7 adds fields to BrickInfo flow-through, P8c merges accum uniforms into main uniforms. Doing four rounds of hand-offset surgery on two divergent structs is how you spend a week debugging a padding bug. Fold the injectConfig→override constants change into the same effort.
2. Kill or demote the fragment path (do before P6). Decide: if compute is the product, delete the fragment volume path (keep wireframe/axis/slice — those are genuinely rasterized) and its uniform struct, bind group, and pipeline. If you want to keep it for the proxy-box-culling advantage, then it must gain renderScale+TAA parity — which after fix #1 is cheap. Either decision halves the surface area of P6 and P10c. My recommendation: delete it; item 17c (bounding-rect dispatch) recovers the culling benefit within the compute path with less machinery.
3. Split Renderer along its natural seams (can be incremental, but start before P6/P10c). Three extractions, each mechanical:

VolumeResources — atlases, indirection, allocator, dummy texture, loadBrick upload helper. This is what StreamingManager actually depends on; hand it that instead of the renderer, and the renderer↔streamer coupling drops to resetAccumulation (which fix #4 below turns into an event).
PresentChain — compute output, accum ping-pong, blit, per-scale variants (P10c lands here naturally instead of adding five more members to Renderer).
What remains is Renderer proper: pipelines, uniform filling (now generated), pass encoding.

4. Unify invalidation (do with P2, it's the same work). One invalidate(reason) on the renderer/viewer that resets accumulation and sets the render-on-demand dirty flag. All setters call it; KilnViewer's property wrappers collapse to pass-throughs. This turns P2 from "add a flag and find every place that should set it" into "the flag already exists everywhere."
Simplification for maintainability, beyond the above
Delete dead weight: Renderer.loadBrick/unloadBrick, DecompressionPool (if the sharded provider is legacy — decide), and consider compiling the debug modes (rayMarchSimple, LOD-color mode) into a separate debug shader variant rather than shipping them in the production pipeline permanently. Extract forEachCoveredCell in the indirection table (three copy-pasted loops with subtly different predicates — already flagged as 14c's refactor). Consolidate the float16/bit-depth conversion into one shared module used by both worker families. And consider one small conceptual cleanup: the "canvas" naming (VolumeCanvas, writeToCanvas, canvases[]) collides with HTMLCanvasElement throughout the code — renaming to Atlas/writeToAtlas would remove a genuine reading hazard, since both kinds of "canvas" appear in the same files.
The honest summary: the macro-architecture is good and doesn't need rethinking — the bones are right. The debt is concentrated in one god class, one fragile hand-maintained mirror (uniforms), one half-abandoned dual path, and scattered invalidation. All four are precisely in the blast radius of the planned perf work, which is why I'd sequence them first: roughly a week of restructuring that makes the perf document's phases 1–10 land on clean seams instead of adding mass to the heaviest class in the codebase.
