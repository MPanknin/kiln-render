# URL parameters

Control rendering settings via URL parameters to share or bookmark specific views.

| Parameter | Values | Description | Example |
|-----------|--------|-------------|---------|
| `dataset` | URL | Volume data source | `dataset=https://...volume.ome.zarr` |
| `mode` | `dvr`, `mip`, `iso`, `lod`, `slice` | Render mode | `mode=mip` |
| `wc` | 0-1 | Window center | `wc=0.35` |
| `ww` | 0-1 | Window width | `ww=0.55` |
| `iso` | 0-1 | Isosurface threshold | `iso=0.15` |
| `density` | 0.1-10 | DVR density (opacity) scale | `density=1.5` |
| `tf` | `grayscale`, `grayscale-inverted`, `coolwarm`, `hot`, `cool`, `viridis`, `plasma`, `seismic` | Transfer function preset | `tf=coolwarm` |
| `tfpts` | x,y pairs | TF opacity control points (comma-separated) | `tfpts=0,0,0.5,0.8,1,1` |
| `up` | `x`, `y`, `z`, `-x`, `-y`, `-z` | Camera up axis | `up=-y` |
| `scale` | 0.25-1.0 | Render resolution | `scale=1.0` |
| `sse` | pixels | LOD screen-space error threshold (default 8; lower = sharper, more data) | `sse=4` |
| `pyramid` | `native`, `legacy` | Level model. Omitted: native, falling back to legacy when the stored levels don't fit; setting it turns the fallback off | `pyramid=legacy` |
| `cam` | 6 numbers | Camera state (rotation, distance, target) | `cam=0.1,2.3,3.5,0,0,0` |
| `clipMin` | x,y,z | Clipping min (normalised 0–1) | `clipMin=0.2,0.1,0` |
| `clipMax` | x,y,z | Clipping max (normalised 0–1) | `clipMax=0.8,0.9,1` |
| `slices` | x,y,z | Slice plane positions (normalised 0–1, only used in `slice` mode) | `slices=0.5,0.5,0.5` |
| `sliceVis` | 0–7 | Slice plane visibility bitmask (bit 0=X, 1=Y, 2=Z; default 7 = all visible) | `sliceVis=3` |
| `wireframe` | `1` | Enable bounding box wireframe overlay | `wireframe=1` |
| `axis` | `1` | Enable world-space axis overlay | `axis=1` |

**Example:**
```
?dataset=https://example.com/scan.ome.zarr&mode=mip&wc=0.2&ww=0.3&tf=coolwarm
```

The **Share** button (top-right of the demo) copies the current view as a URL with all parameters filled in.

> Multichannel datasets use a different set of URL parameters (per-channel colour, windowing, and visibility). See [Multichannel → URL parameters](/rendering/multichannel#url-parameters).
