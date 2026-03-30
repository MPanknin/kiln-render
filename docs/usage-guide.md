# Usage Guide

How to load custom datasets and use URL parameters with Kiln.

See also: [Architecture](architecture.md) | [Rendering Pipeline](rendering.md) | [Data Guide](data-guide.md) | [WebGPU Notes](webgpu.md)

---

## Loading Custom Datasets

Add the `dataset` URL parameter to load your own data:

```
https://mpanknin.github.io/kiln-render/?dataset=YOUR_DATASET_URL
```

**Example:**
```
?dataset=https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/kingsnake.ome.zarr
```

### OME-Zarr (Experimental)

OME-Zarr is easiest for external users - no preprocessing required, just point to a URL.

> ⚠️ **Experimental feature:** Start with small datasets (< 500 MB) first, then scale up. Large datasets (> 4 GB) may feel sluggish dependong on network bandwidth.

## Troubleshooting: Nothing Visible

**If you see a black screen after loading, adjust Window/Level:**

1. Open **Controls** panel (gear icon, top-left)
2. Find **Window/Level** section
3. Try these settings:
   - **Window Center**: `0.5`, **Window Width**: `1.0` (full range)
   - Or try **Center**: `0.2`, **Width**: `0.3` (narrow, for low-density data)
   - Switch to **MIP** mode to see any visible data

**Why?** Different datasets have different value ranges. Your data might occupy only a small portion (e.g., 0.1-0.3) of the normalized 0-1 range. Window/Level adjusts contrast to make features visible.

---

## URL Parameters

Control rendering settings via URL parameters to share or bookmark specific views.

| Parameter | Values | Description | Example |
|-----------|--------|-------------|---------|
| `dataset` | URL | Volume data source | `dataset=https://...volume.ome.zarr` |
| `mode` | `dvr`, `mip`, `iso`, `lod` | Render mode | `mode=mip` |
| `wc` | 0-1 | Window center | `wc=0.35` |
| `ww` | 0-1 | Window width | `ww=0.55` |
| `iso` | 0-1 | Isosurface threshold | `iso=0.15` |
| `tf` | `grayscale`, `coolwarm`, `hot`, `viridis`, etc. | Transfer function | `tf=coolwarm` |
| `up` | `x`, `y`, `z`, `-x`, `-y`, `-z` | Camera up axis | `up=-y` |
| `scale` | 0.25-1.0 | Render resolution | `scale=1.0` |
| `cam` | 6 numbers | Camera state (rotation, distance, target) | `cam=0.1,2.3,3.5,0,0,0` |
| `clipMin` | x,y,z | Clipping min (0-1) | `clipMin=0.2,0.1,0` |
| `clipMax` | x,y,z | Clipping max (0-1) | `clipMax=0.8,0.9,1` |

**Example:**
```
?dataset=https://example.com/scan.ome.zarr&mode=mip&wc=0.2&ww=0.3&tf=coolwarm
```

---

## Share Button

Click the **Share** button (top-right) to copy the current view as a URL, including:
- Dataset, render mode, window/level, camera position, clipping planes, etc.

Use the URL to:
- Share specific views with colleagues
- Bookmark configurations
- Embed in documentation
