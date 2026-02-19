# Data Guide

Supported formats, data preparation, and hosting for streaming.

See also: [Architecture](architecture.md) | [Rendering Pipeline](rendering.md) | [WebGPU Notes](webgpu.md)

Kiln supports two input formats:

| Format | Preprocessing | Use Case |
|--------|---------------|----------|
| **Kiln sharded binary** | Requires conversion script | Gzip-compressed bricks, HTTP Range streaming |
| **OME-Zarr (NGFF v0.5)** | None (load directly) | Standard scientific imaging format, chunked arrays |

---

## OME-Zarr

Kiln can load [OME-Zarr](https://ngff.openmicroscopy.org/) volumes directly over HTTP with no preprocessing. Point it at a `.ome.zarr` URL and it streams chunk data on demand.

### Requirements

- OME-NGFF v0.5 with `multiscales` metadata in group attributes
- 3D arrays with dimensions ordered `[z, y, x]` (standard C-order)
- Supported dtypes: `uint8`, `int8`, `uint16`, `int16`
- Multiple resolution levels (datasets within `multiscales`) are used as LODs
- Voxel spacing is read from `coordinateTransformations` if present

### Usage

Set the volume source URL to a `.ome.zarr` path. Kiln auto-detects the format:

```typescript
const VOLUME_SOURCE = 'https://example.com/data/scan.ome.zarr';
```

Brick assembly (fetching Zarr chunks, decompressing, and re-chunking into 66³ bricks with ghost borders) runs in a Web Worker pool off the main thread.

### Public OME-Zarr Datasets

The [OME-Zarr Open SciVis Datasets](https://registry.opendata.aws/ome-zarr-open-scivis/) on AWS provide ready-to-use test volumes:

```typescript
const VOLUME_SOURCE = 'https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr';
```

### Axis Convention

Zarr stores dimensions as `[z, y, x]` (C-order, x fastest-varying). Kiln uses `[x, y, z]` in its metadata. Only metadata tuples are swapped; no data transposition is needed since the memory layout is identical.

---

## Kiln Sharded Binary

For raw volume files, use the preprocessing script to convert into Kiln's sharded binary format.

### Quick Start

```bash
npx ts-node scripts/decompose-volume.ts <input.raw> <W> <H> <D> [options]
```

Example:
```bash
npx ts-node scripts/decompose-volume.ts data/chameleon_1024x1024x1080.raw --bits 16
```

### Input Format

The script accepts raw binary volume files:

- **8-bit unsigned** (`uint8`) - 1 byte per voxel
- **16-bit unsigned** (`uint16`) - 2 bytes per voxel, little-endian

#### 16-bit Processing Modes

By default, 16-bit volumes are normalized to 8-bit during processing. Use `--native` to preserve full 16-bit precision:

| Mode | Flag | Output | Use Case |
|------|------|--------|----------|
| Normalized | (default) | 8-bit | Smaller files, wider compatibility |
| Native | `--native` | 16-bit | Full precision, requires `texture-formats-tier1` |

#### Filename Conventions

The script can parse metadata from filenames:

| Pattern | Example | Parsed As |
|---------|---------|-----------|
| `WxHxD` | `brain_256x256x128.raw` | Dimensions 256×256×128 |
| `_16_` or `uint16` | `scan_16_512x512x174.raw` | 16-bit data |
| `X,YxZ,W` (commas) | `ct_0,83x0,82x3,2.raw` | Voxel spacing 0.83×0.82×3.2 |

### Script Usage

```bash
npx ts-node scripts/decompose-volume.ts <input.raw> <output-dir> [options]
# OR with dimensions as positional args:
npx ts-node scripts/decompose-volume.ts <input.raw> <W> <H> <D> [options]
```

When dimensions are provided as positional args, the output directory defaults to `public/datasets/<input-name>/`.

#### Options

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

#### Examples

```bash
# Parse dimensions from filename
npx ts-node scripts/decompose-volume.ts data/chameleon_1024x1024x1080.raw public/datasets/chameleon

# Specify dimensions explicitly
npx ts-node scripts/decompose-volume.ts data/scan.raw 512 512 256

# 16-bit normalized to 8-bit (smaller output)
npx ts-node scripts/decompose-volume.ts data/mri.raw 256 256 128 \
  --bits 16 --spacing 0.5,0.5,1.0

# 16-bit native (full precision, use windowing in viewer)
npx ts-node scripts/decompose-volume.ts data/ct_scan.raw 512 512 400 \
  --bits 16 --native --output public/datasets/ct_16bit

# Skip 2048-byte header (common in some medical formats)
npx ts-node scripts/decompose-volume.ts data/dicom.raw 512 512 400 --header 2048
```

### Output Format

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

#### volume.json

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

#### Index Files

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

### Brick Format Details

#### Physical vs Logical Size

- **Logical size**: 64³ voxels (default)
- **Physical size**: 66³ voxels (logical + 1-voxel border on each side)

The 1-voxel border enables seamless trilinear interpolation at brick boundaries.

#### Memory Layout

Bricks are stored in row-major order (X varies fastest):

```
index = x + y * physicalSize + z * physicalSize * physicalSize
```

#### LOD Generation

Higher LOD levels are created by 2×2×2 box-filter downsampling:
- LOD 0: Full resolution
- LOD 1: Half resolution
- LOD 2: Quarter resolution
- etc.

The number of LOD levels is automatically calculated based on volume size, capped at 5 levels.

---

## Hosting for Streaming

Host the output directory on any server that supports HTTP Range requests:

### Amazon S3

```bash
aws s3 sync public/datasets/myvolume s3://my-bucket/datasets/myvolume
```

Ensure CORS is configured to allow Range requests from your domain.

### Local Development

Vite's dev server supports Range requests out of the box:

```bash
npm run dev
# Volume available at http://localhost:5173/datasets/myvolume/volume.json
```

### CDN

Most CDNs (CloudFront, Cloudflare, etc.) support Range requests without special configuration.

## Complete Example (Sharded Binary)

Converting the Stag Beetle dataset:

```bash
# Download raw volume
curl -O https://example.com/stagbeetle_832x832x494_uint16.raw

# Convert to streaming format
npx ts-node scripts/decompose-volume.ts \
  stagbeetle_832x832x494_uint16.raw \
  public/datasets/stagbeetle \
  --bits 16

# Upload to S3
aws s3 sync public/datasets/stagbeetle s3://my-bucket/datasets/stagbeetle
```

## Troubleshooting

### "Could not determine dimensions"

Specify dimensions explicitly:

```bash
npx ts-node scripts/decompose-volume.ts data.raw 512 512 256
```

### Large volumes run out of memory

The script processes data in z-slabs to limit memory usage, but very large volumes may still require significant RAM. Ensure at least 8GB of free RAM.

### 16-bit normalization looks wrong

The script uses global min/max for normalization. If the volume has outliers, contrast may be compressed. Options:
1. Pre-process the raw data to adjust the value range
2. Use `--native` to preserve full 16-bit precision and adjust contrast with windowing in the viewer
