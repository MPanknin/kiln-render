# Network & formats

## Network streaming

Data providers (`src/data/`) handle fetching brick data. The **ShardedDataProvider** uses **HTTP Range requests** to fetch individual bricks without downloading entire LOD files:

```
GET /datasets/volume/lod0.bin
Range: bytes=1835008-2122503
                │
                ▼
┌─────────────────────────────────────────┐
│ lod0.bin (concatenated brick data)      │
│ ┌─────┬─────┬─────┬─────┬─────┬─────┐  │
│ │  0  │  1  │  2  │  3  │ ... │ N   │  │
│ └─────┴─────┴──▲──┴─────┴─────┴─────┘  │
│                │                        │
│     Byte range for brick 2 only         │
└─────────────────────────────────────────┘
```

The **index file** (`lod0_index.json`) provides byte offsets, sizes, and pre-computed statistics:

```json
{
  "entries": {
    "0/0/0": { "offset": 0, "size": 287496, "min": 0, "max": 45, "avg": 12.3 },
    "1/0/0": { "offset": 287496, "size": 287496, "min": 0, "max": 0, "avg": 0 }
  }
}
```

**Empty brick detection**: Before fetching, the loader checks if `max < threshold`. Bricks with no significant data are marked empty in the indirection table (LOD = 255) without any network request.

Network statistics are tracked in real-time:
- **Throughput**: Rolling 2-second window of bytes/second
- **Total downloaded**: Cumulative bytes since session start
- **Request count**: Total HTTP requests issued

### Brick compression

Bricks are stored with gzip compression to reduce network transfer size. A **DecompressionPool** of Web Workers handles parallel decompression without blocking the main thread:

```
Compressed Brick (HTTP) → Worker Pool → Decompressed Data → GPU Upload
```

Typical compression ratios:
- Dense volumes (CT/MRI): 30-60% of original size
- Sparse volumes (with empty regions): 10-30% of original size

The compression is transparent to the rest of the system—bricks are decompressed before being written to the atlas texture.

### OME-Zarr streaming

The **ZarrDataProvider** (`src/data/zarr-provider.ts`) loads OME-Zarr volumes directly over HTTP using zarrita.js. A pool of Web Workers handles chunk fetching, decompression, and re-chunking into 66³ bricks with ghost borders. Since Zarr chunk boundaries don't align with Kiln's brick grid, workers fetch the overlapping chunks and assemble each brick from the relevant regions.

## Supported data types

Kiln renders `uint8`, `uint16`, `int16` and `float32` volumes (`float64` is read as `float32`):

| Feature | `uint8` | `uint16` | `int16` | `float32` |
|---------|---------|----------|---------|-----------|
| Texture format | `r8unorm` | `r16float` | `r16float` | `r16float` |
| Stored value | value / 255 | value / 65535 | raw value | raw value |
| Normalised by | type range | type range | data range | data range |
| Bytes per voxel (GPU) | 1 | 2 | 2 | 2 |
| Atlas size | ~274 MiB | ~548 MiB | ~548 MiB | ~548 MiB |
| WebGPU feature | (none) | (none) | (none) | (none) |

The **data range** for `int16` and `float32` is the OMERO window's min/max when present, otherwise the 0.1–99.9th percentile of the coarsest level. Half precision holds `int16` values exactly up to ±2048, which covers CT in Hounsfield units.

### Windowing/leveling

Data often uses only part of its range: a 12-bit sensor stored as `uint16`, or soft tissue within a CT. **Windowing** remaps a sub-range to the visible 0-1 output:

```wgsl
fn applyWindow(density: f32, windowCenter: f32, windowWidth: f32) -> f32 {
    let halfWidth = windowWidth * 0.5;
    let minVal = windowCenter - halfWidth;
    return clamp((density - minVal) / windowWidth, 0.0, 1.0);
}
```

For example, a CT soft tissue window might use center=0.5, width=0.1 to expand a narrow intensity band to full contrast.
