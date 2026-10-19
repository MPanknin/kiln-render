# Sharded binary

Kiln's own format for raw volumes: gzip-compressed 66³ bricks, one file per LOD, read brick by brick with HTTP Range requests. Single-channel only; for anything else, use [OME-Zarr](/data/ome-zarr).

## Converting a raw volume

```bash
bun scripts/decompose-volume.ts <input.raw> <output-dir> [options]
bun scripts/decompose-volume.ts <input.raw> <W> <H> <D> [options]   # output: public/datasets/<name>/

bun scripts/decompose-volume.ts data/chameleon_1024x1024x1080.raw public/datasets/chameleon --bits 16
```

Input is raw `uint8` or little-endian `uint16`. The filename can carry metadata:

| Pattern | Example | Parsed as |
|---------|---------|-----------|
| `WxHxD` | `brain_256x256x128.raw` | Dimensions |
| `_16_`, `uint16`, `16bit` | `scan_16_512x512x174.raw` | 16-bit |
| `X,YxZ,W` (decimal commas) | `ct_0,83x0,82x3,2.raw` | Voxel spacing 0.83 × 0.82 × 3.2 |

| Option | Default | Description |
|--------|---------|-------------|
| `--dimensions WxHxD` | from filename | Volume dimensions |
| `--spacing X,Y,Z` | `1,1,1` | Voxel spacing |
| `--header N` | `0` | Header bytes to skip |
| `--bits 8\|16` | from filename, else 8 | Input bit depth |
| `--native` | off | Keep 16-bit data. Without it, 16-bit input is scaled to 8-bit by its global min/max |
| `--max-lod N` | log2(smallest dimension / 64), at most 10 | Coarsest LOD |
| `--brick-size N` | `64` | Keep 64: the viewer's bricks are always 64³ |
| `--output DIR` | | Output directory |

The coarsest LOD is loaded at startup and pinned in the atlas, so keep its brick grid small (4×4×4 or less) with `--max-lod`. An 8×8×8 grid would take half of the 1,000 slots.

## Output

```
public/datasets/myvolume/
├── volume.json          # metadata
├── lod0.bin             # LOD 0 bricks, gzip-compressed, back to back
├── lod0_index.json      # offset, size and statistics per brick
├── lod1.bin
└── lod1_index.json
```

`volume.json`:

```json
{
  "name": "myvolume",
  "originalDimensions": [1024, 1024, 1080],
  "voxelSpacing": [1, 1, 1],
  "brickSize": 64,
  "physicalSize": 66,
  "maxLod": 4,
  "levels": [
    { "lod": 0, "dimensions": [1024, 1024, 1080], "bricks": [16, 16, 17], "brickCount": 4352,
      "binFile": "lod0.bin", "indexFile": "lod0_index.json" }
  ],
  "format": "uint8",
  "packed": true,
  "compressed": true
}
```

`lod0_index.json`: keys are `x/y/z` brick coordinates, bricks are written with x varying fastest, `size` is the compressed size and the statistics cover the 64³ core. A brick whose `max` is below the empty threshold is skipped without a request. `totalBytes` is the size of the `.bin` file.

```json
{
  "lod": 0, "brickSize": 64, "physicalSize": 66, "bricks": [16, 16, 17],
  "totalBricks": 4352, "totalBytes": 1251041280,
  "entries": {
    "0/0/0": { "offset": 0, "size": 61204, "min": 0, "max": 142, "avg": 12 },
    "1/0/0": { "offset": 61204, "size": 143880, "min": 0, "max": 198, "avg": 45 }
  }
}
```

## Brick layout

Each brick is 66³ voxels: the 64³ core plus a one-voxel border copied from its neighbours, so filtering is seamless across bricks. Voxels are stored x fastest, `index = x + y * 66 + z * 66 * 66`. Each LOD halves the previous one with a 2×2×2 average.
