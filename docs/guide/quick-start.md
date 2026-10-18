# Quick start

This guide takes you from an empty page to an interactive viewer streaming a remote OME-Zarr dataset. You'll need a WebGPU-capable browser and a dataset URL — a public example is used below.

Most apps need one entry point: `KilnViewer.create()` returns a viewer whose behaviour — render mode, windowing, channels, camera — is driven through plain properties. Apps that already own a WebGPU device, camera and frame loop can use [`KilnEngine`](#bring-your-own-device-and-frame-loop) instead.

## Installation

```bash
npm install kiln-render
```

Kiln ships as an ES module with bundled dependencies and TypeScript types — no peer packages to install. Types for the WebGPU API (`@webgpu/types`) are included automatically.

## Basic usage

```js
import { KilnViewer } from 'kiln-render';

const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');

try {
  const viewer = await KilnViewer.create(
    canvas,
    'https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr',
  );
  status.textContent = `rendering — mode: ${viewer.mode}`;
  window.viewer = viewer;
} catch (err) {
  status.textContent = `failed: ${err.message}`;
  console.error(err);
}
```

`KilnViewer.create()` handles WebGPU initialisation, data provider setup, and starts the render loop. It accepts a URL string (OME-Zarr or Kiln sharded binary) or a pre-constructed `DataProvider` instance.

## ViewerOptions

Pass an optional third argument to set the initial viewer state:

```typescript
const viewer = await KilnViewer.create(canvas, url, {
  mode: 'dvr',          // 'dvr' | 'mip' | 'iso' | 'lod' | 'slice'
  windowCenter: 0.35,   // 0–1 (normalised window centre)
  windowWidth: 0.55,    // 0–1 (normalised window width)
  isoValue: 0.2,        // 0–1 (isosurface threshold)
  densityScale: 1.0,    // 0.1–10 DVR density / opacity scale
  shading: 0.0,         // 0–1 DVR gradient shading (default 0 = flat)
  gradientOpacity: 0,   // 0–1 DVR boundary emphasis (opacity follows gradient magnitude)
  renderScale: 0.5,     // 0.25–1.0 (render resolution multiplier)
  maxPixelError: 8,     // LOD screen-space error threshold in pixels (default 8; lower = sharper, more bricks)
  atlasBudgetBytes: 1_400_000_000, // atlas VRAM budget (default, ~1.3 GiB); the atlas grid shrinks to fit
  pyramid: 'native',    // level model: omit for native with automatic legacy fallback
  tfPreset: 'grayscale',// transfer function colour preset
  tfPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }], // TF opacity control points (overrides preset defaults)
  upAxis: '-y',         // camera up axis
  cam: [0.07, 3.63, 3.93, 0.10, 0.00, -0.06], // [rx, ry, dist, tx, ty, tz]
  clipMin: [0, 0, 0],   // axis-aligned clip minimum (normalised 0–1)
  clipMax: [1, 1, 1],   // axis-aligned clip maximum (normalised 0–1)
  sliceX: 0.5,          // slice plane position on X axis (normalised 0–1)
  sliceY: 0.5,          // slice plane position on Y axis (normalised 0–1)
  sliceZ: 0.5,          // slice plane position on Z axis (normalised 0–1)
  showSliceX: true,     // show/hide the X slice plane
  showSliceY: true,     // show/hide the Y slice plane
  showSliceZ: true,     // show/hide the Z slice plane
  showWireframe: false, // bounding box wireframe overlay
  showAxis: false,      // world-space axis overlay
  visibleChannels: [true, true, false, false], // multichannel: hidden channels are not streamed until shown
  sourceChannels: [0, 1, 2, 3], // OME-Zarr source channels in display order (1–4; default: the first four)
  timepoint: 0,         // OME-Zarr timepoint
});
```

## Controlling the viewer

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
viewer.milestones;       // LoadMilestones: performance.now() timestamps of each load stage
```

## State serialisation

`getState()` returns a plain object snapshot of the current viewer state, useful for share-URL features:

```typescript
const state = viewer.getState();
// {
//   sourceChannels, timepoint,   // OME-Zarr selection, when set
//   mode, windowCenter, windowWidth, densityScale, shading, gradientOpacity,
//   isoValue, renderScale,
//   tfPreset, tfPoints, upAxis, cam, clipMin, clipMax,
//   sliceX, sliceY, sliceZ, showSliceX, showSliceY, showSliceZ,
//   showWireframe, showAxis
// }
```

## Frame hook

```typescript
viewer.onBeforeFrame = () => ui.recordFrame();
```

Called at the start of every RAF tick. Use it to drive FPS counters or frame-rate tracking.

## Cleanup

```typescript
viewer.dispose(); // cancels the RAF loop, disconnects the ResizeObserver, terminates workers, releases GPU resources
```

## Bring your own device and frame loop

`KilnViewer` is a thin host around `KilnEngine`: it creates the device, owns the canvas, camera and `requestAnimationFrame` loop. To render Kiln inside an existing WebGPU app, create the engine on your device and drive it from your own loop:

```typescript
import { KilnEngine } from 'kiln-render';

const device = await KilnEngine.createDevice(); // or your own device, with large buffer and 3D texture limits
const format = navigator.gpu.getPreferredCanvasFormat();
const engine = await KilnEngine.create(device, url, { mode: 'dvr', outputFormat: format });
engine.setSize(width, height); // device pixels; call again on resize

function frame() {
  // Your camera, as ViewParams: position (volume space), view and proj matrices, fovY, width, height.
  const view = { position, view: viewMatrix, proj: projMatrix, fovY, width, height };
  if (engine.update(view)) engine.render(context.getCurrentTexture().createView(), view);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

`update()` advances streaming and returns `true` when a new frame is needed (something changed, or temporal accumulation has not converged). `engine.dispose()` releases the engine's GPU resources; the device stays yours.

Next: [loading data](/guide/loading-data) from remote URLs, local files, and multichannel stores.
