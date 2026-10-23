# Labels

Kiln draws OME-Zarr label images, such as segmentations, over the volume: up to 8 layers at once, as shaded surfaces or a tint in 3D, filled and outlined on slices. Label bricks stream with the image bricks, and only bricks that contain more than one ID take GPU memory.

## Requirements

- **A label image:** one listed in the image's `labels` group (`<image>/labels/<name>`, NGFF v0.4 or v0.5), or any other OME-Zarr URL
- **IDs:** any integer type or `bool` (floats are rounded); 0 and negative values are background. IDs stay exact up to 2⁵³; larger `uint64` IDs are approximated
- **Placement:** the label image covers the image. When both have transforms, their physical extents and origins must agree to within a voxel; otherwise the dimensions must be a power of two apart
- **Levels:** any pyramid. Each image level reads the coarsest label level at least as fine as itself, or the finest one when the labels are coarser (single-scale masks and labels at half resolution both work). A level that would read more than 8 label voxels per voxel and axis shows no labels; the layer says so
- **Time:** one timepoint (shown at every image timepoint) or the image's number of timepoints
- **Channels:** a `c` axis is allowed; its first channel is shown
- **Colours and names:** from `image-label` `colors` and `properties` (a `name`, `class`, `label` or `type` property). Other IDs get a generated colour; consecutive IDs differ clearly, and each layer shifts the hues, so two binary masks don't share a colour

## In the viewer

Datasets that can have labels get a **Labels** panel below Controls. `?labels=cells,nuclei` opens layers from the URL; **Share** keeps every setting below.

| Control | Behaviour |
|---------|-----------|
| Add labels | The dataset's label images that aren't open yet, or **From URL…** for any OME-Zarr label image |
| Toggle | Shows the layer. Hidden layers free their GPU memory and stop streaming |
| ⋯ | Opens the layer's settings and segments |
| Opacity | Surfaces and outlines at this opacity, slice fills at half of it |
| 3D | **Surface**: each segment as a shaded surface. **Tint**: the label colour mixed into the image (unshaded, through the volume). **Off**: slices only |
| Slices | **Fill**, **Outline** (voxels next to another label in the slice plane), **Both** or **Off** |
| Colours | **Per segment**, or **One colour** for the whole layer (swatch). In one colour, touching segments form one surface in 3D; slice outlines still separate them |
| Segments | The segments the metadata lists and those in the loaded bricks. Click selects, Shift-click adds or removes, Alt-click hides or shows. **Segment ID** selects any ID |
| ↑ ↓ Remove | Drawing order (the top layer wins where layers overlap) and removal |

Hovering a view shows the segments under the cursor (layer, ID and name), in 3D and on slices. Clicking selects the top segment (Shift: add or remove it); clicking empty space or `Esc` clears the selection. Selected segments are drawn lighter and fully opaque, the others fainter. With a selection, **Hide** (`H`) hides it and **Only these** (`I`) shows nothing else. `L` shows or hides all layers.

## Display

| Mode | Labels |
|------|--------|
| DVR | Surfaces are composited with the volume by depth, so they occlude what lies behind them and are occluded by opaque material in front. Tint colours the samples inside segments and makes them at least as opaque as the layer |
| MIP | Surfaces in front of the projection |
| ISO | Surfaces in front of the isosurface; tint colours the isosurface |
| Slice | Fills and outlines, the top layer last |

Surfaces are smooth rather than voxel cubes: a segment's surface is where the trilinear coverage of its mask reaches 0.35, refined between ray samples, and shaded with the headlight from the gradient of that coverage. A segment the ray passes through without reaching that coverage (thin structures at coarse levels) is still drawn. Segments that touch each other show their shared boundary, and translucent surfaces show the segments behind them.

## API

```typescript
const viewer = await KilnViewer.create(canvas, url, {
  labels: ['cells', { source: 'nuclei', style3d: 'tint', opacity: 0.6 }],
  labelBudgetBytes: 512 * 1024 * 1024, // upper bound of the label pool (default)
});
viewer.labels.available;          // label images in the dataset's labels group, e.g. ['cells', 'nuclei']
viewer.labels.layers;             // open layers in drawing order (opened after create() resolves)

const layer = await viewer.labels.add('https://example.com/scan.zarr/labels/membrane', { color: [255, 200, 0] });
layer.opacity = 0.5;
layer.style3d = 'surface';        // 'surface' | 'tint' | 'off'
layer.slice = 'outline';          // 'fill' | 'outline' | 'both' | 'off'
layer.color = null;               // per-segment colours
layer.setSegmentColor(12, [0, 128, 255]);
layer.select([12, 14]);           // or select(id, 'add' | 'toggle')
layer.isolate = true;             // only the selected segments
layer.setHidden(3, true);
layer.segments;                   // segments listed in the metadata, with names and properties
viewer.labels.loadedSegments(layer); // IDs in the bricks loaded now

const pick = await viewer.pickLabels(canvas, event.clientX, event.clientY);
pick?.hits;                       // [{ layer, id, name, color }], top layer first; pick.voxel is the hit voxel

viewer.labels.move(layer, 0);     // draw on top
viewer.labels.remove(layer);
viewer.getState().labels;         // serialisable layer states
```

`add()` rejects when the label image can't be opened or doesn't fit the image. At most `MAX_LABEL_LAYERS` (8) layers are shown at once: a layer added beyond that starts hidden, and showing one throws. `KilnEngine` has the same `labels` and `pickLabels(x, y, view)`, in output pixels.

## Streaming and memory

Every image atlas slot is labelled, per shown layer, by the label brick at the same address. Label bricks are compressed in workers before they reach the GPU:

| Brick | GPU memory |
|-------|------------|
| Background only | none |
| One ID throughout | none: the slot's entry holds its colour |
| Mixed | one 66³ byte plane of palette indices (two for more than 256 IDs in the brick, three for more than 65536), plus its palette of colours |

Mixed bricks of all layers share one `r8uint` pool texture. It starts empty, grows as bricks need room up to `labelBudgetBytes`, and is freed when no layer is shown. Bricks no slot shows any more stay in the pool until their room is needed. While a slot's brick loads, the slot shows its nearest loaded ancestor, so labels sharpen as the image refines instead of disappearing. When the pool is full of bricks in use, new bricks wait for one to become unused and the slot keeps the coarser labels meanwhile.

Image bricks that are empty, which Kiln normally skips, still load where a shown layer has labels, so labelled regions of a dark image get a slot. Remote label images are read by one pool of 2–4 workers, shared by all layers, with its own chunk cache; local folders are read on the main thread.

Colours are resolved on the CPU into the palettes, so hiding, selecting or recolouring segments rewrites a few kilobytes and never touches the bricks. The **Labels** panel shows the pool's size; the [memory budget](/architecture/memory-budget) lists it with the other allocations.
