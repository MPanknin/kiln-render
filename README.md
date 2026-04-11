# Kiln

A WebGPU-native out-of-core volume rendering system for large virtualized volumetric datasets.

Kiln streams multi-gigabyte volumes over HTTP, rendering them at interactive framerates using a fixed-size VRAM page cache and virtual texture indirection.

**Documentation:** [Usage Guide](docs/usage-guide.md) · [Architecture](docs/architecture.md) · [Rendering Pipeline](docs/rendering.md) · [Data Guide](docs/data-guide.md) · [WebGPU Notes](docs/webgpu.md) · [References](docs/references.md)

---

## Chameleon CT Scan
#### 2160.0 MB - 1024 × 1024 × 1080 @ 16-bit
<a href="https://mpanknin.github.io/kiln-render/?mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C3.930%2C0.108%2C0.001%2C-0.066" target="_blank">Live Demo</a>

<img width="1725" height="907" alt="553008107-25ae5fa5-7fe6-49d1-b3b1-51784c6220a2" src="https://github.com/user-attachments/assets/f5da8ea1-a924-4ba6-9f29-6f6c18369405" />

## Beechnut micro CT Scan (experimental OME-Zarr)
#### 3092.0 MB - 1024 × 1024 × 1546 @ 16-bit
<a href="https://mpanknin.github.io/kiln-render/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fbeechnut.ome.zarr&mode=dvr&wc=0.22&ww=0.14&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=-0.090%2C2.130%2C3.171%2C-0.072%2C-0.025%2C-0.013" target="_blank">Live Demo</a>

<img width="1722" height="905" alt="553008573-17268259-5977-4a9b-b4c0-a1756a024857" src="https://github.com/user-attachments/assets/02cffc17-bf44-422b-8752-9bf4edc96d89" />

## Features

- **Out-of-core streaming** - Fixed VRAM footprint, SSE-based LOD selection, LRU brick cache
- **OME-Zarr & Kiln binary** - Stream from S3, CDN, or load local files (OME-Zarr v0.5, single-channel, uint8/uint16)
- **16-bit support** - Native r16unorm textures with window/level controls
- **Compute shader raymarching** - Brick-aware DVR, MIP, and isosurface rendering
- **Transfer functions** - Interactive curve editor with color/opacity presets
- **Worker-based pipeline** - Parallel decompression and brick assembly off the main thread

## Quick Start

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Build for production
bun run build
```

The demo loads a sample dataset from S3. To load custom datasets, see the [Usage Guide](docs/usage-guide.md).

## Browser Requirements

Kiln requires **WebGPU** support:
- Chrome/Edge 113+
- Safari 26+
- Firefox 141+

Make sure hardware acceleration is enabled in your browser settings.

## Sample Datasets

From the [Open SciVis Datasets](https://github.com/sci-visus/open-scivis-datasets) collection:
- **Chameleon** - CT scan of *Chamaeleo calyptratus*. Digital Morphology, 2003.
- **Beechnut** - MicroCT scan of a dried beechnut. Computer-Assisted Paleoanthropology, University of Zurich.
- **Stag Beetle** - Industrial CT scan. Meister Eduard Gröller, Georg Glaeser, Johannes Kastner, 2005.

## License

Apache 2.0

---

## Note

>
> [Read the full write-up on dev.to](https://dev.to/mpanknin/kiln-webgpu-native-out-of-core-volume-rendering-for-multi-gb-datasets-2alb)
>
> [Partly Kiln builds upon my earlier work on volume rendering](https://github.com/MPanknin/volume-occlusion-editor)
