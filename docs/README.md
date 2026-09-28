# Kiln Documentation

New to Kiln? Start with the **[Introduction](guide/introduction.md)** — what it is, then the quick start, loading data, and FAQ.

### Guide
- **[Introduction](guide/introduction.md)** — what Kiln is and where to go next
- **[Quick start](guide/quick-start.md)** — a viewer in a few lines
- **[Loading data](guide/loading-data.md)** — remote, local, and multichannel datasets
- **[URL parameters](guide/url-parameters.md)** — share and bookmark views
- **[FAQ](guide/faq.md)**
- **[Gallery](gallery.md)** — live demos and dataset gallery

### Data
- [OME-Zarr](data/ome-zarr.md) — supported formats and requirements
- [Local files](data/local-files.md) — File System Access API
- [Sharded binary](data/sharded-binary.md) — conversion CLI and format
- [Hosting](data/hosting.md) — S3, local dev, CDN
- [Troubleshooting](data/troubleshooting.md)

### Rendering
- [Raymarching](rendering/raymarching.md) — the compute-shader raymarcher
- [Compositing modes](rendering/compositing.md) — DVR/MIP/ISO/slice
- [Multichannel](rendering/multichannel.md) — per-channel controls and limits
- [Resolution & TAA](rendering/resolution-taa.md)

### Architecture
- [System overview](architecture/overview.md) — the layer stack
- [Virtual texturing](architecture/virtual-texturing.md) — bricks, indirection, atlas
- [Streaming manager](architecture/streaming.md) — desired set, priority queue, LRU
- [Network & formats](architecture/network-formats.md) — Range streaming, supported data types
- [Memory budget](architecture/memory-budget.md)
- [Design decisions](architecture/design-decisions.md)

### Reference
- [WebGPU notes](reference/webgpu.md) — texture formats, compute shaders
- [References](reference/references.md) — academic & technical background
- [Known issues](reference/issues.md) — current limitations and planned fixes
