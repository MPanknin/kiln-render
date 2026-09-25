# OME-Zarr

Kiln supports two input formats:

| Format | Preprocessing | Use Case |
|--------|---------------|----------|
| **OME-Zarr (NGFF v0.4/v0.5)** | None — no Kiln-specific conversion | Standard scientific imaging format, chunked arrays |
| **Kiln sharded binary** | Requires [conversion script](/data/sharded-binary) | Gzip-compressed bricks, HTTP Range streaming |

Kiln can load compatible multiscale [OME-Zarr](https://ngff.openmicroscopy.org/) volumes directly over HTTP, with no Kiln-specific conversion. Point it at a `.ome.zarr` URL and it streams chunk data on demand.

Kiln is listed in the [OME-NGFF tools registry](https://ngff.openmicroscopy.org/tools/).

## Requirements

- **OME-NGFF v0.4 and v0.5** with `multiscales` metadata in group attributes
- **Single-channel or multichannel** — up to 4 channels (see [Multichannel](/rendering/multichannel))
- **3D arrays** with dimensions ordered `[z, y, x]` (standard C-order); multichannel datasets use a `c` axis
- **Supported dtypes:** `uint8`, `uint16`, `float32` input (signed integers and `float64` not supported)
- Multiple resolution levels (datasets within `multiscales`) are used as LODs
- Voxel spacing is read from `coordinateTransformations` if present
- OMERO metadata is used for per-channel window auto-leveling when available

> **Note:** Currently unsupported: more than 4 channels, signed integer types (`int8`, `int16`), and `float64`. `uint16` and `float32` volumes are stored internally as `r16float` (WebGPU filterable-float32 is not universally available, and there's no native 16-bit-integer alternative in use here); this is not bit-exact across the full `uint16` range. min/max range is read from metadata and used to normalise values in the shader.

## Usage

Pass the `.ome.zarr` URL directly to `KilnViewer.create()`:

```typescript
import { KilnViewer } from 'kiln-render';

const viewer = await KilnViewer.create(canvas, 'https://example.com/data/scan.ome.zarr');
```

Kiln auto-detects the format from the URL. Brick assembly (fetching Zarr chunks, decompressing, and re-chunking into 66³ bricks with ghost borders) runs in a Web Worker pool off the main thread. For Zarr v2 stores (NGFF 0.4) the metadata is read in two round trips and shared with the workers, so they start without touching the network.

## Public OME-Zarr datasets

The [OME-Zarr Open SciVis Datasets](https://registry.opendata.aws/ome-zarr-open-scivis/) on AWS provide ready-to-use test volumes:

```typescript
const viewer = await KilnViewer.create(
  canvas,
  'https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr',
);
```

## Axis convention

Zarr stores dimensions as `[z, y, x]` (C-order, x fastest-varying). Kiln uses `[x, y, z]` in its metadata. Only metadata tuples are swapped; no data transposition is needed since the memory layout is identical.
