# Changelog

All notable changes to Kiln are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While Kiln is below 1.0, minor versions may include breaking API changes.

## [Unreleased]

### Added
- Native support for OME-Zarr pyramids with per-axis downsampling factors (for example anisotropic or XY-only levels), used by default, with fallback to the previous pyramid model when a dataset's levels are rejected.
- `int16` volumes.
- Progressive loading: the base level loads progressively, and only visible channels are streamed and refined in multichannel datasets.
- OMERO channel names shown in the multichannel viewer; OMERO metadata applied to channel windows.
- Exact source data types shown in the viewer and gallery.
- Worker chunk cache sized to the dataset.
- Pipeline milestones for load-time telemetry.
- CI runs the type check and unit tests on every push and pull request, and validates the published package shape and types.

### Changed
- Split into a headless engine and the `KilnViewer` wrapper.
- Improved metadata fetching and viewer UI tools.

### Fixed
- Chunk-to-brick assembly addressing, chunk strides, and packed channel chunks.
- Empty-brick classification now accounts for data type and window.
- Sharded binary path: deduplicated index loads, range validation, conversion by source data type.
- Engine-owned GPU resources are disposed on teardown.
- Redraw notifications stay bounded while bricks arrive continuously.
- Normalization window, missing channel controls in slice view, and contrast and colormap controls in single-channel slice mode.
- Dataset rejection reasons are rendered as plain text.

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

[Unreleased]: https://github.com/MPanknin/kiln-render/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/MPanknin/kiln-render/releases/tag/v0.4.1
[0.4.0]: https://github.com/MPanknin/kiln-render/releases/tag/v0.4.0
[0.2.1]: https://github.com/MPanknin/kiln-render/releases/tag/v0.2.1
[0.2.0]: https://github.com/MPanknin/kiln-render/releases/tag/v0.2.0
