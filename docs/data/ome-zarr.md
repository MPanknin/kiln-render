# OME-Zarr

Kiln streams multiscale [OME-Zarr](https://ngff.openmicroscopy.org/) directly over HTTP, with no conversion, and is listed in the [OME-NGFF tools registry](https://ngff.openmicroscopy.org/resources/tools/index.html). For raw volumes, see the [sharded binary format](/data/sharded-binary).

```typescript
const viewer = await KilnViewer.create(canvas, 'https://example.com/data/scan.ome.zarr');
```

Any URL that doesn't serve a sharded binary `volume.json` is read as OME-Zarr, so URLs without `.zarr` (such as webKnossos layers) work too. Public test data: the [OME-Zarr Open SciVis Datasets](https://registry.opendata.aws/ome-zarr-open-scivis/), e.g. `https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr`.

## Requirements

- **NGFF v0.4 or v0.5** with `multiscales` metadata
- **Spatial axes last:** `z, y, x` as usual, or `x, y, z` as written by [webKnossos](https://webknossos.org). Kiln reads the order from `axes` and reads chunks through their strides, so nothing is transposed
- **Channels:** any 1–4 of a `c` axis at once (see [Multichannel](/rendering/multichannel)); **time:** one timepoint at a time
- **Labels:** label images in the `labels` group, or at other URLs, are shown as layers over the volume (see [Labels](/rendering/labels))
- **Data types:** `uint8`, `uint16`, `int16`, `float32`; `float64` is read as `float32`. Others, such as `int8` or `uint32`, are rejected with a reason
- **Levels:** each multiscale level is a LOD. Kiln reads each level's own size and per-axis downsampling (1× or 2×). If the levels don't fit that model, for example a level a few slices short of half its parent, it falls back to a uniform 2:1 model and logs why. `?pyramid=native` or `?pyramid=legacy` forces either
- **Spacing** from `coordinateTransformations`; **windows** from OMERO metadata when present

## Storage on the GPU

| Source | Atlas format | Normalised by |
|--------|--------------|---------------|
| `uint8` | `r8unorm` | type range |
| `uint16` | `r16unorm` (bit-exact) where the GPU [supports it](/reference/webgpu), else `r16float` (exact up to 4096, i.e. 12-bit data) | type range |
| `int16`, `float32` | `r16float` (half precision) | data range: OMERO window, else the 0.1–99.9th percentile of the coarsest level |

## Layout tips

Two properties of a dataset decide how soon a full coarse image appears:

- **Downsample every axis.** If the levels halve X and Y but keep Z, the coarsest level can still be hundreds of megabytes: a 1920×1920×752 stack with four channels has a 240×240×752 coarsest level of about 270 MB compressed. Add a level or two that also halve Z.
- **Avoid whole-plane chunks.** A brick can only be assembled once all chunks it overlaps have arrived; with one XY plane per chunk, that is most of a level. Cubic chunks (64³ or 128³) let bricks stream independently.

Brick assembly (fetching chunks, decompressing, cutting 66³ bricks) runs in a worker pool. For Zarr v2 stores the metadata is read once and shared with the workers.
