# Kiln

A WebGPU-native out-of-core volume rendering system for large virtualized volumetric datasets.

Kiln streams multi-gigabyte volumes over HTTP, rendering them at interactive framerates using a fixed-size VRAM page cache and virtual texture indirection.

**Documentation:** [Usage Guide](docs/usage-guide.md) · [Architecture](docs/architecture.md) · [Rendering Pipeline](docs/rendering.md) · [Data Guide](docs/data-guide.md) · [WebGPU Notes](docs/webgpu.md) · [References](docs/references.md)

---

## Chameleon CT Scan
#### 2160.0 MB - 1024 × 1024 × 1080 @ 16-bit
<a href="https://mpanknin.github.io/kiln-render/?mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C3.930%2C0.108%2C0.001%2C-0.066" target="_blank">Live Demo</a>

<img width="1725" height="907" alt="553008107-25ae5fa5-7fe6-49d1-b3b1-51784c6220a2" src="https://github.com/user-attachments/assets/f5da8ea1-a924-4ba6-9f29-6f6c18369405" />

## Beechnut micro CT Scan (OME-Zarr 0.5)
#### 3092.0 MB - 1024 × 1024 × 1546 @ 16-bit
<a href="https://mpanknin.github.io/kiln-render/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fbeechnut.ome.zarr&mode=dvr&wc=0.22&ww=0.14&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=-0.090%2C2.130%2C3.171%2C-0.072%2C-0.025%2C-0.013" target="_blank">Live Demo</a>

<img width="1722" height="905" alt="553008573-17268259-5977-4a9b-b4c0-a1756a024857" src="https://github.com/user-attachments/assets/02cffc17-bf44-422b-8752-9bf4edc96d89" />

## Vibrio cholerae Cryo-ET (OME-Zarr 0.4)
#### 1123.9 MB - 1023 × 1440 × 400 @ 16-bit · CryoET Data Portal · sma2022-08-05-1
<a href="https://mpanknin.github.io/kiln-render/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fsma2022-07-13-10.zarr&mode=dvr&wc=0.50&ww=1.00&iso=0.20&tf=grayscale-inverted&tfpts=0.00%2C1.00%2C1.00%2C1.00&up=-z&scale=0.50&cam=0.550%2C12.050%2C1.203%2C0.046%2C0.017%2C0.146&clipMin=0.00%2C0.00%2C0.37&wireframe=1" target="_blank">Live Demo</a>

<img width="1722" height="902" alt="Vibrio cholerae cryo-ET tomogram" src="https://github.com/user-attachments/assets/8e661338-ed45-4024-b818-c3162c11aa04" />

## Install

```bash
npm install kiln-render
```

```typescript
import { KilnViewer } from 'kiln-render';

const canvas = document.querySelector('canvas')!;
const viewer = await KilnViewer.create(canvas, 'https://your-dataset.ome.zarr');
```

Requires a browser with [WebGPU support](#browser-requirements). See the [Usage Guide](docs/usage-guide.md) for the full API.

---

## Features

- **Out-of-core streaming** — Fixed VRAM footprint, SSE-based LOD selection, LRU brick cache
- **OME-Zarr & Kiln binary** — Stream from S3, CDN, or load local files (OME-Zarr v0.5, single-channel, uint8/uint16/float32)
- **Local filesystem** — Load local `.zarr` / `.ome.zarr` directories via the File System Access API (Chrome/Edge)
- **16-bit & float32 support** — Native 16-bit textures with window/level controls; float32 stored internally as r16float
- **Compute shader raymarching** — Brick-aware DVR (with density scale), MIP, isosurface, and slice plane rendering
- **Slice planes** — Orthogonal slice views (X/Y/Z) as a dedicated render mode
- **Transfer functions** — Interactive curve editor with colour/opacity presets
- **Clipping planes** — Per-axis min/max clip in normalised 0–1 space
- **Worker-based pipeline** — Parallel decompression and brick assembly off the main thread

## Development

```bash
# Install dependencies
npm install

# Start development server (loads the bundled demo)
npm run dev

# Build demo for production
npm run build

# Build the library (outputs to lib/)
npm run build:lib
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
- **[Chameleon](https://github.com/InsightSoftwareConsortium/OMEZarrOpenSciVisDatasets#chameleon)** - CT scan of *Chamaeleo calyptratus*. Digital Morphology, 2003.
- **[Beechnut](https://github.com/InsightSoftwareConsortium/OMEZarrOpenSciVisDatasets#beechnut)** - MicroCT scan of a dried beechnut. Computer-Assisted Paleoanthropology, University of Zurich.
- **[Stag Beetle](https://github.com/InsightSoftwareConsortium/OMEZarrOpenSciVisDatasets#stag_beetle)** - Industrial CT scan. Meister Eduard Gröller, Georg Glaeser, Johannes Kastner, 2005.

From the [CryoET Data Portal](https://cryoetdataportal.czscience.com/):
- **[Vibrio cholerae](https://cryoetdataportal.czscience.com/runs/33757?table-tab=Tomograms)** - Cryo-ET tomogram, competence pilus study (*V. cholerae* PilQ GFP / PilT deletion). 

## License

Apache 2.0

---

## Note

> [Read the full write-up on dev.to](https://dev.to/mpanknin/kiln-webgpu-native-out-of-core-volume-rendering-for-multi-gb-datasets-2alb)
>
> [Partly Kiln builds upon my earlier work on volume rendering](https://github.com/MPanknin/volume-occlusion-editor)
