# Kiln sharded binary

For raw volume files, use the preprocessing script to convert into Kiln's sharded binary format.

## Quick start

```bash
bun scripts/decompose-volume.ts <input.raw> <W> <H> <D> [options]
```

Example:
```bash
bun scripts/decompose-volume.ts data/chameleon_1024x1024x1080.raw --bits 16
```

## Input format

The script accepts raw binary volume files:

- **8-bit unsigned** (`uint8`) - 1 byte per voxel
- **16-bit unsigned** (`uint16`) - 2 bytes per voxel, little-endian

### 16-bit processing modes

By default, 16-bit volumes are normalized to 8-bit during processing. Use `--native` to keep the data as 16-bit instead (skips normalization):

| Mode | Flag | Output | Use Case |
|------|------|--------|----------|
| Normalized | (default) | 8-bit | Smaller files, wider compatibility |
| Native | `--native` | 16-bit | Higher dynamic range, requires `texture-formats-tier1`. Kiln's WebGPU path stores 16-bit data as `r16float`, which is not bit-exact across the full `uint16` range |

### Filename conventions

The script can parse metadata from filenames:

| Pattern | Example | Parsed As |
|---------|---------|-----------|
| `WxHxD` | `brain_256x256x128.raw` | Dimensions 256×256×128 |
| `_16_` or `uint16` | `scan_16_512x512x174.raw` | 16-bit data |
| `X,YxZ,W` (commas) | `ct_0,83x0,82x3,2.raw` | Voxel spacing 0.83×0.82×3.2 |

## Script usage

```bash
bun scripts/decompose-volume.ts <input.raw> <output-dir> [options]
# OR with dimensions as positional args:
bun scripts/decompose-volume.ts <input.raw> <W> <H> <D> [options]
```

When dimensions are provided as positional args, the output directory defaults to `public/datasets/<input-name>/`.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--dimensions WxHxD` | From filename | Volume dimensions |
| `--spacing X,Y,Z` | `1,1,1` | Voxel spacing |
| `--header N` | `0` | Header bytes to skip |
| `--brick-size N` | `64` | Logical brick size |
| `--max-lod N` | Auto | Maximum LOD levels |
| `--bits N` | `8` | Input bit depth (8 or 16) |
| `--native` | Off | Preserve 16-bit precision (don't normalize to 8-bit) |
| `--output DIR` | Auto | Output directory |

### Examples

```bash
# Parse dimensions from filename
bun scripts/decompose-volume.ts data/chameleon_1024x1024x1080.raw public/datasets/chameleon

# Specify dimensions explicitly
bun scripts/decompose-volume.ts data/scan.raw 512 512 256

# 16-bit normalized to 8-bit (smaller output)
bun scripts/decompose-volume.ts data/mri.raw 256 256 128 \
  --bits 16 --spacing 0.5,0.5,1.0

# 16-bit native (full precision, use windowing in viewer)
bun scripts/decompose-volume.ts data/ct_scan.raw 512 512 400 \
  --bits 16 --native --output public/datasets/ct_16bit

# Skip 2048-byte header (common in some medical formats)
bun scripts/decompose-volume.ts data/dicom.raw 512 512 400 --header 2048
```

## Important: coarsest LOD size

Kiln currently loads the entire coarsest (highest) LOD at startup and keeps it pinned in the atlas. If your dataset's coarsest LOD has a large brick grid (e.g., 8×8×8 = 512 bricks), it will consume over half the default 1,000-slot atlas, limiting space for high-resolution bricks. Keep the coarsest LOD small (ideally ≤4×4×4 grid) by setting appropriate `--max-lod` during preprocessing.

## Output format

The script produces a binary sharded format optimized for HTTP Range request streaming:

```
public/datasets/myvolume/
├── volume.json          # Metadata
├── lod0.bin             # All LOD 0 bricks concatenated
├── lod0_index.json      # Byte offsets and statistics
├── lod1.bin
├── lod1_index.json
├── lod2.bin
└── lod2_index.json
```

### volume.json

Main metadata file:

```json
{
  "name": "myvolume",
  "originalDimensions": [1024, 1024, 1080],
  "voxelSpacing": [1, 1, 1],
  "brickSize": 64,
  "physicalSize": 66,
  "maxLod": 4,
  "levels": [
    {
      "lod": 0,
      "dimensions": [1024, 1024, 1080],
      "bricks": [16, 16, 17],
      "brickCount": 4352,
      "binFile": "lod0.bin",
      "indexFile": "lod0_index.json"
    }
  ],
  "format": "uint8",
  "packed": true,
  "compressed": true
}
```

The `format` field indicates the voxel format: `"uint8"` (8-bit) or `"uint16"` (16-bit native).
The `compressed` field indicates bricks are gzip compressed.

### Index files

Each `lodN_index.json` contains byte offsets and per-brick statistics:

```json
{
  "lod": 0,
  "brickSize": 64,
  "physicalSize": 66,
  "bricks": [16, 16, 17],
  "totalBricks": 4352,
  "totalBytes": 1251041280,
  "entries": {
    "0/0/0": { "offset": 0, "size": 287496, "min": 0, "max": 142, "avg": 12 },
    "1/0/0": { "offset": 287496, "size": 287496, "min": 0, "max": 198, "avg": 45 }
  }
}
```

The per-brick statistics (`min`, `max`, `avg`) enable:
- **Empty brick skipping** - Skip bricks where `max < threshold`
- **Importance-based loading** - Prioritize bricks with higher density variation

## Brick format details

### Physical vs logical size

- **Logical size**: 64³ voxels (default)
- **Physical size**: 66³ voxels (logical + 1-voxel border on each side)

The 1-voxel border enables seamless trilinear interpolation at brick boundaries.

### Memory layout

Bricks are stored in row-major order (X varies fastest):

```
index = x + y * physicalSize + z * physicalSize * physicalSize
```

### LOD generation

Higher LOD levels are created by 2×2×2 box-filter downsampling:
- LOD 0: Full resolution
- LOD 1: Half resolution
- LOD 2: Quarter resolution
- etc.

The number of LOD levels is automatically calculated based on volume size, capped at 11 levels (LOD 0-10).
