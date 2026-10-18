# Introduction

Kiln is a WebGPU volume renderer for datasets larger than GPU memory. It streams 64³ bricks over HTTP into a fixed-size GPU atlas, and loads finer detail only where the view needs it.

It reads [OME-Zarr](/data/ome-zarr) (NGFF v0.4/v0.5, up to 4 channels at once, one timepoint at a time) and Kiln's [sharded binary format](/data/sharded-binary), in `uint8`, `uint16`, `int16` or `float32`.

## Where to next

- **[Quick start](/guide/quick-start)**: a viewer in a few lines
- **[Loading data](/guide/loading-data)**: remote, local and multichannel datasets
- **[URL parameters](/guide/url-parameters)**: shareable views
- **[Gallery](/gallery)**: example datasets, each opening in the viewer
- **[Architecture](/architecture/overview)**: how streaming and virtual texturing work
