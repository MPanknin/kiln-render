# Multichannel Rendering

> **Beta** — Multichannel rendering is new in v0.4.0 and still stabilizing; the API and compositing behaviour may change. See [Known Issues](/reference/issues) for current limitations.

Kiln can render OME-Zarr datasets with up to 4 channels simultaneously. Each channel is rendered with independent colour, window/level, and visibility controls. Compositing uses additive blending rather than transfer functions.

## Overview

Single-channel rendering maps voxel intensity through a transfer function to produce colour and opacity. Multichannel rendering takes a different approach: each channel contributes a user-defined colour weighted by its intensity, and the contributions are summed additively. This is a common display approach for fluorescence microscopy, where each channel typically represents a different stain or marker.

```
Single-channel:   intensity → transfer function → colour + opacity
Multichannel:     per-channel intensity × per-channel colour → additive blend
```

## Supported formats

Multichannel rendering works with OME-Zarr datasets that have a channel (`c`) axis:

- **OME-NGFF v0.4 and v0.5**
- **Up to 4 channels** (datasets with more channels will use the first 4)
- **Supported dtypes:** `uint8`, `uint16`, `float32`
- OMERO metadata is used for per-channel window auto-leveling when available

The Kiln sharded binary format is single-channel only.

## Per-channel controls

Each channel has three independent controls:

### Colour

A 4-component RGBA colour. The RGB components define the channel's display colour; the alpha component acts as an intensity weight.

Default colours:
| Channel | Colour |
|---------|--------|
| 0 | Blue (0.0, 0.0, 1.0) |
| 1 | Yellow (1.0, 1.0, 0.0) |
| 2 | Red (1.0, 0.0, 0.0) |
| 3 | White (1.0, 1.0, 1.0) |

### Window / Level

Per-channel intensity windowing remaps a sub-range of the raw intensity to the visible 0–1 output. This is essential for datasets where channels have very different intensity ranges (common in fluorescence).

When OMERO metadata is available in the OME-Zarr store, Kiln reads per-channel `window.start` / `window.end` values and applies them automatically. Otherwise, ranges are derived from the data during base LOD loading.

### Visibility

Channels can be toggled on/off. A hidden channel (alpha = 0) contributes nothing to the composite — its data is still streamed but not rendered.

## Compositing

Multichannel compositing is **additive**: each channel's colour is weighted by its windowed intensity and the results are summed. This applies to all supported render modes:

| Mode | Multichannel behaviour |
|------|----------------------|
| **DVR** | Per-channel colour × windowed intensity, summed additively, then composited front-to-back |
| **MIP** | Per-channel maximum intensity tracked independently, then composited via additive blending |
| **Slice** | Per-channel colour at slice position, blended by opacity-weighted average |

ISO (isosurface) mode is not supported for multichannel datasets.

Transfer functions are **not used** in multichannel mode. Colour is determined entirely by the per-channel colour and intensity windowing.

## API

### Reading channel count

```typescript
const viewer = await KilnViewer.create(canvas, 'https://example.com/multichannel.ome.zarr');
const numChannels = viewer.renderer.numChannels; // 1–4
```

### Setting channel colour

```typescript
// setChannelColor(channel, r, g, b, a?)
viewer.renderer.setChannelColor(0, 0.0, 1.0, 0.0, 1.0); // channel 0 → green
viewer.renderer.setChannelColor(1, 1.0, 0.0, 0.0, 0.5); // channel 1 → red, half intensity

// Hide a channel by setting alpha to 0
viewer.renderer.setChannelColor(2, 1.0, 1.0, 1.0, 0.0); // channel 2 → hidden
```

### Setting channel window/level

```typescript
// setChannelWindow(channel, center, width) — both in normalised 0–1 range
viewer.renderer.setChannelWindow(0, 0.3, 0.4); // channel 0: centre=0.3, width=0.4
viewer.renderer.setChannelWindow(1, 0.5, 1.0); // channel 1: full range
```

### Responding to auto-leveling

When per-channel intensity ranges are derived during base LOD loading, the `onChannelWindowsChanged` callback fires. Use this to update UI controls:

```typescript
viewer.onChannelWindowsChanged = () => {
  // Channel windows have been updated from data or OMERO metadata.
  // Read the current values from the renderer and update your UI.
  const cw = viewer.renderer.channelWindowCenter; // Float32Array(4)
  const ww = viewer.renderer.channelWindowWidth;  // Float32Array(4)
};
```

## Multichannel demo

A dedicated multichannel demo is included at `examples/multichannel-viewer/`:

```bash
npm run dev:multichannel   # http://localhost:3001
```

The demo provides per-channel UI controls (colour picker, window sliders, visibility toggle) and supports URL-shareable state.

### URL parameters

| Parameter | Format | Description |
|-----------|--------|-------------|
| `dataset` | URL | OME-Zarr dataset URL |
| `channels` | `r,g,b,a,vis,min,max;...` | Per-channel state, semicolon-separated |
| `mode` | `dvr`, `mip`, `slice` | Render mode |
| `slice` | `x,y,z,showX,showY,showZ` | Slice plane positions and visibility |
| `cam` | `rx,ry,dist,tx,ty,tz` | Camera state |
| `up` | `x`, `y`, `z`, `-x`, `-y`, `-z` | Camera up axis |
| `scale` | 0.25–1.0 | Render resolution |

Channel state encodes each channel as `r,g,b,a,visible,windowMin,windowMax` (0–255 for RGB, 0–1 for the rest), separated by semicolons:

```
?channels=51,102,255,1.00,1,0.10,0.80;255,230,51,1.00,1,0.20,0.90;255,51,51,1.00,0,0.00,1.00
```

## Known limitations

- **Max 4 channels** — GPU uniforms use `vec4f` for per-channel data, limiting to 4 channels. Datasets with more channels will use the first 4.
- **No transfer function** — Multichannel mode uses additive compositing with direct per-channel colours. The transfer function editor is not available.
- **No ISO mode** — Isosurface rendering is not supported for multichannel datasets.
- **VRAM scales with channel count** — Each channel gets its own atlas texture, so the atlas grid shrinks as channels increase to stay within the VRAM budget. See [Architecture → Memory Budget](/architecture/memory-budget) for the exact grid sizes.
- **Network load scales with visible channels** — Each brick requires one fetch per channel, so a 4-channel dataset issues up to 4× the requests of a single-channel one. Hidden channels are not streamed; the base level loads channel by channel so the first channel is visible early.
- **Kiln binary format** — The sharded binary format is single-channel only. Multichannel requires OME-Zarr.
