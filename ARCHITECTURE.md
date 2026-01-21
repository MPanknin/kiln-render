# Kiln Architecture

This document provides a technical deep-dive into Kiln's virtual texturing system for volumetric data.

## System Overview

Kiln implements a **virtual texturing** system that decouples the logical volume address space from physical GPU memory. This allows rendering of datasets that far exceed available VRAM by streaming only the visible, high-priority regions on demand.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Application Layer                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  StreamingManager           │  Camera + Frustum        │  UI / Controls     │
│  - Desired set computation  │  - View-projection       │  - Transfer func   │
│  - Priority queue           │  - Frustum planes        │  - Render mode     │
│  - Request lifecycle        │  - Distance calculation  │  - LOD thresholds  │
├─────────────────────────────────────────────────────────────────────────────┤
│                              Residency Management                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  AtlasAllocator             │  IndirectionTable        │  BrickLoader       │
│  - LRU slot tracking        │  - Virtual→Physical map  │  - HTTP Range I/O  │
│  - Eviction selection       │  - Multi-LOD support     │  - Index parsing   │
│  - Metadata bookkeeping     │  - Empty brick markers   │  - Brick cache     │
├─────────────────────────────────────────────────────────────────────────────┤
│                              GPU Resources                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  Atlas Texture (3D)         │  Indirection Texture     │  Compute Pipeline  │
│  - 528³ r8unorm             │  - Grid³ rgba8uint       │  - Ray generation  │
│  - 8×8×8 = 512 slots        │  - Per-cell LOD + slot   │  - Brick traversal │
│  - 66³ per slot (w/ border) │  - 255 = empty marker    │  - Compositing     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Virtual Texturing Pipeline

The core insight is that volumetric data exhibits strong spatial coherence: only a small working set of bricks is visible at any moment. By virtualizing the address space, we can map an arbitrarily large logical volume onto a fixed-size physical cache.

### 1. Brick Decomposition

The source volume is pre-processed into a multi-resolution **brick pyramid**:

```
Original Volume: 1024 × 512 × 1024 voxels
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ LOD 0 (1:1)    16×8×16 = 2,048 bricks   64³ logical voxels │
│ LOD 1 (1:2)     8×4×8  =   256 bricks   covers 128³ region │
│ LOD 2 (1:4)     4×2×4  =    32 bricks   covers 256³ region │
│ LOD 3 (1:8)     2×1×2  =     4 bricks   covers 512³ region │
└─────────────────────────────────────────────────────────────┘
```

Each brick is 64³ **logical voxels**, stored as 66³ **physical voxels** with a 1-voxel border for correct trilinear interpolation at brick boundaries. Bricks are serialized into per-LOD binary files with a JSON index containing byte offsets and statistics (min/max/avg intensity).

### 2. Indirection Table

The **indirection table** is a 3D texture (`rgba8uint`) dimensioned to the LOD 0 brick grid. Each texel encodes:

| Channel | Purpose                                           |
|---------|---------------------------------------------------|
| R       | Atlas slot X coordinate (0-7)                     |
| G       | Atlas slot Y coordinate (0-7)                     |
| B       | Atlas slot Z coordinate (0-7)                     |
| A       | LOD level + 1 (0=unloaded, 1-4=LOD 0-3, 255=empty)|

When a coarse LOD brick is loaded, it fills **multiple cells** in the indirection table proportional to its coverage. A LOD 2 brick covers a 4×4×4 region in the LOD 0 grid, so 64 cells are updated with the same atlas coordinates. This enables seamless LOD transitions without shader-side LOD selection logic.

```
Indirection Table (LOD 0 grid)              Atlas Texture
┌───┬───┬───┬───┬───┬───┬───┬───┐          ┌─────────────────┐
│2,1│2,1│3,0│3,0│   │   │   │   │          │ Slot (2,1,0)    │
│,0 │,0 │,1 │,1 │...│...│...│...│    ───►  │ Contains LOD 1  │
├───┼───┼───┼───┼───┼───┼───┼───┤          │ brick data      │
│2,1│2,1│3,0│3,0│   │   │   │   │          └─────────────────┘
│,0 │,0 │,1 │,1 │...│...│...│...│
└───┴───┴───┴───┴───┴───┴───┴───┘
  ▲
  └── 2×2 region filled by single LOD 1 brick
```

When a finer LOD brick loads, it **overwrites** only its specific cell, leaving coarser LOD data in adjacent cells. The shader always reads the cell corresponding to the current sample position, automatically getting the finest available resolution.

### 3. Atlas Texture

The **atlas** is a single 3D texture (`528³ r8unorm`) organized as an 8×8×8 grid of 66³ slots:

```
Atlas Layout (528³ total)
┌──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│ 0,0,0│ 1,0,0│ 2,0,0│ 3,0,0│ 4,0,0│ 5,0,0│ 6,0,0│ 7,0,0│  ← Z=0 layer
├──────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│ 0,1,0│ 1,1,0│ ...  │      │      │      │      │      │
├──────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│      │      │      │      │      │      │      │      │
   ...            512 total slots (8×8×8)           ...
```

Each slot stores 66³ voxels = 287,496 bytes. Total atlas size: **147 MB** fixed VRAM footprint regardless of source volume size.

The 1-voxel **ghost border** duplicates neighboring brick data to enable hardware trilinear filtering without seams:

```
Physical Brick (66³)
┌─────────────────────────────────────────┐
│ G │                                 │ G │  G = Ghost voxels (duplicated from neighbors)
├───┼─────────────────────────────────┼───┤
│   │                                 │   │
│ G │      Logical Data (64³)         │ G │
│   │                                 │   │
├───┼─────────────────────────────────┼───┤
│ G │                                 │ G │
└─────────────────────────────────────────┘
```

---

## Streaming Manager

The **StreamingManager** (`src/streaming/streaming-manager.ts`) implements a **resident set manager** that decides which bricks should occupy the atlas based on camera position, viewing frustum, and distance-based LOD selection.

### Desired Set Computation

Each frame (throttled to every N frames while camera moves), the manager performs:

1. **Octree Traversal**: Starting from the coarsest LOD, recursively descend based on distance thresholds
2. **Frustum Culling**: Reject bricks whose AABBs lie entirely outside the view frustum
3. **LOD Selection**: At each node, decide whether to use this LOD or split to children

```typescript
const traverse = (bx, by, bz, lod) => {
  const aabb = getBrickAABB(bx, by, bz, lod);

  // Frustum cull
  if (!isAABBInFrustum(aabb, frustumPlanes)) return;

  // Distance-based LOD decision
  const dist = distance(cameraPos, aabbCenter(aabb));
  const shouldSplit = lod > 0 && dist < lodThresholds[lod - 1];

  if (shouldSplit && finerLodExists(lod - 1)) {
    // Recurse to 8 children at finer LOD
    for (child of getChildren(bx, by, bz, lod)) {
      traverse(child.x, child.y, child.z, lod - 1);
    }
  } else {
    // This brick is desired
    desiredSet.add({ lod, bx, by, bz, distance: dist });
  }
};
```

The LOD thresholds define the distance at which each level splits:

| Threshold | Distance | Effect                                  |
|-----------|----------|-----------------------------------------|
| LOD 3→2   | 4.0      | Coarsest splits when moderately close   |
| LOD 2→1   | 2.0      | Medium detail at intermediate distance  |
| LOD 1→0   | 0.5      | Finest detail only when very close      |

### Priority Queue and Request Management

After computing the desired set, the manager:

1. **Cancels stale requests**: In-flight fetches for bricks no longer in desired set are aborted via `AbortController`
2. **Touches loaded bricks**: Updates LRU timestamps for bricks that remain desired
3. **Queues missing bricks**: Sorts by distance, closest first (prioritizes visible regions)
4. **Rate limits requests**: Maximum 4 concurrent HTTP requests to avoid network saturation

```
Desired Set: [A, B, C, D, E, F, G, H]  (sorted by distance)
Currently Loaded: [A, B, X, Y, Z]
In-Flight: [C]
                     │
                     ▼
Actions:
  - Touch A, B (update LRU)
  - Cancel X, Y, Z if in-flight (no longer needed)
  - Keep C in-flight (still desired)
  - Queue D, E, F, G, H (limited to max 4 concurrent)
```

### LRU Eviction

When the atlas is full, the **AtlasAllocator** (`src/streaming/atlas-allocator.ts`) evicts the **least recently used** brick:

```typescript
allocate(frame: number): AllocationResult {
  // Try free list first
  if (freeList.length > 0) {
    return { slot: freeList.pop(), evicted: null };
  }

  // Find LRU victim
  let victim = -1, oldestFrame = Infinity;
  for (slot of usedSlots) {
    if (lastUsedFrame[slot] < oldestFrame) {
      oldestFrame = lastUsedFrame[slot];
      victim = slot;
    }
  }

  // Evict and return
  const evicted = slotMetadata[victim];
  indirectionTable.clear(evicted.bx, evicted.by, evicted.bz, evicted.lod);
  return { slot: victim, evicted };
}
```

**Pinned bricks** (the coarsest LOD) are never evicted, ensuring a complete fallback representation always exists.

---

## Network Streaming

The **BrickLoader** (`src/streaming/brick-loader.ts`) uses **HTTP Range requests** to fetch individual bricks without downloading entire LOD files:

```
GET /datasets/volume/lod0.bin
Range: bytes=1835008-2122503
                │
                ▼
┌─────────────────────────────────────────┐
│ lod0.bin (concatenated brick data)      │
│ ┌─────┬─────┬─────┬─────┬─────┬─────┐  │
│ │  0  │  1  │  2  │  3  │ ... │ N   │  │
│ └─────┴─────┴──▲──┴─────┴─────┴─────┘  │
│                │                        │
│     Byte range for brick 2 only         │
└─────────────────────────────────────────┘
```

The **index file** (`lod0_index.json`) provides byte offsets, sizes, and pre-computed statistics:

```json
{
  "entries": {
    "0/0/0": { "offset": 0, "size": 287496, "min": 0, "max": 45, "avg": 12.3 },
    "1/0/0": { "offset": 287496, "size": 287496, "min": 0, "max": 0, "avg": 0 }
  }
}
```

**Empty brick detection**: Before fetching, the loader checks if `max < threshold`. Bricks with no significant data are marked empty in the indirection table (LOD = 255) without any network request.

Network statistics are tracked in real-time:
- **Throughput**: Rolling 2-second window of bytes/second
- **Total downloaded**: Cumulative bytes since session start
- **Request count**: Total HTTP requests issued

---

## Raymarching Pipeline

Kiln implements a **compute shader** raymarcher (`src/shaders/`) that generates one thread per pixel:

```wgsl
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    // 1. Generate ray from pixel coordinates
    let ndc = pixelToNDC(globalId.xy, screenSize);
    let ray = generateRay(ndc, inverseViewProj, cameraPos);

    // 2. Intersect volume bounding box
    let hit = intersectBox(ray, volumeAABB);
    if (hit.tNear > hit.tFar) { return; }  // Miss

    // 3. Brick-aware raymarching
    var t = hit.tNear;
    var color = vec3f(0.0);
    var alpha = 0.0;

    for (var iter = 0u; iter < MAX_BRICK_TRAVERSALS; iter++) {
        let brick = setupBrick(ray, t);

        if (!brick.valid) {
            t = brick.tEnd;  // Skip unloaded/empty region
            continue;
        }

        // March through this brick
        for (var i = 0u; i < brick.numSteps; i++) {
            let sample = sampleAtlas(ray, t, brick.indirection);
            composeSample(sample, &color, &alpha);

            if (alpha > 0.95) { break; }  // Early ray termination
            t += brick.stepSize;
        }

        t = brick.tEnd;
    }

    textureStore(output, globalId.xy, vec4f(color, alpha));
}
```

### Brick Traversal

For each ray segment, the shader:

1. **Computes brick index**: `floor(voxelPos / LOGICAL_BRICK_SIZE)`
2. **Looks up indirection**: `textureLoad(indirectionTexture, brickIndex)`
3. **Calculates brick exit**: Ray-box intersection with brick AABB
4. **Samples within brick**: Steps through at adaptive rate based on LOD

```wgsl
fn setupBrick(ray, t) -> BrickInfo {
    let voxelPos = worldToVoxel(ray.origin + ray.dir * t);
    let brickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);

    let indirection = textureLoad(indirectionTexture, brickIndex, 0);

    // w=0: not loaded, w=255: known empty
    info.valid = indirection.w > 0u && indirection.w < 255u;

    if (info.valid) {
        info.lodScale = exp2(f32(indirection.w) - 1.0);
        info.stepSize = computeStepSize(brickSize, lodScale);
    }

    return info;
}
```

### Atlas Sampling

The shader transforms logical voxel coordinates to atlas texture coordinates:

```wgsl
fn sampleAtlas(voxelPos: vec3f, indirection: vec4u, lodScale: f32) -> f32 {
    // Position within logical brick [0, 64)
    let posInBrick = (voxelPos % (LOGICAL_BRICK_SIZE * lodScale)) / lodScale;

    // Atlas base from integer slot indices
    let atlasBase = vec3f(indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE;

    // Offset by border (1 voxel), add 0.5 for texel center
    let atlasUV = atlasBase + (posInBrick + BORDER + 0.5) / ATLAS_SIZE;

    return textureSampleLevel(volumeTexture, volumeSampler, atlasUV, 0.0).r;
}
```

The `lodScale` factor handles coarse LOD sampling: a LOD 2 brick covers 256³ logical voxels but only contains 64³ actual samples, so coordinates are divided by 4 before indexing into the brick.

### Compositing Modes

| Mode | Algorithm | Use Case |
|------|-----------|----------|
| **DVR** | Front-to-back alpha compositing with transfer function | General visualization |
| **MIP** | Maximum intensity along ray | Angiography, vessel detection |
| **ISO** | First surface at threshold + Phong shading | Surface extraction |
| **LOD** | Color-coded by resolution level | Debug LOD distribution |

DVR compositing uses the optical model with extinction:

```wgsl
fn composeSample(density, stepSize, color, alpha) {
    let tfColor = textureSample(transferFunction, density);
    let extinction = tfColor.a * stepSize * volumeScale;
    let sampleAlpha = 1.0 - exp(-extinction);

    // Front-to-back blending
    *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
    *alpha += sampleAlpha * (1.0 - *alpha);
}
```

---

## Memory Budget Analysis

For a 1024³ volume with 4 LOD levels:

| Resource | Size | Notes |
|----------|------|-------|
| Atlas texture | 147 MB | 528³ × 1 byte |
| Indirection table | 128 KB | 16×8×16 × 4 bytes (LOD 0 grid) |
| Brick indices (CPU) | ~2 MB | JSON with offsets/stats |
| Total VRAM | **~150 MB** | Constant regardless of volume size |

Source data on disk/network:

| LOD | Bricks | Disk Size |
|-----|--------|-----------|
| 0 | 2,048 | 589 MB |
| 1 | 256 | 74 MB |
| 2 | 32 | 9 MB |
| 3 | 4 | 1 MB |
| **Total** | 2,340 | **673 MB** |

At any moment, only ~512 bricks (the atlas capacity) are resident, representing <25% of the finest LOD. The system dynamically pages the optimal subset based on view.

---

## Design Decisions

### 1. Distance-based LOD Selection

Simple distance thresholds determine when to use finer/coarser LODs. This approach is predictable, debuggable, and performs well for most use cases. The thresholds are hand-tuned for visible LOD bands at typical viewing distances.

### 2. LRU Eviction

Frame-based touch tracking identifies which bricks were recently used. Bricks not touched for the longest time are evicted first when the atlas is full. This naturally prioritizes the current working set.

### 3. Differential Updates

Only load bricks that are missing; touch existing ones to keep them fresh. This minimizes network requests and GPU uploads when the camera moves incrementally.

### 4. Empty Brick Skipping

Pre-computed statistics (min/max/avg) in the index file allow skipping bricks with no useful data before any network request. This is particularly effective for sparse volumes like CT scans with large air regions.

### 5. Multi-slot Indirection

Coarse LOD bricks fill multiple cells in the indirection table (2^lod per dimension), with LOD priority to prevent coarse from overwriting fine. This enables seamless LOD transitions handled entirely by the indirection lookup.

### 6. LOD 255 = Empty Marker

A special indirection value indicates "known empty, don't render" so coarse data doesn't bleed through holes in finer LODs.

### 7. 66³ Physical Bricks

The 1-voxel overlap on all sides enables seamless trilinear filtering at brick boundaries without special-case shader logic.

### 8. Pinned Base LOD

The coarsest LOD is loaded at startup and never evicted, ensuring there's always a complete (if low-resolution) representation available while finer data streams in.

---

## File Structure

```
src/
├── core/
│   ├── renderer.ts          # WebGPU renderer, pipelines, uniforms
│   ├── camera.ts            # Arcball camera with frustum extraction
│   ├── indirection.ts       # Indirection table management
│   ├── transfer-function.ts # 1D transfer function texture
│   ├── volume.ts            # Atlas texture creation/upload
│   └── config.ts            # Constants and dataset configuration
├── streaming/
│   ├── streaming-manager.ts # Resident set manager, LOD selection
│   ├── brick-loader.ts      # HTTP Range request brick loading
│   └── atlas-allocator.ts   # LRU slot allocation
├── shaders/
│   ├── common.wgsl          # Constants, coordinate transforms
│   ├── sampling.wgsl        # Indirection lookup, atlas sampling
│   ├── raymarching.wgsl     # Brick traversal core
│   ├── dvr.wgsl             # Direct volume rendering
│   ├── mip.wgsl             # Maximum intensity projection
│   ├── iso.wgsl             # Isosurface rendering
│   └── ...
├── ui/
│   └── volume-ui.ts         # Tweakpane controls and stats display
├── utils/
│   └── geometry.ts          # Box and axis geometry generation
└── main.ts                  # Entry point, initialization
```

---

## References

- Virtual Texturing / Megatextures (id Tech 5)
- Sparse Voxel Octrees
- Out-of-core volume rendering (VTK, ParaView)
- NVIDIA IndeX brick-based streaming
- OpenVDS (OSDU)
