# Memory budget

The atlas is sized from the budget (`atlasBudgetBytes`, default ~1.3 GiB), not from the dataset: a 100 MB and a 100 GB volume get the same atlas. For a 1024 × 512 × 1024 volume at the full 660³ atlas:

| Resource | 8-bit | 16-bit | Notes |
|----------|-------|--------|-------|
| Atlas texture | 274 MiB | 548 MiB | 660³ × 1 or 2 bytes, per channel |
| Indirection table | 8 KiB | 8 KiB | 16 × 8 × 16 cells × 4 bytes |
| Brick indices (CPU) | ~0.3 MiB | ~0.3 MiB | JSON, sharded binary only |
| Label pool | 0–512 MiB | 0–512 MiB | Only while [labels](/rendering/labels) are shown: 574 KB per label brick with more than one ID, grows as needed up to `labelBudgetBytes` |
| Render targets | 24 B/pixel per render scale | same | Output and two accumulation textures (rgba16float) for every render scale a view has used, per view, plus a full-size depth buffer. A 1920 × 1080 view at render scales 1 and 0.25 holds about 58 MiB |

With more channels the atlas grid shrinks to stay within the budget; see [Multichannel atlas](/architecture/virtual-texturing#multichannel-atlas).

CPU-side caches come on top: decompressed bricks for re-upload after atlas eviction (256 MiB per channel) and, for Zarr, decoded chunks in each worker (64–256 MiB per worker, sized to the chunk size).

## Reading the numbers

`KilnEngine.getMemoryStats()` (also on `KilnViewer`) returns what is held now: GPU bytes by atlas, render targets, labels and the rest; both caches with their budgets and hit rates; the JS heap where the browser exposes it; and the pressure counters, that is atlas evictions, refused allocations, brick-cache evictions and label pool growth. A rising count of refused allocations means the atlas budget is too small for the view; a brick-cache hit rate near zero after moving the camera means the cache budget is. The viewers show the same numbers in the stats panel (`?debug=1`, **Memory**), and `?bench=1` records them with their peaks; see [URL parameters](/guide/url-parameters#diagnostics-and-experiments).
