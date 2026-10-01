# OME-Zarr

Kiln supports two input formats:

| Format | Preprocessing | Use Case |
|--------|---------------|----------|
| **OME-Zarr (NGFF v0.4/v0.5)** | None — no Kiln-specific conversion | Standard scientific imaging format, chunked arrays |
| **Kiln sharded binary** | Requires [conversion script](/data/sharded-binary) | Gzip-compressed bricks, HTTP Range streaming |

Kiln can load compatible multiscale [OME-Zarr](https://ngff.openmicroscopy.org/) volumes directly over HTTP, with no Kiln-specific conversion. Point it at a `.ome.zarr` URL and it streams chunk data on demand.

Kiln is listed in the [OME-NGFF tools registry](https://ngff.openmicroscopy.org/resources/tools/index.html).

## Requirements

- **OME-NGFF v0.4 and v0.5** with `multiscales` metadata in group attributes
- **Single-channel or multichannel** — up to 4 channels (see [Multichannel](/rendering/multichannel))
- **3D arrays** with x, y and z as the last three dimensions, usually `[z, y, x]`; `[x, y, z]` as written by [webKnossos](https://webknossos.org) works too. Multichannel datasets use a `c` axis
- **Supported dtypes:** `uint8`, `uint16`, `int16`, `float32` (`float64` is read as `float32`). Other types, such as `int8` or `uint32`, are rejected with an explanation
- Multiple resolution levels (datasets within `multiscales`) are used as LODs. Kiln reads each level's own size and per-axis downsampling (1× or 2×). If the stored levels don't fit that model, for example a coarse level a few slices short of half its parent, it falls back to a uniform 2:1 model and logs why. Force either model with `?pyramid=native` or `?pyramid=legacy`
- Voxel spacing is read from `coordinateTransformations` if present
- OMERO metadata is used for per-channel window auto-leveling when available

> **Note:** Currently unsupported: more than 4 channels, and data types other than the ones listed above. `uint8` is stored as `r8unorm`; every other type is stored as `r16float` (half precision; WebGPU filterable-float32 is not universally available), which is not bit-exact across a full 16-bit range. `uint16` is normalised by its type range. `int16` and floats keep their raw values and are normalised in the shader by a data range: the OMERO window's min/max when present, otherwise the 0.1–99.9th percentile of the coarsest level.

## Usage

Pass the `.ome.zarr` URL directly to `KilnViewer.create()`:

```typescript
import { KilnViewer } from 'kiln-render';

const viewer = await KilnViewer.create(canvas, 'https://example.com/data/scan.ome.zarr');
```

Any URL that doesn't serve Kiln's sharded format (a `volume.json`) is read as OME-Zarr, so URLs without `.zarr`, such as webKnossos layers, work as well. Brick assembly (fetching Zarr chunks, decompressing, and re-chunking into 66³ bricks with ghost borders) runs in a Web Worker pool off the main thread. For Zarr v2 stores (NGFF 0.4) the metadata is read in two round trips and shared with the workers, so they start without touching the network.

### Layout tips for fast streaming

Kiln streams whatever layout it is given, but two properties of the source decide how quickly a full coarse image can appear:

- **A pyramid that downsamples every axis.** If the multiscale levels halve X and Y but keep Z at full resolution, the coarsest level can still be hundreds of megabytes (a 1920×1920×752 stack with four channels has a 240×240×752 coarsest level of about 270 MB compressed). Kiln shows the first bricks and the first channel early, but the complete base still costs that download. Add a level or two that also halve Z.
- **Chunks that are not whole planes.** With chunks of one full XY plane, every brick needs all planes of its Z range before it can be assembled, so nothing shows until most of a level has arrived. Cubic or near-cubic chunks (for example 64³ or 128³) let bricks stream independently.

## Public OME-Zarr datasets

The [OME-Zarr Open SciVis Datasets](https://registry.opendata.aws/ome-zarr-open-scivis/) on AWS provide ready-to-use test volumes:

```typescript
const viewer = await KilnViewer.create(
  canvas,
  'https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr',
);
```

## Axis convention

Most OME-Zarr stores dimensions as `[z, y, x]`; webKnossos writes `[x, y, z]`. Kiln reads the order from the `axes` metadata and uses `[x, y, z]` internally. Chunks are read through their strides, so no data is transposed.
