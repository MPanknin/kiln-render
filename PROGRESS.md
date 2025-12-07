# Kiln - Progress

## Overview
A minimal, clean WebGPU volume renderer using proxy box geometry and brick-based virtual texturing. Designed for out-of-core rendering of arbitrarily large volumes.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (core module - COMPLETE)                          │
│  - Atlas texture (512³)                                     │
│  - Multi-LOD indirection table                              │
│  - Atlas allocator                                          │
│  - Compute shader raycasting                                │
└─────────────────────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────────────────────┐
│  StreamingManager (COMPLETE)                                │
│  - SSE-based LOD selection                                  │
│  - Priority queue for loading                               │
│  - Budget-aware eviction                                    │
│  - Hysteresis to prevent flickering                         │
└─────────────────────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────────────────────┐
│  Octree (COMPLETE)                                          │
│  - Hierarchical brick organization                          │
│  - Parent/child relationships                               │
│  - Multi-LOD traversal                                      │
└─────────────────────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────────────────────┐
│  BrickLoader (COMPLETE)                                     │
│  - Async loading from network                               │
│  - Raw brick data fetching                                  │
│  - Metadata parsing                                         │
└─────────────────────────────────────────────────────────────┘
```

## Completed

### Core Renderer
- [x] Proxy box geometry raycasting
- [x] 512³ volume atlas texture (8x8x8 = 512 brick slots)
- [x] Multi-LOD indirection table support
- [x] Atlas slot allocator with free list
- [x] High-level API: `loadBrick()`, `unloadBrick()`, `clearAllBricks()`
- [x] Partial GPU updates for indirection table
- [x] Compute shader path for raycasting

### Out-of-Core Streaming (NEW)
- [x] **StreamingManager** - CPU-driven brick streaming
  - Screen-Space Error (SSE) based LOD selection
  - Priority queue (inverse distance) for load ordering
  - Budget-aware eviction (atlas capacity management)
  - Hysteresis thresholds to prevent LOD flickering (split: 256px, merge: 128px)
  - Parent fallback until all children are resident
- [x] **Octree** - Hierarchical brick organization
  - Supports arbitrary LOD depths
  - Lazy child node creation
  - Coordinate mapping between LOD levels
- [x] **BrickLoader** - Network brick fetching
  - Metadata-driven dataset loading
  - Progressive loading from coarse to fine

### Debug Visualization (NEW)
- [x] **DebugWireframe** - LOD cell visualization
  - Wireframe boxes around active LOD cells
  - Color-coded by LOD level (Red=LOD0 finest, Blue=LOD5 coarsest)
  - Toggle via `wireframe.enabled = false`
  - Only shows actively rendered cells (not cached bricks)

### Rendering Features
- [x] Ray-box intersection
- [x] Front-to-back compositing
- [x] Transfer function (1D texture)
- [x] Depth buffer integration
- [x] Wireframe box visualization
- [x] Axis helper (RGB = XYZ)

### Camera
- [x] Arcball camera with mouse orbit/zoom
- [x] **Right-click panning** (NEW)
- [x] Configurable up axis (x, y, z, -x, -y, -z)
- [x] Centered on normalized volume

### Testing
- [x] Unit tests for AtlasAllocator
- [x] Unit tests for Indirection data logic
- [x] Snapshot testing utility (browser-based)

## Files

```
kiln/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── progress.md
├── PROJECT_GOALS.md
└── src/
    ├── main.ts                # Entry point, integration
    ├── renderer.ts            # Core renderer class
    ├── camera.ts              # Arcball camera with pan
    ├── streaming-manager.ts   # SSE-based LOD streaming (NEW)
    ├── octree.ts              # Hierarchical brick structure (NEW)
    ├── brick-loader.ts        # Network brick loading (NEW)
    ├── debug-wireframe.ts     # LOD visualization (NEW)
    ├── volume.ts              # Volume canvas, test generators
    ├── geometry.ts            # Box and axis geometry
    ├── shaders.ts             # WGSL shaders
    ├── transfer-function.ts   # TF texture generation
    ├── indirection.ts         # Indirection table
    ├── atlas-allocator.ts     # Slot allocator
    ├── config.ts              # Dataset configuration
    └── console-tools.ts       # Debug console API
```

## Console API

```javascript
// Streaming control
streamingManager.debugPrint()       // Print streaming stats
streamingManager.update(cameraPos)  // Manual update

// Debug wireframe
wireframe.enabled = false           // Toggle LOD visualization

// Camera
camera.resetPan()                   // Reset pan to origin
camera.setUpAxis('-y')              // Set up axis

// Renderer
renderer.useIndirection = false     // See raw atlas
renderer.allocator.usedCount        // Atlas usage
```

## TODO

### Critical - Visual Quality
- [ ] **Brick seams** - Adjacent bricks show visible seams due to texture filtering at boundaries. Need brick padding (1-2 voxel overlap) or border clamping.
- [ ] **Frustum culling** - Currently all visible bricks are processed regardless of camera view. Need to cull bricks outside view frustum for performance.
- [ ] **Wireframe scaling** - Debug wireframes don't scale correctly for datasets with non-power-of-2 root grids (e.g., stag beetle 13x14x8).

### Bugs
- [ ] **"StreamingManager: allocation failed after check"** - Race condition or logic error in atlas allocation. Needs investigation.

### Performance
- [ ] View-dependent priority boost (bricks in center of view)
- [ ] Hybrid GPU/CPU visibility (GPU depth feedback)
- [ ] Compressed brick formats (BC6H for HDR data)

### Renderer Enhancements
- [ ] Quality settings (step count uniform)
- [ ] Transfer function runtime updates
- [ ] Maximum Intensity Projection (MIP) mode
- [ ] Isosurface rendering mode
- [ ] Empty space skipping

### Fine-tuning
- [ ] SSE threshold auto-calibration based on viewport
- [ ] Adaptive loading rate based on camera movement
- [ ] Memory budget configuration

## Design Decisions

1. **SSE-based LOD selection** - Screen-Space Error determines when to split/merge. A brick splits when it would be larger than 256 pixels on screen (~4 pixels per voxel).

2. **Priority = inverse distance** - Closer bricks load first. Simple and effective.

3. **Hysteresis for stability** - Split threshold (256px) > merge threshold (128px) prevents rapid LOD switching at boundaries.

4. **Parent fallback** - Keep parent brick visible until ALL children are resident. Prevents holes during loading.

5. **Eviction strategy** - First evict non-desired bricks, then lowest-priority desired bricks if needed.

6. **Fixed brick size in atlas** - All bricks stored as 64³, simplifies atlas management.

## References

- Virtual Texturing / Megatextures (id Tech 5)
- Sparse Voxel Octrees
- Out-of-core volume rendering (VTK, ParaView)
- NVIDIA IndeX brick-based streaming
- Screen-Space Error metrics (terrain LOD literature)
