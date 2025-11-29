# Kiln - Progress

## Overview
A minimal, clean WebGPU volume renderer using proxy box geometry and brick-based virtual texturing. Designed for out-of-core rendering of arbitrarily large volumes.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Renderer (core module - COMPLETE)          │
│  - Atlas texture (512³)                     │
│  - Indirection table (8x8x8)                │
│  - Atlas allocator                          │
│  - loadBrick() / unloadBrick() API          │
└─────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────┐
│  Future: BrickManager                       │
│  - LRU tracking for eviction                │
│  - Brick state machine                      │
└─────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────┐
│  Future: TileFetcher                        │
│  - Async loading from network/disk          │
│  - Decode/decompress                        │
└─────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────┐
│  Future: ViewManager                        │
│  - Camera frustum culling                   │
│  - LOD selection based on distance          │
│  - Priority computation                     │
└─────────────────────────────────────────────┘
```

## Completed

### Core Renderer
- [x] Proxy box geometry raycasting (vs fullscreen quad)
- [x] 512³ volume atlas texture
- [x] Indirection table (8x8x8 grid, 64³ bricks)
- [x] Atlas slot allocator with free list
- [x] High-level API: `loadBrick()`, `unloadBrick()`, `clearAllBricks()`
- [x] Partial GPU updates for indirection table
- [x] Debug toggle: `renderer.useIndirection` (true/false)

### Rendering Features
- [x] Ray-box intersection
- [x] Front-to-back compositing
- [x] Transfer function (1D texture)
- [x] Depth buffer integration
- [x] Wireframe box visualization
- [x] Axis helper (RGB = XYZ)

### Camera
- [x] Arcball camera with mouse orbit/zoom
- [x] Inverted horizontal rotation
- [x] Centered on volume [256, 256, 256]

### Testing
- [x] Unit tests for AtlasAllocator (10 tests)
- [x] Unit tests for Indirection data logic (11 tests)
- [x] Snapshot testing utility (browser-based)

## Files

```
kiln/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── PROGRESS.md
├── PROJECT_GOALS.md
└── src/
    ├── main.ts              # Entry point, debug console API
    ├── renderer.ts          # Core renderer class
    ├── camera.ts            # Arcball camera
    ├── volume.ts            # Volume canvas, test generators
    ├── geometry.ts          # Box and axis geometry
    ├── shaders.ts           # WGSL shaders
    ├── transfer-function.ts # TF texture generation
    ├── indirection.ts       # Indirection table
    ├── atlas-allocator.ts   # Slot allocator
    ├── snapshot-test.ts     # Browser snapshot testing
    ├── atlas-allocator.test.ts
    └── indirection.test.ts
```

## Console API

```javascript
// Load/unload bricks
loadBrick(vx, vy, vz, intensity, 'sphere'|'solid')
unloadBrick(vx, vy, vz)
clearAll()
fillAtlas()

// Debug
renderer.useIndirection = false  // See raw atlas
renderer.useIndirection = true   // See virtual positions
renderer.allocator.usedCount
renderer.allocator.freeCount

// Snapshots
captureSnapshot('name')
compareSnapshot('name')
```

## TODO

### Renderer Enhancements (additive, won't change architecture)
- [ ] Quality settings (step count uniform)
- [ ] Transfer function runtime updates
- [ ] Maximum Intensity Projection (MIP) mode
- [ ] Isosurface rendering mode
- [ ] Brick padding support (data-side, not renderer)

### External Modules (decoupled from renderer)
- [ ] BrickManager - LRU eviction, brick state tracking
- [ ] TileFetcher - async loading, decode/decompress
- [ ] ViewManager - frustum culling, LOD selection, priority
- [ ] Dataset abstraction - metadata, URL patterns

### LOD Support
- [ ] Multiple LOD levels (64³, 32³, 16³ bricks)
- [ ] Approach: upscale lower LODs to 64³ for atlas simplicity
- [ ] LOD selection heuristics based on screen coverage

## Design Decisions

1. **Proxy geometry over fullscreen quad** - Enables proper depth integration with scene objects

2. **Fixed brick size in atlas** - All bricks stored as 64³, lower LODs upscaled. Simplifies atlas management at cost of some memory.

3. **Indirection in data, not renderer** - Brick padding for seamless filtering handled by data preparation, not shader complexity.

4. **Renderer is dataset-agnostic** - Only knows about atlas slots and brick data. Dataset specifics handled by external modules.

## References

- Virtual Texturing / Megatextures (id Tech 5)
- Sparse Voxel Octrees
- Out-of-core volume rendering (VTK, ParaView)
- NVIDIA IndeX brick-based streaming
