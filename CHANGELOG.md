# Changelog

All notable changes to Kiln are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Kiln uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, minor versions may include breaking API changes.

## [Unreleased]

### Added
- OME-Zarr with x, y, z axis order and Zarr URLs without `.zarr`, so public [webKnossos](https://webknossos.org) datasets open directly.

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
