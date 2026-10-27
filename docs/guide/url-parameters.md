# URL parameters

The demo viewer reads its state from the URL; **Share** (top right) copies the current view as a link.

| Parameter | Values | Description |
|-----------|--------|-------------|
| `dataset` | URL | OME-Zarr or sharded binary dataset |
| `sourceChannels` | zero-based indices, e.g. `5,1` | 1–4 source channels in display order (default: the first four) |
| `timepoint` | zero-based index | Timepoint (default 0) |
| `mode` | `dvr`, `mip`, `iso`, `lod`, `slice` | Render mode |
| `wc`, `ww` | 0–1 | Window centre and width |
| `iso` | 0–1 | Isosurface threshold |
| `density` | 0.1–10 | DVR opacity scale |
| `shade` | 0–1 | DVR gradient shading (default 0) |
| `boundary` | 0–1 | DVR boundary emphasis: opacity follows gradient magnitude (default 0) |
| `tf` | `grayscale`, `grayscale-inverted`, `coolwarm`, `hot`, `cool`, `viridis`, `plasma`, `seismic` | Transfer function preset |
| `tfpts` | x,y pairs, e.g. `0,0,0.5,0.8,1,1` | Transfer function opacity points |
| `up` | `x`, `y`, `z`, `-x`, `-y`, `-z` | Camera up axis |
| `cam` | `rx,ry,dist,tx,ty,tz` | Camera rotation, distance and target |
| `proj` | `ortho` | Orthographic projection for every view, quad panes included (default perspective; also the grid button under the orientation gizmo, or `O`) |
| `scale` | 0.25–1 | Render resolution scale |
| `sse` | pixels | LOD screen-space error threshold (default 8; lower = sharper, more data) |
| `pyramid` | `native`, `legacy` | Level model. Default: native, falling back to legacy if the levels don't fit; setting it disables the fallback |
| `clipMin`, `clipMax` | x,y,z (0–1) | Clip box |
| `slices` | x,y,z (0–1) | Slice positions (`slice` mode) |
| `sliceVis` | 0–7 | Visible slice planes as a bitmask (X = 1, Y = 2, Z = 4; default 7) |
| `wireframe`, `axis` | `1` | Bounding box and axis overlays |
| `layout` | `quad` | Start with front, side and top panes around the 3D view (single-channel viewer; also the grid button in the top bar, or `Q`). The axis panes pan and zoom but don't orbit; the controls set the 3D pane's mode and everything else for all panes |
| `panes` | modes, e.g. `mip,dvr,slice` | Render modes of the front, side and top panes: `dvr`, `mip`, `iso`, `slice` (default `slice`) |

Changing **Up Axis** reorients and recenters the axis panes and updates their labels, including when you next open a hidden quad layout. Their render modes are kept; saved camera poses are restored only while the up axis is unchanged.

```
?dataset=https://example.com/scan.ome.zarr&mode=mip&wc=0.2&ww=0.3&tf=coolwarm
```

The multichannel viewer uses `channels` and `slice` instead of the single-channel display parameters: see [Multichannel demo](/rendering/multichannel#multichannel-demo).

## Diagnostics and experiments

Not included in share links.

| Parameter | Description |
|-----------|-------------|
| `debug=1` | Opens the stats panel (also `D`) |
| `bench=1` | Once streaming and accumulation have converged, logs a report (timings, bytes, bricks) and sets `window.__KILN_BENCH_RESULT`. Options: `benchLabel`, `benchTimeout` (ms, default 120000), `benchStable` (polls, default 8), `report=<url>` to POST the JSON |
| `rayguide=0` | Turns off [ray-guided brick selection](/architecture/streaming#ray-guided-selection), which is on by default |
| `softreset=1` | Experimental fix for woodgrain while refining: brick commits keep part of the accumulated image and jitter is seeded per pixel ([details](/rendering/resolution-taa#jitter-and-accumulation)) |
| `local=true` | Set by the viewer after opening a local directory; reopens it on reload |
