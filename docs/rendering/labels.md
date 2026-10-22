# Labels

Kiln draws OME-Zarr label images, such as segmentations, over the volume in every render mode.

## Requirements

- A multiscale image of integer IDs, 0 = background: one listed in the image's `labels` group (`<image>/labels/<name>`, NGFF v0.4 or v0.5), or any other OME-Zarr URL
- The image's dimensions at the finest level. Coarser levels are labelled where their dimensions match too
- Any integer type (floats are rounded). IDs above 65535 wrap into 1–65535, so very large IDs can share a colour
- Colours from `image-label` metadata; every other ID gets a generated colour, neighbouring IDs clearly apart
- Time-varying labels follow the image's timepoint. Remote and local datasets both work

## Display

| Mode | Labels |
|------|--------|
| DVR | Labelled voxels take the label colour, mixed into visible samples by the opacity, and are at least that opaque, so labelled objects show where the transfer function is transparent |
| MIP | The front-most label along the ray, over the projection |
| ISO | The label just inside the surface tints it |
| Slice | The label colour over the slice |

In the viewer, datasets with label images get a **Labels** section in the Controls panel: **Show** picks one (or None), **Opacity** sets how strongly the colours cover the image. `?labels=cells` or `?labels=<url>` and `labelOpacity` set both from the URL.

```typescript
const viewer = await KilnViewer.create(canvas, url, { labels: 'cells', labelOpacity: 0.5 });
viewer.engine.labelNames;                 // e.g. ['cells', 'nuclei']
await viewer.engine.setLabels('nuclei');  // a name, a URL or null; rejects if it doesn't match the image
viewer.renderer.labelOpacity = 0.8;
viewer.renderer.resetAccumulation();
```

## Streaming

Label bricks have the same addresses as image bricks and stream into a second atlas (`r16uint`, the VRAM of one 16-bit channel) laid out slot for slot like the image atlas. When a slot takes a new image brick, its labels are marked stale and the label brick at that address loads; the shader reads a slot's labels (nearest voxel, so IDs never blend) only once they have arrived. Label bricks load from their own small worker pool, at most six at a time.
