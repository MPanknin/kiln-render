# Design decisions

## 1. Screen-space error LOD selection

SSE determines when to use finer/coarser LODs based on how many pixels a voxel projects to. This adapts automatically to screen resolution, FOV, and viewing distance. A single threshold (`maxPixelError`, default 8 pixels) controls the quality/performance tradeoff.

## 2. LRU eviction

Frame-based touch tracking identifies which bricks were recently used. Bricks not touched for the longest time are evicted first when the atlas is full. This naturally prioritizes the current working set.

## 3. Differential updates

Only load bricks that are missing; touch existing ones to keep them fresh. This minimizes network requests and GPU uploads when the camera moves incrementally.

## 4. Empty brick skipping

Pre-computed statistics (min/max/avg) in Kiln's sharded binary index file allow skipping bricks with no useful data before any network request. For OME-Zarr, a brick found empty after assembly is remembered and never requested again. This is particularly effective for sparse volumes like CT scans with large air regions or microscopy with dark background.

## 5. Multi-slot indirection

Coarse LOD bricks fill multiple cells in the indirection table (2^lod per dimension in a 2:1 pyramid; native pyramids use each level's per-axis factors), with LOD priority to prevent coarse from overwriting fine. This enables seamless LOD transitions handled entirely by the indirection lookup.

## 6. LOD 255 = empty marker

A special indirection value indicates "known empty, don't render" so coarse data doesn't bleed through holes in finer LODs.

## 7. 66³ physical bricks

The 1-voxel overlap on all sides enables seamless trilinear filtering at brick boundaries without special-case shader logic.

## 8. Pinned base LOD

The coarsest LOD is loaded at startup and never evicted, ensuring there's always a complete (if low-resolution) representation available while finer data streams in.

## 9. Compute shader raymarching

Kiln uses compute shaders rather than fragment shaders for raymarching. The core loop is one thread per pixel — functionally identical to a fullscreen-triangle fragment shader — so the raymarching itself doesn't rely on compute-specific features like shared memory or subgroup operations. The practical benefits are pipeline simplicity (compute-to-compute chaining for temporal accumulation, direct `textureStore` output, resolution scaling without intermediate framebuffers) and future headroom for GPU-native optimizations (shared memory, subgroups, indirect dispatch). See [WebGPU Notes](/reference/webgpu) for details.
