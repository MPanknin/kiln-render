> [!NOTE]
> Kiln is a research-grade prototype. Some rendering artifacts and incomplete features are expected.
> 
> [Read the full write-up on dev.to](https://dev.to/mpanknin/building-kiln-streaming-multi-gb-volumes-in-the-browser-48hl-temp-slug-9894239?preview=3c3a3ca6a809141c4972dd2ea8f9190e6ddc292079a4920991ecdf65c5071ed0db1c31219330eb9e4b9ec30a8a7cd920c90977395c57b6c01c660bb4)

# Kiln

A WebGPU-native out-of-core volume rendering system for large virtualized volumetric datasets. 

Kiln streams multi-gigabyte volumes over HTTP, rendering them at interactive framerates using a fixed-size VRAM page cache and virtual texture indirection.

## Chameleon CT Scan
#### 2160.0 MB - 1024 × 1024 × 1080 @ 16-bit
<a href="https://mpanknin.github.io/kiln-render/?mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C3.930%2C0.108%2C0.001%2C-0.066" target="_blank">Live Demo</a>

<img width="1725" height="907" alt="image" src="https://github.com/user-attachments/assets/25ae5fa5-7fe6-49d1-b3b1-51784c6220a2" />

## Beechnut micro CT Scan (experimental OME-Zarr)
#### 3092.0 MB - 1024 × 1024 × 1546 @ 16-bit
<a href="https://mpanknin.github.io/kiln-render/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fbeechnut.ome.zarr&mode=dvr&wc=0.22&ww=0.14&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=-0.090%2C2.130%2C3.171%2C-0.072%2C-0.025%2C-0.013" target="_blank">Live Demo</a>

<img width="1722" height="905" alt="image" src="https://github.com/user-attachments/assets/17268259-5977-4a9b-b4c0-a1756a024857" />

## Overview

Kiln implements **virtual texturing for volumetric data** in the browser using WebGPU:

- **Fixed memory footprint** - Uses constant and minimal VRAM regardless of dataset size
- **Stream on demand** - Fetches only the bricks visible in the current view
- **Multi-resolution** - Coarse LODs far away, fine LODs up close via screen-space error
- **Network-native** - Streams from S3, CDN, or any HTTP server with Range request support

## Features

- **Out-of-core streaming** - SSE-based LOD selection, LRU eviction, 512-slot brick cache
- **Input formats** - Kiln sharded binary (with preprocessing script) and OME-Zarr (experimental)
- **8-bit and 16-bit volumes** - Native `r16unorm` with windowing/leveling controls
- **Compute shader raycasting** - Brick-aware raymarching with early ray termination
- **Gzip compression** - Parallel Web Worker decompression pipeline
- **Empty brick skipping** - Pre-indexed per-brick statistics for culling
- **Render modes** - DVR, MIP, Isosurface, LOD debug visualization
- **HTTP Range requests** - Byte-range fetches from S3, CDN, or any static file server

## Quick Start

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Build for production
bun run build

# Run tests
bun run test
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

## FAQ

**Which browsers are supported?**
Kiln requires WebGPU. Chrome/Edge 113+ and Safari 26+ support it out of the box. Firefox ships WebGPU by default in recent versions (141+), though support may be partial on some platforms — check `dom.webgpu.enabled` if needed. Make sure hardware acceleration is enabled in your browser settings.

**How much VRAM does Kiln use?**
The atlas is a fixed-size 3D texture. With the default 1,000 brick slots it uses ~274 MiB for 8-bit data and ~548 MiB for 16-bit data. You can adjust the atlas size in `config.ts` for different quality/memory tradeoffs, but usage always stays constant regardless of dataset size.

**Can I load my own data?**
Yes. Kiln supports its own sharded binary format as well as an experimantal integration for OME-Zarr datasets. See the [Data Guide](docs/data-guide.md) for details on how to prepare and serve your data.

**What are the known rendering issues?**
Brick boundary seams are still visible in some cases, especially in isosurface (ISO) mode where normal estimation samples across brick edges. LOD transitions can also produce brief visual discontinuities while bricks stream in. These are known issues and will be addressed in the future.

**Can I use Kiln in my own application?**
Kiln is MIT licensed, so you are free to use, modify, and integrate it. We plan to provide an installable npm package in the future, but for now Kiln is a standalone viewer. There is no stable public API yet and the internals may change, so if you build on top of it, pinning to a specific commit is recommended.

## Credits

Sample datasets from the [Open SciVis Datasets](https://klacansky.com/open-scivis-datasets/) collection:

- **Chameleon** - CT scan of *Chamaeleo calyptratus*. Digital Morphology, 2003.
- **Beechnut** - MicroCT scan of a dried beechnut. Computer-Assisted Paleoanthropology group and Visualization and MultiMedia Lab, University of Zurich.
- **Stag Beetle** - Industrial CT scan. Meister Eduard Gröller, Georg Glaeser, Johannes Kastner, 2005.

Some of the concepts in Kiln build upon my earlier work on volume rendering: [volume-occlusion-editor](https://github.com/MPanknin/volume-occlusion-editor).

## License

MIT
