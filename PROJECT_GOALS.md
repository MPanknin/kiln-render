# Kiln - Project Goals

## Vision
A production-quality, brick-based WebGPU volume renderer for out-of-core rendering of arbitrarily large volumetric datasets.

## Core Principles

1. **Simplicity** - KISS approach, minimal abstractions
2. **Decoupled architecture** - Renderer is dataset-agnostic
3. **Streaming-first** - Designed for out-of-core data from the start
4. **WebGPU native** - Modern API, no legacy fallbacks

## Target Use Cases

- Medical imaging (CT, MRI) visualization
- Scientific visualization (simulation data, microscopy)
- Geospatial/seismic volume rendering
- Any large volumetric dataset that doesn't fit in GPU memory

## Architecture

```
┌─────────────────────────────────────────────┐
│  Renderer (core)                            │
│  - Atlas texture (512³)                     │
│  - Indirection table with multi-LOD         │
│  - LRU eviction                             │
│  - Multiple render modes                    │
└─────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────┐
│  BrickLoader                                │
│  - Binary sharded format + Range requests   │
│  - Brick stats for empty detection          │
│  - In-memory cache                          │
└─────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────┐
│  LOD Selection                              │
│  - Distance-based coarse-to-fine traversal  │
│  - Frustum culling                          │
│  - Differential updates                     │
└─────────────────────────────────────────────┘
```

## Milestones

### Phase 1: Core Renderer ✓
- [x] Proxy box geometry raycasting
- [x] Volume atlas (512³)
- [x] Indirection table (multi-LOD)
- [x] Atlas allocator with LRU eviction
- [x] Basic transfer function
- [x] Unit tests

### Phase 2: Rendering Quality ✓
- [x] Transfer function presets and runtime editing
- [x] Maximum Intensity Projection (MIP)
- [x] Isosurface rendering with Phong shading
- [x] LOD visualization mode
- [x] Early ray termination

### Phase 3: Streaming Infrastructure ✓
- [x] BrickLoader with HTTP Range requests
- [x] Binary sharded data format
- [x] LRU eviction when atlas is full
- [x] Frustum culling
- [x] Empty brick skipping

### Phase 4: LOD Support ✓
- [x] Multi-resolution bricks (LOD 0-4)
- [x] Distance-based LOD selection
- [x] Coarse-to-fine octree traversal
- [x] Differential updates (load only what's needed)
- [x] Multi-slot indirection for coarse LODs

### Phase 5: Production Features (IN PROGRESS)
- [x] 66³ physical bricks (1-voxel overlap for seamless filtering)
- [x] UI controls (Tweakpane)
- [ ] Automatic continuous streaming during navigation
- [ ] Dynamic empty brick threshold
- [ ] Multiple datasets
- [ ] Segmentation/labeling support

## Non-Goals (for now)

- Legacy WebGL fallback
- Mobile-specific optimizations
- Built-in dataset conversion tools

## References

- Virtual Texturing (id Tech 5 Megatextures)
- Sparse Voxel Octrees
- NVIDIA IndeX
- OpenVDS (OSDU)
- VTK/ParaView out-of-core rendering
