# Streaming manager

The **StreamingManager** (`src/streaming/streaming-manager.ts`) implements a **resident set manager** that decides which bricks should occupy the atlas based on camera position, viewing frustum, and screen-space error (SSE) based LOD selection.

## Desired set computation

Every 10 frames, and immediately when the camera stops, the manager performs:

1. **Hierarchy traversal**: Starting from the coarsest LOD, recursively descend based on screen-space error
2. **Frustum culling**: Reject bricks whose AABBs lie entirely outside the view frustum
3. **SSE-based LOD selection**: At each node, compute screen-space error to decide whether to split
4. **Skipping**: Bricks known to be empty are never requested, and with [ray guidance](#ray-guided-selection) neither are bricks no ray reached

The desired set keeps being recomputed while the camera moves, so stale requests are cancelled promptly, but new requests are only dispatched once the interaction ends.

```typescript
const traverse = (bx, by, bz, lod) => {
  const aabb = getBrickAABB(bx, by, bz, lod);

  // Frustum cull
  if (!isAABBInFrustum(aabb, frustumPlanes)) return;

  // Screen-space error LOD decision
  const dist = distance(cameraPos, aabbCenter(aabb));
  const voxelWorldSize = getVoxelWorldSize(lod); // this level's voxel size, from the pyramid
  const projectedError = (voxelWorldSize / dist) * projectionFactor;
  const shouldSplit = lod > 0 && projectedError > maxPixelError;

  if (shouldSplit && finerLodExists(lod - 1)) {
    // Recurse into the children at the finer LOD: 1 or 2 per axis, depending on
    // how that level was downsampled (8 for a uniform 2:1 pyramid)
    for (child of getChildren(bx, by, bz, lod)) {
      traverse(child.x, child.y, child.z, lod - 1);
    }
  } else {
    // This brick is desired
    desiredSet.add({ lod, bx, by, bz, distance: dist });
  }
};
```

**Screen-Space Error (SSE)** measures how many pixels a voxel projects to on screen. When the projected error exceeds `maxPixelError` (default 8 pixels, URL parameter `sse`), the brick splits to a finer LOD. Between 0.7× and 1× the threshold, a brick stays split only if its children are already resident; this hysteresis prevents LOD oscillation during gestures. This approach adapts automatically to:
- Screen resolution (higher res = more splits for same view)
- Field of view (narrower FOV = more detail at same distance)
- Anisotropic voxel spacing (non-uniform datasets)

## Base load

Before any refinement, the coarsest level is loaded in full and pinned in the atlas. How that load is ordered decides how soon the user sees anything, so it is deliberately not "everything at once":

1. **Cheapest bricks first.** Each provider can estimate a brick's cost (`estimateBrickCost`, the number of source chunks it touches). Bricks are sorted by cost, then centre-out, so the first image needs the fewest bytes.
2. **Ramp-up window.** The load starts with two tasks in flight and doubles the window every time a task finishes, up to `maxConcurrentRequests × channels`. On a bandwidth-bound link this lets the first brick own the connection instead of sharing it with eleven others that would all land together at the end.
3. **Channel-major order.** For multichannel data every brick's first visible channel is fetched before any brick's second channel. A brick is committed to the atlas the moment its first channel arrives (a recycled slot has its stale channels zeroed first), so a complete one-channel image appears in roughly 1/N of the full base time and the other channels fill in afterwards. The `baseChannel0Complete` milestone marks that point.
4. **Visible channels only.** Channels the renderer hides (alpha weight 0, from OMERO `active` or `visibleChannels`) are not streamed. When a channel is shown later, resident bricks are backfilled with it; hiding a channel costs nothing.
5. **First frame now.** The first committed brick bypasses the accumulation-reset debounce so it is presented immediately.

Measured on a throttled 10 MB/s, 40 ms link this took first content for a 4-channel light-sheet embryo (whole-plane chunks) from 3.3 s to 0.6 s, and for a 4-channel 128³-chunked fly brain from 13.6 s to 0.5 s; time to a fully loaded base is unchanged because it is bandwidth-bound.

## Refinement while interacting

Refined bricks follow the same "show data as soon as it exists" rule as the base load:

- **Progressive multichannel commit.** A refined brick fetches its first visible channel before the others and is committed to the atlas as soon as that channel arrives with signal. Channels still in flight are filled with the currently displayed ancestor's data, nearest-neighbour resampled into the new slot, so they look exactly as before at coarse resolution; each real channel overwrites its stand-in on arrival. If the ancestor's data is not in the CPU cache the brick waits for all channels, and bricks that are dark in every channel are still marked empty.
- **Worker chunk cache sized to the data.** Each decode worker keeps up to 8 of the largest chunks it has seen (64–256 MB). With whole-plane chunks every brick of a Z range needs the same planes; a cache smaller than that re-downloaded them.

Measured on a 10 MB/s, 40 ms link: first new detail after a zoom on a 4-channel embryo 11.5 s → 3.2 s, on 4-channel yeast 4.4 s → 1.0 s, with identical converged images; a pan across the embryo re-converges in 2.1 s instead of 5.4 s with 97% fewer bytes.

## Ray-guided selection

> **Experimental**, behind the `?rayguide=1` URL flag.

Frustum culling and SSE keep bricks that are in view, but many of them are hidden behind opaque material or outside the clip box. With ray guidance, the renderer tells the streaming manager which bricks the rays actually reached:

1. While marching, the compute shader sets one bit per LOD 0 brick cell a ray enters before it terminates. In ISO mode, the cells next to the surface that the gradient taps read are marked too.
2. The renderer copies the bitset back every 4 frames, and once more when accumulation converges, so the last view is always reported.
3. A brick finer than the base level is desired only if a ray entered one of its cells within the last 16 rendered frames. Frames rather than wall time: a still, converged image stops rendering, and what was visible stays visible.

The base level is never culled, so everything stays displayable at coarse resolution. Slice mode marches no rays and turns guidance off. The stats panel and `?bench=1` report how many bricks guidance left out. Gains are largest in views that refine deep into the finest levels.

## Priority queue and request management

After computing the desired set, the manager:

1. **Cancels stale requests**: In-flight fetches for bricks no longer in desired set are aborted via `AbortController`
2. **Touches loaded bricks**: Updates LRU timestamps for bricks that remain desired
3. **Queues missing bricks**: Sorts by distance, closest first (prioritizes visible regions)
4. **Rate limits requests**: Caps concurrent requests (8 single-channel, 12 multichannel) to avoid network saturation. Stale requests wait a 200 ms grace period before cancellation so brief LOD oscillation doesn't thrash fetches

![How the desired set is reconciled with loaded and in-flight bricks](../diagrams/desired-set.svg)

## LRU eviction

When the atlas is full, the **AtlasAllocator** (`src/streaming/atlas-allocator.ts`) evicts the **least recently used** brick:

```typescript
allocate(frame: number): AllocationResult {
  // Try free list first
  if (freeList.length > 0) {
    return { slot: freeList.pop(), evicted: null };
  }

  // Find LRU victim, skipping pinned and recently touched slots
  let victim = -1, oldestFrame = Infinity;
  for (slot of usedSlots) {
    if (pinned.has(slot) || frame - lastUsedFrame[slot] < MIN_EVICTION_AGE) continue;
    if (lastUsedFrame[slot] < oldestFrame) {
      oldestFrame = lastUsedFrame[slot];
      victim = slot;
    }
  }
  if (victim === -1) return null; // nothing evictable: the brick stays desired and retries

  // Reuse the slot; the caller repoints the evicted brick's cells at its displayed ancestor
  const evicted = slotMetadata[victim];
  return { slot: victim, evicted };
}
```

**Pinned bricks** (the coarsest LOD) are never evicted, ensuring a complete fallback representation always exists. Slots touched within the last 30 frames are also protected, so a freshly loaded brick can't be evicted by the next allocation in the same burst (thrash guard). When the streaming manager receives an evicted brick, it points that brick's indirection cells back at the coarser ancestor still on screen, or marks them empty when that ancestor is known empty.
