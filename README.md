# Kiln

[![npm](https://img.shields.io/npm/v/kiln-render?color=cb3837)](https://www.npmjs.com/package/kiln-render)
[![CI](https://github.com/MPanknin/kiln-render/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MPanknin/kiln-render/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![OME-NGFF tools registry](https://img.shields.io/badge/OME--NGFF-tools%20registry-2b8cbe)](https://ngff.openmicroscopy.org/resources/tools/index.html)
<!-- Add after the first Zenodo-archived release (replace XXXXXXX with the concept DOI record ID):
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.XXXXXXX.svg)](https://doi.org/10.5281/zenodo.XXXXXXX)
-->

A WebGPU-native out-of-core volume rendering system for large virtualized volumetric datasets.

Kiln streams multi-gigabyte volumes over HTTP, rendering them at interactive framerates using a bounded GPU residency/atlas cache and virtual-texture indirection. It handles single-channel and multichannel OME-Zarr datasets (up to 4 channels).

> **v0.5.0** — Multichannel rendering is in **beta**; see [Multichannel](docs/rendering/multichannel.md) for details and known limitations.

**Documentation:** New to Kiln? Start with the [Guide](docs/guide/introduction.md), or browse the [full docs index](docs/README.md).

---

[![Chameleon CT scan — 2160 MB, 1024 × 1024 × 1080 · uint16](https://github.com/user-attachments/assets/f5da8ea1-a924-4ba6-9f29-6f6c18369405)](https://kilnrender.com/app/?mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C3.930%2C0.108%2C0.001%2C-0.066)

*Chameleon CT scan — 2160 MB, 1024 × 1024 × 1080 · uint16 · [Live demo →](https://kilnrender.com/app/?mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C3.930%2C0.108%2C0.001%2C-0.066) · [Gallery →](https://kilnrender.com/gallery.html)*

## Install

```bash
npm install kiln-render
```

Ships as an ES module with bundled dependencies and TypeScript types (including `@webgpu/types`) — no peer packages to install.

## Usage

```html
<canvas></canvas>
<p id="status"></p>
```

```js
import { KilnViewer } from 'kiln-render';

const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');

try {
  const viewer = await KilnViewer.create(
    canvas,
    'https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr',
  );
  status.textContent = `rendering — mode: ${viewer.mode}`;
  window.viewer = viewer;
} catch (err) {
  status.textContent = `failed: ${err.message}`;
  console.error(err);
}
```

`KilnViewer.create()` initialises WebGPU, sets up streaming, and starts the render loop; it rejects with a descriptive error if WebGPU is unavailable (hence the `try/catch`). See the [Quick start](docs/guide/quick-start.md) for `ViewerOptions`, viewer properties, state serialisation, and cleanup.

## Features

- **Out-of-core streaming** — Fixed VRAM footprint, SSE-based LOD selection, LRU brick cache
- **Multichannel rendering** — Up to 4 channels with per-channel colour, windowing, and visibility controls ([details](docs/rendering/multichannel.md))
- **OME-Zarr & Kiln binary** — Stream from S3, CDN, or load local files (OME-Zarr v0.4/v0.5, uint8/uint16/int16/float32)
- **Local filesystem** — Load local `.zarr` / `.ome.zarr` directories via the File System Access API (Chrome/Edge)
- **uint8, uint16, int16 & float32 input** — everything except `uint8` is stored as `r16float` on the GPU, with window/level controls
- **Compute shader raymarching** — Brick-aware DVR (with density scale), MIP, isosurface, and slice plane rendering

## Developing from source

Clone the repo and install dev dependencies with [Bun](https://bun.sh) (this is for working on Kiln itself — consumers only need `npm install kiln-render`, above):

```bash
# Install dependencies
bun install

# Start development server (single-channel demo)
bun run dev

# Start multichannel demo
bun run dev:multichannel

# Build demo for production
bun run build

# Build the library (outputs to lib/)
bun run build:lib
```

The demo loads a sample dataset from S3. To load custom datasets, see [Loading data](docs/guide/loading-data.md).

## Browser Requirements

Kiln requires **WebGPU** support:
- Chrome/Edge 113+
- Safari 26+
- Firefox 141+

Make sure hardware acceleration is enabled in your browser settings.

## Contributing

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Questions go to [Discussions](https://github.com/MPanknin/kiln-render/discussions).

## Citing Kiln

If you use Kiln in your research, please cite it. The **Cite this repository** button in the GitHub sidebar gives APA and BibTeX entries.

## License

Apache 2.0 — see [LICENSE](LICENSE).

---


