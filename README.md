# Kiln

A WebGPU-native out-of-core volume renderer for large virtualized volumetric datasets. 

Kiln streams multi-gigabyte volumes over HTTP, rendering them at interactive framerates using a fixed-size VRAM page cache and virtual texture indirection.

## Chameleon CT Scan
#### 2160.0 MB - 1024 × 1024 × 1080 @ 16-bit
<img width="1723" height="901" alt="image" src="https://github.com/user-attachments/assets/5f3a8e98-707d-4da4-b7ee-65f8ad5f4a99" />

## Bechnut CT Scan
#### 3092.0 MB - 1024 × 1024 × 1546 @ 16-bit
<img width="1722" height="904" alt="image" src="https://github.com/user-attachments/assets/16828573-1f15-45f6-be3d-a46708293bc2" />

## What Problem Does Kiln Solve?

Web-based volume renderers typically require loading entire datasets into GPU memory upfront, making multi-gigabyte medical and scientific volumes impractical to visualize in a browser. While out-of-core rendering exists in desktop applications, bringing this capability to the web has been challenging.

Kiln brings **virtual texturing for volumetric data** to the browser:

- **Fixed memory footprint** - Uses only ~150 MB of VRAM for a working set of bricks
- **Stream on demand** - Fetches only the bricks visible in the current view
- **Multi-resolution** - Automatically shows coarse data far away, fine data up close
- **Network-native** - Streams directly from S3, CDN, or any HTTP server supporting Range requests

## Features

- **Out-of-core streaming** - Screen-space error (SSE) based LOD selection with LRU eviction
- **Multi-LOD support** - Coarse-to-fine octree traversal with automatic refinement
- **Bounded VRAM usage** - 512 brick slots (~150 MB atlas) for a working set cache
- **8-bit and 16-bit volumes** - Native r16unorm support with windowing/leveling controls
- **Virtual texturing** - Indirection table maps logical volume to physical cache
- **Compute shader raycasting** - Brick-aware raymarching with early ray termination
- **Brick compression** - Gzip compression with parallel Web Worker decompression
- **Empty brick skipping** - Pre-indexed statistics enable zero-cost culling
- **Multiple render modes** - DVR, MIP, Isosurface, LOD visualization
- **HTTP Range requests** - Granular byte-range fetches for efficient streaming

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

The demo loads a sample dataset from S3. To use your own data, see the [Data Preparation Guide](DATA_PREPARATION.md).

## Documentation

- **[Architecture](ARCHITECTURE.md)** - Technical deep-dive into the virtual texturing system, streaming manager, raymarching pipeline, and design decisions
- **[Data Preparation](DATA_PREPARATION.md)** - How to convert raw volumes into Kiln's brick format using the provided scripts

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

Kiln uses WebGPU rather than WebGL. This provides several technical advantages for volume rendering:

| Feature | WebGL | WebGPU (Kiln) |
|---------|-------|---------------|
| **16-bit textures** | Emulated (two 8-bit channels + shader reconstruction) | Native `r16unorm` format |
| **3D texture size** | Often limited to 2048³ | Up to 16384³ (device-dependent) |
| **Compute shaders** | Not available | Full support for raymarching |
| **Texture updates** | Synchronous, blocks rendering | `writeTexture` is asynchronous |
| **Integer textures** | Limited support | Native `rgba8uint` for indirection |

**Native 16-bit textures** are particularly significant for medical imaging. WebGL requires packing 16-bit values into two 8-bit channels and reconstructing them in the shader, adding overhead and complexity. WebGPU's `r16unorm` format stores and samples 16-bit data directly with hardware filtering.

**Compute shaders** enable efficient full-screen raymarching. Each pixel generates and traces its own ray independently, mapping naturally to GPU parallelism. WebGL requires rendering a full-screen quad and performing raymarching in a fragment shader, which works but is less flexible.

**Asynchronous texture updates** allow brick data to be uploaded to the atlas without stalling the render loop. This is important for streaming, where new bricks arrive continuously while rendering proceeds.

## Target Use Cases

- Medical imaging (CT, MRI) visualization in the browser
- Scientific visualization (simulation data, microscopy)
- Geospatial and seismic volume rendering
- Datasets that would be impractical to load entirely in a web-based viewer

## Credits

Sample datasets from the [Open SciVis Datasets](https://klacansky.com/open-scivis-datasets/) collection:

- **Chameleon** - CT scan of *Chamaeleo calyptratus*. Digital Morphology, 2003.
- **Stag Beetle** - Industrial CT scan. Meister Eduard Gröller, Georg Glaeser, Johannes Kastner, 2005.

## License

MIT
