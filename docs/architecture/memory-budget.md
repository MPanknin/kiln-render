# Memory budget analysis

For a 1024 × 512 × 1024 volume with 4 LOD levels, stored in the sharded binary format, at the full `660³` atlas:

**8-bit volume (`uint8`):**

| Resource | Size | Notes |
|----------|------|-------|
| Atlas texture | 274 MiB | 660³ × 1 byte |
| Indirection table | 8 KiB | 16×8×16 × 4 bytes (LOD 0 grid) |
| Brick indices (CPU) | ~2 MiB | JSON with offsets/stats (sharded binary only) |
| Volume-residency resources | **~274 MiB** | Atlas + indirection table; bounded by the atlas budget, not volume size. Excludes render targets and other GPU allocations |

**16-bit volume (`uint16`, `int16`, `float32`):**

| Resource | Size | Notes |
|----------|------|-------|
| Atlas texture | 548 MiB | 660³ × 2 bytes |
| Indirection table | 8 KiB | 16×8×16 × 4 bytes (LOD 0 grid) |
| Brick indices (CPU) | ~2 MiB | JSON with offsets/stats (sharded binary only) |
| Volume-residency resources | **~548 MiB** | Atlas + indirection table; bounded by the atlas budget, not volume size. Excludes render targets and other GPU allocations |

The atlas is sized from the budget (default ~1.3 GiB, `atlasBudgetBytes`), not from the volume: a 10 GB volume and a 100 MB volume get the same atlas. For multichannel datasets, each channel gets its own atlas texture and the grid shrinks to stay within the budget — see [Virtual texturing → Multichannel atlas](/architecture/virtual-texturing#multichannel-atlas).
