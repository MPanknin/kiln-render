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

> ⚠️ **Experimental feature:** Start with small datasets (< 500 MB) first, then scale up. Large datasets (> 4 GB) may feel sluggish depending on network bandwidth.

**Supported formats:**
- OME-NGFF v0.5 only (v0.4 not supported)
- Single-channel datasets (multi-channel/RGB not supported)
- `uint8` and `uint16` data types only (no signed integers or floats)

See the [Data Guide](data-guide.md) for full format requirements.

### Local Datasets (File System Access API)

Load local Zarr datasets directly from your filesystem using the "Load Local" button.

> **Browser requirement:** Local dataset loading requires the File System Access API, which is currently **only supported in Chrome/Edge**. Safari and Firefox do not support this feature.

**How it works:**
1. Click "Load Local" button
2. Select a `.zarr` or `.ome.zarr` directory
3. Grant read permission when prompted
4. Dataset loads with auto-leveling based on OMERO metadata (if available)

**Note:** When you load a local dataset, all URL parameters are cleared to ensure the new dataset loads with fresh defaults.

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

---

## UI Controls

| Control | Description |
|---------|-------------|
| **Mode** | DVR, MIP, ISO, or LOD visualization |
| **Up Axis** | Camera orientation (X, Y, Z, -X, -Y, -Z) |
| **Indirection** | Toggle virtual texturing on/off |
| **Wireframe** | Show volume bounding box |
| **Transfer Function** | Color/opacity presets and interactive curve editing |
| **Window/Level** | Contrast adjustment for 16-bit data (center and width) |
| **Gradient Opacity** | Modulate opacity based on gradient magnitude |
| **Ambient Occlusion** | Local AO approximation (6-sample) |
| **Clipping Planes** | Min/Max clipping bounds per axis |

---

## FAQ

### Which browsers are supported?

Kiln requires WebGPU. Chrome/Edge 113+ and Safari 26+ support it out of the box. Firefox ships WebGPU by default in recent versions (141+), though support may be partial on some platforms — check `dom.webgpu.enabled` if needed. Make sure hardware acceleration is enabled in your browser settings.

### How much VRAM does Kiln use?

The atlas is a fixed-size 3D texture. With the default 1,000 brick slots it uses ~274 MiB for 8-bit data and ~548 MiB for 16-bit data. You can adjust the atlas size in `config.ts` for different quality/memory tradeoffs, but usage always stays constant regardless of dataset size.

### Can I load my own data?

Yes! The easiest way is to use OME-Zarr datasets directly via URL parameters. See the "Loading Custom Datasets" section above for instructions. For advanced preprocessing, see the [Data Guide](data-guide.md).

### What are the known rendering issues?

Brick boundary seams are still visible in some cases, especially in isosurface (ISO) mode where normal estimation samples across brick edges. LOD transitions can also produce brief visual discontinuities while bricks stream in. These are known issues and will be addressed in the future.

### Can I use Kiln in my own application?

Kiln is MIT licensed, so you are free to use, modify, and integrate it. We plan to provide an installable npm package in the future, but for now Kiln is a standalone viewer. There is no stable public API yet and the internals may change, so if you build on top of it, pinning to a specific commit is recommended.
