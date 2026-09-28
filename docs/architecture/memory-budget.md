# Memory budget analysis

For a 1024 × 512 × 1024 volume with 4 LOD levels:

**8-bit volume (`uint8`):**

| Resource | Size | Notes |
|----------|------|-------|
| Atlas texture | 274 MiB | 660³ × 1 byte |
| Indirection table | 128 KiB | 16×8×16 × 4 bytes (LOD 0 grid) |
| Brick indices (CPU) | ~2 MiB | JSON with offsets/stats |
| Volume-residency resources | **~274 MiB** | Atlas + indirection table; bounded by the atlas budget, not volume size. Excludes render targets and other GPU allocations |

**16-bit volume (`uint16`, `int16`, `float32`):**

| Resource | Size | Notes |
|----------|------|-------|
| Atlas texture | 548 MiB | 660³ × 2 bytes |
| Indirection table | 128 KiB | 16×8×16 × 4 bytes (LOD 0 grid) |
| Brick indices (CPU) | ~2 MiB | JSON with offsets/stats |
| Volume-residency resources | **~548 MiB** | Atlas + indirection table; bounded by the atlas budget, not volume size. Excludes render targets and other GPU allocations |

For multichannel datasets, each channel gets its own atlas texture and the grid shrinks to stay within the VRAM budget — see [Multichannel](/rendering/multichannel) for the exact grid sizes.
