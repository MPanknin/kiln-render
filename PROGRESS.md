# Kiln - Progress

## Overview
A minimal, clean WebGPU volume renderer using proxy box geometry and brick-based virtual texturing. Designed for out-of-core rendering of arbitrarily large volumes.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (core module - COMPLETE)                          │
│  - Atlas texture (512³, 8x8x8 brick slots)                  │
│  - Multi-LOD indirection table                              │
│  - Atlas allocator with LRU eviction                        │
│  - Compute shader raycasting                                │
│  - Multiple render modes (DVR, MIP, ISO, LOD)               │
└─────────────────────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────────────────────┐
│  LOD Selection (COMPLETE)                                   │
│  - Distance-based coarse-to-fine octree traversal           │
│  - Frustum culling                                          │
│  - Differential updates (only load what's needed)           │
│  - Empty brick skipping based on index stats                │
└─────────────────────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────────────────────┐
│  Atlas Allocator (COMPLETE)                                 │
│  - LRU eviction when atlas is full                          │
│  - Frame-based touch tracking                               │
│  - Slot metadata for reverse lookup                         │
└─────────────────────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────────────────────┐
│  BrickLoader (COMPLETE)                                     │
│  - Binary sharded format with HTTP Range requests           │
│  - Legacy individual file format support                    │
│  - In-memory brick cache                                    │
│  - Brick stats (min/max/avg) for empty detection            │
└─────────────────────────────────────────────────────────────┘
```

## Completed

### Core Renderer
- [x] Proxy box geometry raycasting
- [x] 512³ volume atlas texture (8x8x8 = 512 brick slots)
- [x] 64³ logical / 66³ physical bricks (1-voxel overlap for seamless filtering)
- [x] Multi-LOD indirection table with LOD priority
- [x] Atlas slot allocator with LRU eviction
- [x] Partial GPU updates for indirection table
- [x] Compute shader path for raycasting

### Render Modes
- [x] DVR (Direct Volume Rendering) with transfer function
- [x] MIP (Maximum Intensity Projection)
- [x] Isosurface rendering with Phong shading
- [x] LOD visualization (color-coded by resolution level)

### Multi-LOD Support
- [x] Coarse-to-fine octree traversal
- [x] Distance-based LOD selection with configurable thresholds
- [x] Multi-slot indirection updates (coarse LODs fill 2^lod × 2^lod × 2^lod cells)
- [x] LOD priority (finer LODs won't be overwritten by coarser)
- [x] Empty brick marking (LOD 255 = known empty)

### Streaming & Eviction
- [x] LRU eviction when atlas is full
- [x] Frame-based touch tracking for recently used bricks
- [x] Differential updates (only load missing bricks)
- [x] Empty brick skipping based on index stats (min/max/avg)
- [x] Frustum culling

### Data Formats
- [x] Binary sharded format (volume.json + lodN.bin + lodN_index.json)
- [x] HTTP Range requests for efficient brick streaming
- [x] Legacy format support (brick.json + individual .raw files)
- [x] Brick statistics in index (min/max/avg intensity)

### UI Controls (Tweakpane)
- [x] Render mode selection (DVR, MIP, ISO, LOD)
- [x] Camera up axis dropdown
- [x] Indirection toggle
- [x] Wireframe box toggle
- [x] Axis helper toggle
- [x] Transfer function preset selection
- [x] Interactive opacity curve editing
- [x] ISO value slider
- [x] LOD level buttons

### Rendering Features
- [x] Ray-box intersection
- [x] Front-to-back compositing with early exit
- [x] Transfer function (1D texture) with presets
- [x] Depth buffer integration
- [x] Wireframe box visualization (toggleable)
- [x] Axis helper RGB = XYZ (toggleable)

### Camera
- [x] Arcball camera with mouse orbit/zoom
- [x] Right-click panning
- [x] Configurable up axis (x, y, z, -x, -y, -z)
- [x] Centered on normalized volume

### Testing
- [x] Unit tests for AtlasAllocator
- [x] Unit tests for Indirection data logic

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
    ├── main.ts                # Entry point, LOD selection, loading
    ├── renderer.ts            # Core renderer class
    ├── camera.ts              # Arcball camera with pan
    ├── brick-loader.ts        # Network brick loading, Range requests
    ├── volume.ts              # Volume canvas, atlas uploads
    ├── geometry.ts            # Box and axis geometry
    ├── shaders.ts             # WGSL shaders (DVR, MIP, ISO, LOD)
    ├── transfer-function.ts   # TF texture generation, presets
    ├── indirection.ts         # Indirection table with multi-LOD
    ├── atlas-allocator.ts     # Slot allocator with LRU eviction
    ├── config.ts              # Dataset configuration
    └── ui.ts                  # Tweakpane UI controls
```

## Console API

```javascript
// LOD selection with coarse-to-fine traversal
testLodSelection()           // Differential update (keeps existing bricks)
testLodSelection(true)       // Clear and reload

// Manual LOD loading
loadLod(0)                   // Load LOD 0 (finest)
clearLod()                   // Clear all loaded bricks

// Single brick loading
loadSingleBrick(0, 5, 5, 5)  // Load specific brick

// Debug
dumpIndirection(0)           // Print indirection table slice

// Render settings
setRenderMode('dvr')         // 'dvr', 'mip', 'iso', 'lod'
setIsoValue(0.5)             // ISO surface threshold
setCameraUp('y')             // Camera up axis

// Renderer properties
renderer.useIndirection      // Toggle indirection
renderer.showWireframe       // Toggle wireframe box
renderer.showAxis            // Toggle axis helper
```

## TODO

### Features
- [ ] Dynamic empty brick threshold based on dataset intensity distribution
- [ ] Automatic LOD selection during camera movement (continuous streaming)
- [ ] View-dependent priority boost (bricks in center of view)
- [ ] Compressed brick formats (BC6H for HDR data)

### Performance
- [ ] GPU-based visibility feedback
- [ ] Adaptive loading rate based on camera movement
- [ ] Background async brick loading with progress indication

### Quality
- [ ] Gradient-based shading for DVR mode
- [ ] Ambient occlusion

## Design Decisions

1. **Distance-based LOD selection** - Simple distance thresholds determine when to use finer/coarser LODs. Hand-tuned for visible LOD bands.

2. **LRU eviction** - Frame-based touch tracking. Bricks not used recently are evicted first when atlas is full.

3. **Differential updates** - Only load bricks that are missing, touch existing ones to keep them fresh.

4. **Empty brick skipping** - Use index stats (min/max/avg) to skip loading bricks with no useful data. Saves network requests and atlas slots.

5. **Multi-slot indirection** - Coarse LOD bricks fill multiple cells in the indirection table (2^lod per dimension), with LOD priority to prevent coarse from overwriting fine.

6. **LOD 255 = empty marker** - Special indirection value to indicate "known empty, don't render" so coarse data doesn't bleed through.

7. **66³ physical bricks** - 1-voxel overlap on all sides for seamless trilinear filtering at brick boundaries.

## References

- Virtual Texturing / Megatextures (id Tech 5)
- Sparse Voxel Octrees
- Out-of-core volume rendering (VTK, ParaView)
- NVIDIA IndeX brick-based streaming
