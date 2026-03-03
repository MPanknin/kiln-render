# Kiln

A WebGPU-native out-of-core volume rendering system for large virtualized volumetric datasets. 

Kiln streams multi-gigabyte volumes over HTTP, rendering them at interactive framerates using a fixed-size VRAM page cache and virtual texture indirection.

## Chameleon CT Scan
#### 2160.0 MB - 1024 × 1024 × 1080 @ 16-bit
<a href="https://mpanknin.github.io/kiln-render/?mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C3.930%2C0.108%2C0.001%2C-0.066" target="_blank">Live Demo</a>

<img width="1725" height="907" alt="553008107-25ae5fa5-7fe6-49d1-b3b1-51784c6220a2" src="https://github.com/user-attachments/assets/f5da8ea1-a924-4ba6-9f29-6f6c18369405" />

## Beechnut micro CT Scan (experimental OME-Zarr)
#### 3092.0 MB - 1024 × 1024 × 1546 @ 16-bit
<a href="https://mpanknin.github.io/kiln-render/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fbeechnut.ome.zarr&mode=dvr&wc=0.22&ww=0.14&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=-0.090%2C2.130%2C3.171%2C-0.072%2C-0.025%2C-0.013" target="_blank">Live Demo</a>

<img width="1722" height="905" alt="553008573-17268259-5977-4a9b-b4c0-a1756a024857" src="https://github.com/user-attachments/assets/02cffc17-bf44-422b-8752-9bf4edc96d89" />

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

## Datasets

Sample datasets from the [Open SciVis Datasets](https://github.com/sci-visus/open-scivis-datasets) collection:

- **Chameleon** - CT scan of *Chamaeleo calyptratus*. Digital Morphology, 2003.
- **Beechnut** - MicroCT scan of a dried beechnut. Computer-Assisted Paleoanthropology group and Visualization and MultiMedia Lab, University of Zurich.
- **Stag Beetle** - Industrial CT scan. Meister Eduard Gröller, Georg Glaeser, Johannes Kastner, 2005.

## Background & References

Kiln is an implementation-focused project that builds on well-established ideas in volume rendering, sparse streaming, and real-time graphics. It does not introduce new rendering algorithms, but adapts proven techniques to a modern WebGPU context. The following works were particularly influential during development:

- **Barrett, S. (2008).** *Sparse Virtual Textures*. Game Developers Conference (GDC) 2008. [http://silverspaceship.com/src/svt/](http://silverspaceship.com/src/svt/)
- **CesiumGS. (2019).** *3D Tiles: Specification for Streaming Massive Heterogeneous 3D Geospatial Datasets*. Open Geospatial Consortium (OGC) Community Standard. [https://github.com/CesiumGS/3d-tiles](https://github.com/CesiumGS/3d-tiles)
- **Engel, K., Hadwiger, M., Kniss, J., Rezk-Salama, C., & Weiskopf, D. (2006).** *Real-Time Volume Graphics*. A K Peters/CRC Press. [https://doi.org/10.1201/b10629](https://doi.org/10.1201/b10629)
- **Karis, B. (2014).** *High Quality Temporal Supersampling*. ACM SIGGRAPH 2014, Advances in Real-Time Rendering in Games. [https://de45xmedrsdbp.cloudfront.net/Resources/files/TemporalAA_small-59732822.pdf](https://de45xmedrsdbp.cloudfront.net/Resources/files/TemporalAA_small-59732822.pdf)
- **Levoy, M. (1990).** *Efficient ray tracing of volume data*. ACM Transactions on Graphics, 9(3), 245–261. [https://doi.org/10.1145/78964.78965](https://doi.org/10.1145/78964.78965)
- **Lux, C., & Fröhlich, B. (2009).** *GPU-Based Ray Casting of Multiple Multi-resolution Volume Datasets. In: Bebis, G., et al. Advances in Visual Computing. ISVC 2009. [https://link.springer.com/chapter/10.1007/978-3-642-10520-3_10](https://link.springer.com/chapter/10.1007/978-3-642-10520-3_10)
- **Maitin-Shepard, J., et al. (2021).** *Neuroglancer: Web-based volumetric data visualization*. [https://github.com/google/neuroglancer](https://github.com/google/neuroglancer)
- **Moore, J., et al. (2023).** *OME-Zarr: a cloud-optimized bioimaging file format with international community support*. Histochemistry and Cell Biology, 160(3), 223–251. [https://doi.org/10.1007/s00418-023-02209-1](https://doi.org/10.1007/s00418-023-02209-1)
- **Schütz, M. (2016).** *Potree: Rendering Large Point Clouds in Web Browsers* [Master's thesis, Technische Universität Wien]. [https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/](https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/)
- **W3C GPU for the Web Working Group. (2026).** *WebGPU*. W3C Candidate Recommendation Draft. [https://gpuweb.github.io/gpuweb/](https://gpuweb.github.io/gpuweb/)

## License

MIT

## Misc

> [!NOTE]
> Kiln is a research-grade prototype. Some rendering artifacts and incomplete features are expected.
> 
> [Read the full write-up on dev.to](https://dev.to/mpanknin/kiln-webgpu-native-out-of-core-volume-rendering-for-multi-gb-datasets-2alb)
> 
> Some of the concepts in Kiln build upon my earlier work on volume rendering: [volume-occlusion-editor](https://github.com/MPanknin/volume-occlusion-editor).

