# Virtual texturing

Only a small working set of bricks is visible at any moment, so a large volume can be mapped onto a fixed-size cache.

## 1. Bricks

Every dataset is addressed as a pyramid of bricks: 64³ voxels each, stored as 66³ with a one-voxel border. OME-Zarr brings its own levels, and workers cut each brick from the chunks it overlaps on demand. The [sharded binary format](/data/sharded-binary) is bricked ahead of time.

![The brick pyramid from LOD 0 to LOD 3](../diagrams/brick-pyramid.svg)

The diagram shows a uniform 2:1 pyramid. Native OME-Zarr pyramids can downsample each axis independently (XY only, for example), so a brick has 1 or 2 children per axis.

## 2. Indirection table

A 3D `rgba8uint` texture with one texel per LOD 0 brick:

| Channel | Content |
|---------|---------|
| R, G, B | Atlas slot x, y, z |
| A | LOD + 1; 0 = not loaded, 255 = known empty |

A coarse brick writes its slot into every cell it covers; in a 2:1 pyramid a LOD 2 brick fills 4×4×4 cells. A finer brick then overwrites just its own cells. The shader reads the cell at the sample position and gets the finest loaded data, with no LOD selection of its own.

![Indirection cells pointing into atlas slots](../diagrams/indirection-atlas.svg)

## 3. Atlas

One 3D texture per channel, divided into 66³ slots: up to 660³ (10 × 10 × 10 slots), chosen at startup by `computeAtlasGrid()` so that `channels × size³ × bytes per voxel`, plus a 2-byte label atlas while labels are shown, fits the budget (`atlasBudgetBytes`, default ~1.3 GiB).

![The atlas as a 10 × 10 × 10 grid of 66³ slots](../diagrams/atlas-layout.svg)

| Source | Format | Full 660³ atlas |
|--------|--------|-----------------|
| `uint8` | `r8unorm` | 274 MiB |
| `uint16` | `r16unorm`, bit-exact, where the device [supports it](/reference/webgpu); else `r16float` storing value − 2048, exact up to 4096 | 548 MiB |
| `int16`, `float32` | `r16float`, raw values, normalised by the data range in the shader | 548 MiB |

Without `r16float` the atlas falls back to `r8unorm`, losing precision.

### Multichannel atlas

Each channel has its own atlas; the indirection table is shared, so a brick uses the same slot in every channel. One or two 16-bit channels keep 660³; four get 528³ each (~1.1 GiB in total, instead of ~2.1 GiB at 660³).

## 4. Ghost border

The border duplicates the neighbouring bricks' edge voxels, so hardware trilinear filtering never reads across slots, even though neighbours sit anywhere in the atlas.

![Ghost borders copied between neighbouring bricks](../diagrams/ghost-border.svg)
