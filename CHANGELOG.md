# Changelog

All notable changes to Kiln are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Kiln uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, minor versions may include breaking API changes.

## [Unreleased]

### Added
- OME-Zarr with x, y, z axis order and Zarr URLs without `.zarr`, so public [webKnossos](https://webknossos.org) datasets open directly.
- Auto contrast per channel in the multichannel viewer (an **Auto** button on each channel, `A` fits all visible channels).
- `StreamingManager.getChannelHistogram(channel, bins)`: the value distribution of a channel over the loaded base level.
- `?bench=1` reports how much of the downloaded chunk payload data (excluding shared shard indexes) came from chunks that only the one-voxel brick border needed.
- Experimental ray-guided brick selection behind the `?rayguide=1` URL flag: rays mark the brick cells they enter, and bricks no ray reached (behind opaque material, outside the clip box) are not streamed. The stats panel and `?bench=1` report how many bricks it left out.
- Opt-in, LOD-consistent gradient shading in single-channel DVR, and optional boundary emphasis, where opacity follows the gradient magnitude. Set them with the `shading` and `gradientOpacity` options, the **Shading** and **Boundaries** sliders, or the `shade` and `boundary` URL parameters.

### Changed
- Atlas selection validates filterable 3D bindings inside a WebGPU error scope. Devices exposing unfilterable `r16unorm` under `texture-formats-tier1` fall back to the 12-bit-exact `r16float` path before loading bricks.
- `uint16` volumes are stored bit-exact as `r16unorm` where the GPU supports `texture-formats-tier1`, which `KilnEngine.createDevice()` now requests. Without it they stay on `r16float`, now stored so that 12-bit data is exact; it used to lose about a quarter of its levels.
- Window, width, ISO and channel level sliders span the data's value range instead of the whole data type range, and label raw values. 12-bit microscopy stored as `uint16` used to live in the first two slider steps.
- `StreamingManager.setBaseLodLoadedCallback` no longer passes brick data to the callback, and also fires when a channel shown later has filled in.

### Fixed
- Ray-guided streaming keeps a brick visible for the same number of frames with TAA on or off. With TAA off, each readback covers one frame, which shrank the window fourfold.
- Ray-guided streaming flushes visibility when rendering goes idle, including with TAA disabled and when a previous GPU readback is still pending, so newly exposed bricks can refine without another camera movement.
- `int16` and `float32` values are rounded to the nearest half float. They were truncated, and values below 2^-14 were flushed to zero.

## [0.5.0] - 2026-09-28

### Added
- Native OME-Zarr pyramids with per-axis downsampling (for example anisotropic or XY-only levels), with automatic fallback to the previous 2:1 model when a dataset's levels don't fit.
- `int16` volumes.
- Progressive loading: the base level fills in progressively, and multichannel datasets stream only visible channels.
- OMERO channel names and windows in the multichannel viewer.
- The viewer shows the source data type (`uint8`, `uint16`, `int16`, `float32`).
- `KilnEngine`, a headless engine for hosts that bring their own device, camera and frame loop. `KilnViewer` is now built on it.

### Removed
- The `pageLoadStart` option. Load timings are available from `viewer.milestones`.

### Fixed
- Chunk-to-brick assembly for some chunk layouts and packed channels.
- Empty-brick detection now accounts for the data type and window.
- Sharded binary format: duplicate index loads, range validation, and conversion by source data type.
- GPU resources are released when a viewer is disposed.
- Slice view: missing channel controls, and contrast and colormap controls in single-channel mode.

### Security
- Dataset rejection messages are rendered as plain text, so crafted metadata can't inject HTML.

## [0.4.1] - 2026-07-12

### Fixed
- Type declarations in the published package: no leaked `zarrita` type imports, and `@webgpu/types` is included so consumers don't need extra packages.

## [0.4.0] - 2026-07-12

### Added
- Multichannel rendering (beta): up to 4 channels with per-channel color, windowing and visibility.
- Slice views, with level-of-detail streaming.
- Density multiplier and camera-centric lighting for isosurfaces.
- Documentation site at [kilnrender.com](https://kilnrender.com) with architecture documentation.

### Changed
- Streaming overhaul: abort-safe requests, bounded concurrency, and spatial worker routing by default.
- Faster brick assembly and float16 conversion; fixes for idle render stalls.
- New control panel UI for the demo viewers.
- Includes the changes from 0.3.0, which was not published to npm.

## [0.2.1] - 2026-05-12

### Fixed
- Inlined worker imports in the published bundle.

## [0.2.0] - 2026-05-12

First release on npm.

### Added
- `KilnViewer.create()` public API with a configuration object, a public export index, and inlined workers.
- Out-of-core streaming into a bounded GPU atlas with virtual-texture indirection, screen-space-error LOD selection and an LRU brick cache.
- Remote OME-Zarr (NGFF) datasets and Kiln's sharded binary format with a conversion CLI.
- Local OME-Zarr loading through the File System Access API (Chrome/Edge).
- 8-bit and 16-bit volumes with window/level controls, auto-leveling from dataset metadata, and a histogram from the base level.
- Texture-format detection with an `r16float` fallback.
- Compute-shader ray marching with direct volume rendering, maximum intensity projection and isosurface modes, clipping planes, and temporal anti-aliasing.
- Example viewers.

### Changed
- Licensed under Apache 2.0.

[Unreleased]: https://github.com/MPanknin/kiln-render/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/MPanknin/kiln-render/releases/tag/v0.5.0
[0.4.1]: https://github.com/MPanknin/kiln-render/releases/tag/v0.4.1
[0.4.0]: https://github.com/MPanknin/kiln-render/releases/tag/v0.4.0
[0.2.1]: https://github.com/MPanknin/kiln-render/releases/tag/v0.2.1
[0.2.0]: https://github.com/MPanknin/kiln-render/releases/tag/v0.2.0
