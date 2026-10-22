# Quick start

## Installation

```bash
npm install kiln-render
```

An ES module with bundled dependencies and TypeScript types, including `@webgpu/types`.

## Basic usage

```js
import { KilnViewer } from 'kiln-render';

try {
  const viewer = await KilnViewer.create(
    document.querySelector('canvas'),
    'https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr',
  );
} catch (err) {
  console.error(err); // e.g. WebGPU not supported, dataset rejected
}
```

`KilnViewer.create()` sets up WebGPU and streaming and starts the render loop. It takes a URL (OME-Zarr or sharded binary) or a `DataProvider`.

## Options

All optional:

```typescript
const viewer = await KilnViewer.create(canvas, url, {
  mode: 'dvr',                  // 'dvr' | 'mip' | 'iso' | 'lod' | 'slice'
  windowCenter: 0.35,           // 0–1
  windowWidth: 0.55,            // 0–1
  isoValue: 0.2,                // 0–1
  densityScale: 1,              // 0.1–10, DVR opacity scale
  shading: 0,                   // 0–1, DVR gradient shading
  gradientOpacity: 0,           // 0–1, DVR boundary emphasis
  renderScale: 0.5,             // 0.25–1
  maxPixelError: 8,             // LOD screen-space error in pixels; lower = sharper, more bricks
  atlasBudgetBytes: 1_400_000_000, // default; the atlas grid shrinks to fit
  pyramid: 'native',            // or 'legacy'; omit for native with legacy fallback
  tfPreset: 'grayscale',
  tfPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }], // opacity points, override the preset's
  upAxis: '-y',
  cam: [0.07, 3.63, 3.93, 0.10, 0.00, -0.06], // rx, ry, dist, tx, ty, tz
  clipMin: [0, 0, 0],           // 0–1
  clipMax: [1, 1, 1],
  sliceX: 0.5, sliceY: 0.5, sliceZ: 0.5,
  showSliceX: true, showSliceY: true, showSliceZ: true,
  showWireframe: false,
  showAxis: false,
  sourceChannels: [0, 1, 2, 3], // OME-Zarr channels in display order (default: the first four)
  timepoint: 0,
  visibleChannels: [true, true, false, false], // hidden channels aren't streamed until shown
});
```

## Using the viewer

```typescript
viewer.mode = 'mip';                  // render settings are plain properties
viewer.windowCenter = 0.4;

viewer.camera; viewer.renderer; viewer.transferFunction; viewer.streamingManager;
viewer.metadata;                      // dimensions, spacing, bitDepth, …
viewer.milestones;                    // timestamps of each load stage

viewer.getState();                    // serialisable snapshot of the options above, for share links
viewer.onBeforeFrame = () => fps.tick(); // start of every animation frame
viewer.dispose();                     // stops rendering, terminates workers, frees GPU resources
```

## Bring your own device and frame loop

`KilnViewer` wraps `KilnEngine` with a device, canvas, camera and animation loop. Inside an existing WebGPU app, use the engine directly:

```typescript
import { KilnEngine } from 'kiln-render';

const device = await KilnEngine.createDevice(); // or yours, with large buffer and 3D texture limits
const engine = await KilnEngine.create(device, url, { outputFormat: navigator.gpu.getPreferredCanvasFormat() });
engine.setSize(width, height); // device pixels; again on resize

function frame() {
  const view = { position, view: viewMatrix, proj: projMatrix, fovY, width, height }; // your camera; position in volume space
  if (engine.update(view)) engine.render(context.getCurrentTexture().createView(), view);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

`update()` advances streaming and returns `true` when a frame is needed. `engine.dispose()` frees the engine's resources; the device stays yours.

### Several views

One engine can render several views of the dataset, for example the panes of a multi-view layout. They share the atlas and the stream; each has its own camera, render mode and accumulation, and every other display setting follows view 0.

```typescript
const side = engine.addView(); // 1; render it into another canvas configured with the same device
engine.setSize(sideWidth, sideHeight, side);
engine.getRenderer(side).volumeRenderMode = 'mip'; // later changes also call resetAccumulation()

function frame() {
  const [drawMain, drawSide] = engine.updateViews([mainView, sideView]);
  if (drawMain) engine.render(mainContext.getCurrentTexture().createView(), mainView);
  if (drawSide) engine.render(sideContext.getCurrentTexture().createView(), sideView, side);
  requestAnimationFrame(frame);
}
```

`removeView(index)` drops a view; later views move down one index. With `KilnViewer`, `viewer.addPane(canvas)` does the wiring: the pane gets its own camera and `mode` and joins the viewer's render loop.

Use a separate canvas for each pane. `viewer.removePane(pane)` detaches that exact handle; calling it again is harmless, even if the canvas has since been reused for a new pane. Reading or setting a detached pane's `mode` throws, as it does after the viewer is disposed.
