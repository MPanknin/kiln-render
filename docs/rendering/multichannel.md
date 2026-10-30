# Multichannel Rendering

> **Beta** since v0.4.0: the API and compositing may still change.

Kiln renders up to 4 channels of an OME-Zarr dataset at once. Each channel has its own colour, window and visibility, and the channels are blended additively instead of through a transfer function, the usual display for fluorescence microscopy.

![Transfer function versus additive per-channel blending](../diagrams/multichannel-blend.svg)

## Requirements

- OME-NGFF v0.4 or v0.5 with a channel (`c`) axis
- `uint8`, `uint16`, `int16` or `float32`
- OMERO metadata, if present, provides channel names, colours, windows and initial visibility

The sharded binary format is single-channel only.

## Source channels and timepoints

By default the first four channels and timepoint 0 are shown.

**In the viewer:**
- Each channel name in the Controls panel is a picker: choose another source channel, or **Remove from view**. Picking a channel that is already shown swaps the two. **+ Add channel** adds a slot.
- Datasets with a time axis get a **Time** card: scrubber, step buttons, `,` / `.` (Shift: ±10).
- Changes apply in place. Camera and display settings are kept, and channels or timepoints already loaded come from cache. A slot whose channel changes takes that channel's OMERO colour, window and visibility.
- Selecting one channel switches to the single-channel viewer, and vice versa.
- The UI counts timepoints from 1; the API and URL count from 0. There is no playback or prefetching.

**In the API:**

```typescript
const viewer = await KilnViewer.create(canvas, url, {
  sourceChannels: [5, 1], // source channels 6 and 2, in this display order
  timepoint: 3,
});
viewer.metadata.sourceChannelCount; viewer.metadata.timepointCount;
viewer.setSourceSelection({ sourceChannels: [5, 1], timepoint: 4 });
```

- `setSourceSelection` is synchronous. An invalid, duplicate or out-of-range selection throws and changes nothing.
- Renderer channel indices are display slots: `setChannelColor(0, …)` affects source channel 6 here.
- Changing the channel count rebuilds the renderer, so read `viewer.renderer` and `viewer.streamingManager` per use instead of caching them.
- Local Zarr supports the same options. Providers without `setSourceSelection`, such as sharded binary, reject a selection.
- Channel and time axis sizes must match across pyramid levels.

## Per-channel controls

| Control | Behaviour |
|---------|-----------|
| Colour | RGBA. RGB is the display colour; alpha weights the intensity. Alpha 0 hides the channel, which then isn't streamed; showing it again backfills the bricks on screen. Defaults: blue, yellow, red, white |
| Window | Maps a sub-range of the channel's values to 0–1. Taken from OMERO `window.start`/`end`, otherwise derived from the base level |
| Auto (demo) | Fits the window to the channel's base-level values, ignoring zero background and the darkest and brightest 0.5 %. `A` fits all visible channels |

## Compositing

| Mode | Behaviour |
|------|-----------|
| DVR | Colour × windowed intensity, summed over channels, composited front to back. Opacity comes from the strongest channel |
| MIP | Maximum per channel, then summed |
| Slice | Per-channel colour at the slice position, opacity-weighted average |

ISO is not supported.

## API

```typescript
viewer.renderer.numChannels;                          // 1–4
viewer.renderer.setChannelColor(0, 0, 1, 0, 1);       // slot 0 → green
viewer.renderer.setChannelColor(1, 1, 0, 0, 0.5);     // slot 1 → red, half weight
viewer.renderer.setChannelWindow(0, 0.3, 0.4);        // centre, width (normalised 0–1)
viewer.streamingManager.getChannelHistogram(0, 256);  // base-level value histogram, or null before it has loaded

// Fires when windows are derived from the data or OMERO metadata
viewer.onChannelWindowsChanged = () => {
  const centres = viewer.renderer.channelWindowCenter; // Float32Array(4)
  const widths = viewer.renderer.channelWindowWidth;
};
```

## Multichannel demo

`examples/multichannel-viewer/`, started with `bun run dev:multichannel` (`http://localhost:3001`).

| Parameter | Format | Description |
|-----------|--------|-------------|
| `dataset` | URL | OME-Zarr dataset |
| `channels` | `r,g,b,a,vis,min,max;…` | Per-channel colour (0–255), weight, visibility and window (0–1) |
| `sourceChannels`, `timepoint` | zero-based indices | Source selection |
| `mode` | `dvr`, `mip`, `slice` | Render mode |
| `slice` | `x,y,z,showX,showY,showZ` | Slice positions and visibility |
| `cam`, `up`, `scale`, `pyramid`, `wireframe` | | As in the [single-channel viewer](/guide/url-parameters) |

```
?channels=51,102,255,1.00,1,0.10,0.80;255,230,51,1.00,1,0.20,0.90;255,51,51,1.00,0,0.00,1.00
```

## Known limitations

- **4 channels at once.** Per-channel uniforms are `vec4f`.
- **No transfer function, no ISO, no DVR shading.**
- **VRAM scales with channel count.** Each channel has its own atlas, so the atlas grid shrinks to stay within the budget ([sizes](/architecture/virtual-texturing#multichannel-atlas)).
- **Requests scale with visible channels.** Each brick is fetched once per channel. The base level loads channel by channel, so the first channel appears early.
