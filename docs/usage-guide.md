# Usage Guide

How to embed Kiln in your own application, load datasets, and use the demo viewer's URL parameters.

See also: [Architecture](architecture.md) | [Rendering Pipeline](rendering.md) | [Data Guide](data-guide.md) | [WebGPU Notes](webgpu.md)

---

## Library API

### Installation

```bash
npm install kiln-render
```

### Basic usage

```typescript
import { KilnViewer } from 'kiln-render';

const canvas = document.querySelector('canvas')!;
const viewer = await KilnViewer.create(canvas, 'https://example.com/scan.ome.zarr');
```

`KilnViewer.create()` handles WebGPU initialisation, data provider setup, and starts the render loop. It accepts a URL string (OME-Zarr or Kiln sharded binary) or a pre-constructed `DataProvider` instance.

### ViewerOptions

Pass an optional third argument to set the initial viewer state:

```typescript
const viewer = await KilnViewer.create(canvas, url, {
  mode: 'dvr',          // 'dvr' | 'mip' | 'iso' | 'lod'
  windowCenter: 0.35,   // 0–1 (16-bit window centre)
  windowWidth: 0.55,    // 0–1 (16-bit window width)
  isoValue: 0.2,        // 0–1 (isosurface threshold)
  renderScale: 0.75,    // 0.25–1.0 (render resolution multiplier)
  maxPixelError: 2.0,   // LOD screen-space error threshold in pixels
  tfPreset: 'grayscale',// transfer function colour preset
  upAxis: '-y',         // camera up axis
  cam: [0.07, 3.63, 3.93, 0.10, 0.00, -0.06], // [rx, ry, dist, tx, ty, tz]
  clipMin: [0, 0, 0],   // axis-aligned clip minimum (normalised 0–1)
  clipMax: [1, 1, 1],   // axis-aligned clip maximum (normalised 0–1)
});
```

### Controlling the viewer

All render parameters are accessible as properties on the viewer:

```typescript
viewer.mode = 'mip';
viewer.windowCenter = 0.4;
viewer.windowWidth = 0.3;
viewer.isoValue = 0.25;
viewer.renderScale = 0.5;

// Direct access to subsystems
viewer.camera;           // Camera
viewer.renderer;         // Renderer
viewer.transferFunction; // TransferFunction
viewer.streamingManager; // StreamingManager
viewer.metadata;         // VolumeMetadata (dimensions, spacing, bitDepth, …)
```

### State serialisation

`getState()` returns a plain object snapshot of the current viewer state, useful for share-URL features:

```typescript
const state = viewer.getState();
// {
//   mode, windowCenter, windowWidth, isoValue, renderScale,
//   tfPreset, upAxis, cam, clipMin, clipMax
// }
```

### Frame hook

```typescript
viewer.onBeforeFrame = () => ui.recordFrame();
```

Called at the start of every RAF tick. Use it to drive FPS counters or frame-rate tracking.

### Cleanup

```typescript
viewer.dispose(); // cancels RAF loop, disconnects ResizeObserver, terminates workers
```

### Local filesystem loading

Load a local `.zarr` or `.ome.zarr` directory using the File System Access API:

```typescript
import {
  KilnViewer,
  LocalZarrDataProvider,
  promptForZarrDirectory,
  preValidateLocalZarr,
} from 'kiln-render';

// Show the native directory picker
const handle = await promptForZarrDirectory();

// Optional: validate before loading
const issues = await preValidateLocalZarr(handle);
if (issues.length > 0) {
  console.error('Unsupported dataset:', issues);
  return;
}

const provider = new LocalZarrDataProvider(handle);
const viewer = await KilnViewer.create(canvas, provider);
```

> **Browser requirement:** The File System Access API is currently only supported in Chrome/Edge. `promptForZarrDirectory()` throws if the API is unavailable.

Previously granted handles can be restored across page loads:

```typescript
import { getStoredHandle, requestPermission } from 'kiln-render';

const handle = await getStoredHandle();
if (handle && await requestPermission(handle)) {
  const viewer = await KilnViewer.create(canvas, new LocalZarrDataProvider(handle));
}
```

### Pre-validating remote datasets

Check a remote URL for compatibility before starting a load:

```typescript
import { preValidateRemoteZarr } from 'kiln-render';

const issues = await preValidateRemoteZarr('https://example.com/scan.ome.zarr');
if (issues.length > 0) {
  // e.g. 'Multi-channel datasets are not supported'
}
```

---

## Demo Viewer — Loading Custom Datasets

Add the `dataset` URL parameter to load your own data:

```
https://mpanknin.github.io/kiln-render/?dataset=YOUR_DATASET_URL
```

**Example:**
```
?dataset=https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/kingsnake.ome.zarr
```

### OME-Zarr

OME-Zarr requires no preprocessing — just point to a URL.

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

The **Share** button (top-right of the demo) copies the current view as a URL with all parameters filled in.

---

## FAQ

### Which browsers are supported?

Kiln requires WebGPU. Chrome/Edge 113+ and Safari 26+ support it out of the box. Firefox ships WebGPU by default in recent versions (141+), though support may be partial on some platforms — check `dom.webgpu.enabled` if needed. Make sure hardware acceleration is enabled in your browser settings.

### How much VRAM does Kiln use?

The atlas is fixed-size — usage is constant regardless of dataset size. See [Architecture](architecture.md) for details.

### What are the known rendering issues?

Brick boundary seams are still visible in some cases, especially in isosurface (ISO) mode where normal estimation samples across brick edges. LOD transitions can also produce brief visual discontinuities while bricks stream in.

### Can I use Kiln in my own application?

Yes. Install `kiln-render` from npm and use `KilnViewer.create()` — see the [Library API](#library-api) section. Kiln is Apache 2.0 licensed.
