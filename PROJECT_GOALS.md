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
│  - Atlas texture                            │
│  - Indirection table                        │
│  - loadBrick() / unloadBrick() API          │
└─────────────────────────────────────────────┘
                    ▲
                    │ simple data-in API
                    │
┌─────────────────────────────────────────────┐
│  External Systems (user responsibility)     │
│  - BrickManager (LRU, eviction)             │
│  - TileFetcher (network/disk loading)       │
│  - ViewManager (LOD, priority)              │
│  - Dataset abstraction                      │
└─────────────────────────────────────────────┘
```

## Milestones

### Phase 1: Core Renderer ✓
- [x] Proxy box geometry raycasting
- [x] Volume atlas (512³)
- [x] Indirection table (8x8x8)
- [x] Atlas allocator
- [x] Basic transfer function
- [x] Unit tests

### Phase 2: Rendering Quality
- [ ] Configurable step count
- [ ] Runtime transfer function updates
- [ ] Maximum Intensity Projection (MIP)
- [ ] Isosurface rendering
- [ ] Early ray termination tuning

### Phase 3: Streaming Infrastructure
- [ ] BrickManager with LRU eviction
- [ ] Async TileFetcher
- [ ] ViewManager (frustum culling, LOD selection)
- [ ] Priority queue for loading

### Phase 4: LOD Support
- [ ] Multi-resolution bricks (64³, 32³, 16³)
- [ ] LOD selection based on screen coverage
- [ ] Fallback rendering while loading

### Phase 5: Production Features
- [ ] Brick padding for seamless filtering
- [ ] Multiple datasets
- [ ] Segmentation/labeling support
- [ ] Performance profiling tools

## Non-Goals (for now)

- Legacy WebGL fallback
- Mobile-specific optimizations
- Built-in dataset loading (users bring their own fetcher)
- GUI/UI components (users build their own)

## References

- Virtual Texturing (id Tech 5 Megatextures)
- Sparse Voxel Octrees
- NVIDIA IndeX
- OpenVDS (OSDU)
- VTK/ParaView out-of-core rendering
