# Patches for camera.ts, renderer.ts, kiln-viewer.ts

Three files receive only small, surgical edits — delivered as exact find/replace
blocks rather than full-file replacements. Apply top to bottom. The three full
replacement files (`streaming-manager.ts`, `atlas-allocator.ts`,
`tolerant-fetch-store.ts`) ship alongside this document.

---

## 1. camera.ts — A1.2 (camera version counter)

Every camera mutation path (orbit, pan, zoom, touch, `setUpAxis`, `resetPan`,
`setOrbitState`) already funnels through `updatePosition()`. A monotonic version
counter incremented there lets the viewer detect *any* camera change — including
programmatic ones that never touch `lastInteractionTime`.

### 1a. Add the field (next to the other private state)

**Find:**
```ts
  // Clamp away from poles to avoid degenerate view matrix
  private poleEpsilon = 0.001;
```

**Replace with:**
```ts
  // Clamp away from poles to avoid degenerate view matrix
  private poleEpsilon = 0.001;

  // Monotonic counter incremented on every camera state change, including
  // programmatic ones (setOrbitState / setUpAxis / resetPan). The viewer
  // compares this per frame to catch changes that bypass input handlers.
  private version_ = 0;

  /** Changes whenever the camera state changes (any mutation path). */
  get version(): number {
    return this.version_;
  }
```

### 1b. Increment in updatePosition()

**Find:**
```ts
  private updatePosition() {
    const cosX = Math.cos(this.rotationX);
```

**Replace with:**
```ts
  private updatePosition() {
    this.version_++;
    const cosX = Math.cos(this.rotationX);
```

---

## 2. renderer.ts — A1.3 (slice mode convergence) + A1.4 (clean frame when TAA off)

### 2a. isConverged must account for slice mode

Slice mode skips the compute + accumulation passes, so `accumFrameCount` never
advances — with TAA on, `isConverged` stayed false forever and render-on-demand
was fully defeated in slice mode (continuous full-pipeline rendering of a
static image).

**Find:**
```ts
  get isConverged(): boolean {
    // TAA off: every frame is identical (no jitter), converged after 1 frame
    // TAA on: converged once accumulation reaches the 64-frame cap
    return !this.enableTAA || this.active.accumFrameCount >= 64;
  }
```

**Replace with:**
```ts
  get isConverged(): boolean {
    // Slice mode: no accumulation runs, so accumFrameCount never advances —
    // it is converged after one frame (slice setters go through
    // resetAccumulation → onDirty, so parameter changes still re-render).
    // TAA off: every frame is identical (jitter is gated on TAA below),
    // converged after 1 frame.
    // TAA on: converged once accumulation reaches the 64-frame cap.
    return this.volumeRenderMode === 'slice'
      || !this.enableTAA
      || this.active.accumFrameCount >= 64;
  }
```

### 2b. Gate jitter on TAA (decision A1.4)

With render-on-demand, TAA-off freezes on a single frame. If that frame were
jittered it would freeze *noisy*. Gating jitter on TAA makes the frozen frame
clean; with TAA on, behavior is unchanged.

**Find (inside `renderCompute`, in the uniform-write block):**
```ts
    dv.setUint32(o.jitter, this.enableJitter ? 1 : 0, true);
```

**Replace with:**
```ts
    // Jitter only makes sense when TAA averages it out. With render-on-demand,
    // TAA-off converges after one frame — that frame must not be jittered or
    // the display freezes on visible noise (A1.4).
    dv.setUint32(o.jitter, (this.enableJitter && this.enableTAA) ? 1 : 0, true);
```

---

## 3. kiln-viewer.ts — A1.2 wiring, B1 wiring, B7.1

### 3a. Add the camera-version tracking field

**Find:**
```ts
  private disposed = false;
  private dirty = true;
```

**Replace with:**
```ts
  private disposed = false;
  private dirty = true;
  private lastCameraVersion = -1;
```

### 3b. frame(): detect programmatic camera changes + sync SSE render scale

**Find:**
```ts
    // Drop to 0.25 during camera interaction; restore to user scale afterward
    const interacting = this.camera.isInteracting();
    const targetScale = interacting ? 0.25 : this.userRenderScale;
    if (this.renderer.renderScale !== targetScale) {
      this.renderer.activateScale(targetScale);
      this.dirty = true;
    }
```

**Replace with:**
```ts
    // Drop to 0.25 during camera interaction; restore to user scale afterward
    const interacting = this.camera.isInteracting();
    const targetScale = interacting ? 0.25 : this.userRenderScale;
    if (this.renderer.renderScale !== targetScale) {
      this.renderer.activateScale(targetScale);
      this.dirty = true;
    }

    // A1.2: any camera change — including programmatic setOrbitState /
    // setUpAxis / resetPan, which never touch lastInteractionTime — marks
    // the frame dirty. The renderer's own vpChanged detection handles the
    // accumulation reset once render() actually runs.
    if (this.camera.version !== this.lastCameraVersion) {
      this.lastCameraVersion = this.camera.version;
      this.dirty = true;
    }

    // B1/P3: keep SSE LOD selection in sync with the resolution actually
    // being rendered (0.25 during interaction, user scale otherwise).
    this.streamingManager.renderScale = this.renderer.renderScale;
```

### 3c. resize(): preallocate the user scale too (B7.1)

Without this, if the user scale ≠ the constructor default, the first
gesture-end after a resize builds a scale set on the spot — the exact
allocation spike the per-scale preallocation was meant to remove.

**Find:**
```ts
      this.renderer.resize(width, height);
      this.renderer.prepareScale(0.25);
      this.dirty = true;
```

**Replace with:**
```ts
      this.renderer.resize(width, height);
      this.renderer.prepareScale(0.25);
      this.renderer.prepareScale(this.userRenderScale);
      this.dirty = true;
```

### 3d. renderScale setter: preallocate + dirty

Changing the user scale currently defers the scale-set build to the next
gesture end and relies on the frame loop's scale-mismatch branch to dirty.
Make both explicit.

**Find:**
```ts
  get renderScale(): number { return this.userRenderScale; }
  set renderScale(value: number) {
    this.userRenderScale = value;
  }
```

**Replace with:**
```ts
  get renderScale(): number { return this.userRenderScale; }
  set renderScale(value: number) {
    this.userRenderScale = value;
    // Build the scale set now (off the gesture path) and re-render.
    this.renderer.prepareScale(value);
    this.dirty = true;
  }
```

---

## Behavioral notes / what to verify after applying

1. **Cold load, static camera** — image now progressively appears while the
   base LOD streams in, and the final complete base LOD is displayed without
   any input (A1.1, in streaming-manager.ts).
2. **Console `viewer.camera.setOrbitState([0.3, 2.0, 4])`** with a static
   mouse — re-renders within one frame (A1.2).
3. **Slice mode, idle** — GPU utilization drops to ~0; slice sliders still
   respond immediately (A1.3).
4. **`clear()` twice on a dataset** — `allocator.pinnedCount` equals the
   base-LOD brick count after each reload, not a multiple of it (A2.1).
5. **Shrink the atlas below demand, zoom into a dense region, hold still** —
   network traffic stops (backpressure), no warn spam, `allocationsRefused`
   climbs then stabilizes, accumulation converges (A2.2). Note the new
   `allocationsRefused` field in `StreamingStats` — if your UI destructures
   stats exhaustively, add the field there.
6. **Sparse dataset, cold load** — pinned count equals *non-empty* base bricks;
   `atlasUsage` proportional to occupancy (A3.1).
7. **Block one channel's chunks in devtools** — bricks render with the
   remaining channels instead of disappearing entirely; the blocked channel's
   region reads as zero, not ghost data from an evicted brick (A3.3).
8. **Orbit at renderScale 0.25** — streaming stats show a substantially smaller
   `desiredCount` than at 1.0 for the same view; on stop, fine bricks stream
   in (B1).
9. **Interaction hysteresis + camera version**: during a drag, `version`
   changes every frame — this redundantly sets `dirty`, which is harmless
   (interaction already forces rendering).
