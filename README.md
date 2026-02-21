> [!NOTE]
> Kiln is a research-grade prototype. Some rendering artifacts and incomplete features are expected.

# Kiln

A WebGPU-native out-of-core volume renderer for large virtualized volumetric datasets. 

Kiln streams multi-gigabyte volumes over HTTP, rendering them at interactive framerates using a fixed-size VRAM page cache and virtual texture indirection.

## Chameleon CT Scan
#### 2160.0 MB - 1024 × 1024 × 1080 @ 16-bit
<img width="1723" height="901" alt="image" src="https://github.com/user-attachments/assets/5f3a8e98-707d-4da4-b7ee-65f8ad5f4a99" />

## Beechnut micro CT Scan
#### 3092.0 MB - 1024 × 1024 × 1546 @ 16-bit
<img width="1722" height="904" alt="image" src="https://github.com/user-attachments/assets/16828573-1f15-45f6-be3d-a46708293bc2" />

## Overview

Kiln implements **virtual texturing for volumetric data** in the browser using WebGPU:

- **Fixed memory footprint** - Uses constant and minimal VRAM regardless of dataset size
- **Stream on demand** - Fetches only the bricks visible in the current view
- **Multi-resolution** - Coarse LODs far away, fine LODs up close via screen-space error
- **Network-native** - Streams from S3, CDN, or any HTTP server with Range request support

## Features

- **Out-of-core streaming** - SSE-based LOD selection, LRU eviction, 512-slot brick cache
- **Input formats** - Kiln sharded binary (with preprocessing script) and OME-Zarr (direct HTTP streaming)
- **8-bit and 16-bit volumes** - Native `r16unorm` with windowing/leveling controls
- **Compute shader raycasting** - Brick-aware raymarching with early ray termination
- **Gzip compression** - Parallel Web Worker decompression pipeline
- **Empty brick skipping** - Pre-indexed per-brick statistics for culling
- **Render modes** - DVR, MIP, Isosurface, LOD debug visualization
- **HTTP Range requests** - Byte-range fetches from S3, CDN, or any static file server

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Run tests
npm run test
```

The demo loads a sample dataset from S3. To use your own data, see the [Data Guide](docs/data-guide.md).

## Documentation

- **[Architecture](docs/architecture.md)** - Virtual texturing, streaming manager, and design decisions
- **[Rendering Pipeline](docs/rendering.md)** - Raymarching, compositing modes, resolution scaling, and temporal accumulation
- **[Data Guide](docs/data-guide.md)** - Supported formats (OME-Zarr, Kiln sharded binary) and data preparation
- **[WebGPU Notes](docs/webgpu.md)** - WebGPU vs WebGL comparison and future GPU optimizations

## UI Controls

| Control | Description |
|---------|-------------|
| **Mode** | DVR, MIP, ISO, or LOD visualization |
| **Up Axis** | Camera orientation (X, Y, Z, -X, -Y, -Z) |
| **Indirection** | Toggle virtual texturing on/off |
| **Wireframe** | Show volume bounding box |
| **Transfer Function** | Color/opacity presets and interactive curve editing |
| **Window/Level** | Contrast adjustment for 16-bit data (center and width) |

## Why WebGPU?

Kiln requires WebGPU (not WebGL) for native `r16unorm` textures, compute shader raymarching, and asynchronous texture uploads during streaming. See the [WebGPU Notes](docs/webgpu.md) for a detailed comparison.

## Credits

Sample datasets from the [Open SciVis Datasets](https://klacansky.com/open-scivis-datasets/) collection:

- **Chameleon** - CT scan of *Chamaeleo calyptratus*. Digital Morphology, 2003.
- **Beechnut** - MicroCT scan of a dried beechnut. Computer-Assisted Paleoanthropology group and Visualization and MultiMedia Lab, University of Zurich.
- **Stag Beetle** - Industrial CT scan. Meister Eduard Gröller, Georg Glaeser, Johannes Kastner, 2005.

## License

MIT
