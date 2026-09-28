# Virtual texturing pipeline

Volumetric data exhibits strong spatial coherence: only a small working set of bricks is visible at any moment. By virtualizing the address space, a large logical volume maps onto a bounded physical cache.

## 1. Brick decomposition

The source volume is pre-processed into a multi-resolution **brick pyramid**:

```
Original Volume: 1024 × 512 × 1024 voxels
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ LOD 0 (1:1)    16×8×16 = 2,048 bricks   64³ logical voxels │
│ LOD 1 (1:2)     8×4×8  =   256 bricks   covers 128³ region │
│ LOD 2 (1:4)     4×2×4  =    32 bricks   covers 256³ region │
│ LOD 3 (1:8)     2×1×2  =     4 bricks   covers 512³ region │
└─────────────────────────────────────────────────────────────┘
```

Each brick is 64³ **logical voxels**, stored as 66³ **physical voxels** with a 1-voxel border for correct trilinear interpolation at brick boundaries. Bricks are serialized into per-LOD binary files with a JSON index containing byte offsets and statistics (min/max/avg intensity).

## 2. Indirection table

The **indirection table** is a 3D texture (`rgba8uint`) dimensioned to the LOD 0 brick grid. Each texel encodes:

| Channel | Purpose                                           |
|---------|---------------------------------------------------|
| R       | Atlas slot X coordinate (0-9 at full grid)        |
| G       | Atlas slot Y coordinate (0-9 at full grid)        |
| B       | Atlas slot Z coordinate (0-9 at full grid)        |
| A       | LOD level + 1 (0=unloaded, 1-4=LOD 0-3, 255=empty)|

When a coarse LOD brick is loaded, it fills **multiple cells** in the indirection table proportional to its coverage. A LOD 2 brick covers a 4×4×4 region in the LOD 0 grid, so 64 cells are updated with the same atlas coordinates. This enables seamless LOD transitions without shader-side LOD selection logic.

```
Indirection Table (LOD 0 grid)              Atlas Texture
┌───┬───┬───┬───┬───┬───┬───┬───┐          ┌─────────────────┐
│2,1│2,1│3,0│3,0│   │   │   │   │          │ Slot (2,1,0)    │
│,0 │,0 │,1 │,1 │...│...│...│...│    ───►  │ Contains LOD 1  │
├───┼───┼───┼───┼───┼───┼───┼───┤          │ brick data      │
│2,1│2,1│3,0│3,0│   │   │   │   │          └─────────────────┘
│,0 │,0 │,1 │,1 │...│...│...│...│
└───┴───┴───┴───┴───┴───┴───┴───┘
  ▲
  └── 2×2 region filled by single LOD 1 brick
```

When a finer LOD brick loads, it **overwrites** only its specific cell, leaving coarser LOD data in adjacent cells. The shader always reads the cell corresponding to the current sample position, automatically getting the finest available resolution.

## 3. Atlas texture

The **atlas** is a single 3D texture organized as a grid of 66³ slots. Its size adapts to fit a VRAM budget — up to `660³` (a 10×10×10 grid), shrinking for multichannel datasets (see below). The texture format depends on the source data:
- **`uint8`**: `r8unorm` (1 byte per voxel)
- **`uint16`**: `r16float` (2 bytes per voxel) — value / 65535, converted to half precision on ingest
- **`int16` and `float32`**: `r16float` (2 bytes per voxel) — raw values in half precision; the shader normalises them by the data range
- **Fallback**: if `r16float` is unsupported, the atlas drops to `r8unorm` (16→8-bit, quality loss)

> **Note:** The maximum atlas grid (`660³`, 1,000 slots) is defined in `src/core/config.ts`. The actual size is chosen at startup by `computeAtlasGrid()` to fit a VRAM budget — `numChannels × atlasSize³ × bytesPerVoxel` stays under the budget (default ~1.3 GiB, overridable via `ViewerOptions.atlasBudgetBytes`). Single- and dual-channel datasets keep the full `660³`.

```
Atlas Layout (660³ total)
┌──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│ 0,0,0│ 1,0,0│ 2,0,0│ 3,0,0│ 4,0,0│ 5,0,0│ 6,0,0│ 7,0,0│ 8,0,0│ 9,0,0│  ← Z=0 layer
├──────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│ 0,1,0│ 1,1,0│ ...  │      │      │      │      │      │      │      │
├──────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│      │      │      │      │      │      │      │      │      │      │
   ...           1,000 total slots (10×10×10)          ...
```

Each slot stores 66³ voxels. At the full `660³` grid (1,000 slots):
- **8-bit**: 287,496 bytes per slot × 1,000 slots = **~274 MiB** VRAM
- **16-bit**: 574,992 bytes per slot × 1,000 slots = **~548 MiB** VRAM

### Multichannel atlas

For multichannel datasets (up to 4 channels), each channel gets its own atlas texture, so VRAM scales with channel count. To stay within budget the atlas grid shrinks as channels increase — e.g. a 4-channel 16-bit dataset uses an ~528³ grid (~1.2 GiB total) instead of the full 660³ (~2.2 GiB). The indirection table is shared across all channels — all channels of a given brick use the same atlas slot indices. See [Multichannel](/rendering/multichannel) for details.

The 1-voxel **ghost border** duplicates neighboring brick data to enable hardware trilinear filtering without seams:

```
Physical Brick (66³)
┌─────────────────────────────────────────┐
│ G │                                 │ G │  G = Ghost voxels (duplicated from neighbors)
├───┼─────────────────────────────────┼───┤
│   │                                 │   │
│ G │      Logical Data (64³)         │ G │
│   │                                 │   │
├───┼─────────────────────────────────┼───┤
│ G │                                 │ G │
└─────────────────────────────────────────┘
```
