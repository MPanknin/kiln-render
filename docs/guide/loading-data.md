# Loading data

How to load remote OME-Zarr, local filesystem directories, and multichannel datasets — both from the library API and the demo viewer.

## Local filesystem loading

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

See the [Data Guide → Local OME-Zarr](/data/local-files) for details and limitations.

## Multichannel

Multichannel OME-Zarr datasets (up to 4 channels) are detected automatically. Per-channel colour, window/level, and visibility can be controlled via the renderer:

```typescript
// Check channel count
const numChannels = viewer.renderer.numChannels; // 1–4

// Set channel colour (RGBA, 0–1)
viewer.renderer.setChannelColor(0, 0.0, 1.0, 0.0);     // channel 0 → green
viewer.renderer.setChannelColor(1, 1.0, 0.0, 0.0, 0.5); // channel 1 → red, half intensity

// Set channel window/level (normalised 0–1)
viewer.renderer.setChannelWindow(0, 0.3, 0.4); // centre=0.3, width=0.4

// React to auto-leveling from OMERO metadata
viewer.onChannelWindowsChanged = () => {
  // Update your UI with new window values
};
```

See the [Multichannel documentation](/rendering/multichannel) for compositing details, the multichannel demo, and known limitations.

## Pre-validating remote datasets

Check a remote URL for compatibility before starting a load:

```typescript
import { preValidateRemoteZarr } from 'kiln-render';

const issues = await preValidateRemoteZarr('https://example.com/scan.ome.zarr');
if (issues.length > 0) {
  // e.g. unsupported dtype, missing multiscales metadata, etc.
}
```

## Demo viewer — loading custom datasets

Add the `dataset` URL parameter to load your own data:

```
https://kilnrender.com/app/?dataset=YOUR_DATASET_URL
```

**Example:**
```
?dataset=https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/kingsnake.ome.zarr
```

### OME-Zarr

Compatible multiscale OME-Zarr datasets require no Kiln-specific conversion — just point to a URL.

**Supported formats:**
- OME-NGFF v0.4 and v0.5
- Single-channel and multichannel datasets (up to 4 channels — see [Multichannel](/rendering/multichannel))
- `uint8`, `uint16`, `int16` and `float32` input (`float64` is read as `float32`); everything except `uint8` is stored as `r16float` on the GPU

See the [Data Guide](/data/ome-zarr) for full format requirements.

### Local datasets (File System Access API)

Load local Zarr datasets directly from your filesystem using the "Load Local" button.

> **Browser requirement:** Local dataset loading requires the File System Access API, which is currently **only supported in Chrome/Edge**. Safari and Firefox do not support this feature.

**How it works:**
1. Click "Load Local" button
2. Select a `.zarr` or `.ome.zarr` directory
3. Grant read permission when prompted
4. Dataset loads with auto-leveling based on OMERO metadata (if available)

**Note:** When you load a local dataset, all URL parameters are cleared to ensure the new dataset loads with fresh defaults.
