# Kiln

A WebGPU-native out-of-core volume renderer for large virtualized volumetric datasets. 

Kiln streams multi-gigabyte volumes over HTTP, rendering them at interactive framerates using a fixed-size VRAM page cache and virtual texture indirection.

<img width="1721" alt="Kiln volume renderer showing a chameleon CT scan" src="https://github.com/user-attachments/assets/07502e5c-c1d7-4ef7-8b78-6b89402216f8" />

## What Problem Does Kiln Solve?

Traditional volume renderers load entire datasets into GPU memory, limiting them to volumes that fit in VRAM (typically 8-24 GB). Medical imaging, scientific simulations, and microscopy routinely produce datasets of 50+ GB that cannot be visualized this way.

Kiln solves this by implementing **virtual texturing for volumetric data**:

- **Fixed memory footprint** - Uses only ~150 MB of VRAM regardless of dataset size
- **Stream on demand** - Fetches only the bricks visible in the current view
- **Multi-resolution** - Automatically shows coarse data far away, fine data up close
- **Network-native** - Streams directly from S3, CDN, or any HTTP server supporting Range requests

## Features

- **Out-of-core streaming** - Distance-based LOD selection with LRU eviction
- **Multi-LOD support** - Coarse-to-fine octree traversal with automatic refinement
- **Constant VRAM usage** - 512 brick slots (147 MB atlas) regardless of source volume size
- **Virtual texturing** - Indirection table maps logical volume to physical cache
- **Compute shader raycasting** - Brick-aware raymarching with early ray termination
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

## Target Use Cases

- Medical imaging (CT, MRI) visualization
- Scientific visualization (simulation data, microscopy)
- Geospatial and seismic volume rendering
- Any volumetric dataset too large for GPU memory

## Credits

Sample datasets from the [Open SciVis Datasets](https://klacansky.com/open-scivis-datasets/) collection:

- **Chameleon** - CT scan of *Chamaeleo calyptratus*. Digital Morphology, 2003.
- **Stag Beetle** - Industrial CT scan. Meister Eduard Gröller, Georg Glaeser, Johannes Kastner, 2005.

## License

MIT
