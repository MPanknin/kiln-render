# Memory budget

The atlas is sized from the budget (`atlasBudgetBytes`, default ~1.3 GiB), not from the dataset: a 100 MB and a 100 GB volume get the same atlas. For a 1024 × 512 × 1024 volume at the full 660³ atlas:

| Resource | 8-bit | 16-bit | Notes |
|----------|-------|--------|-------|
| Atlas texture | 274 MiB | 548 MiB | 660³ × 1 or 2 bytes, per channel |
| Indirection table | 8 KiB | 8 KiB | 16 × 8 × 16 cells × 4 bytes |
| Brick indices (CPU) | ~0.3 MiB | ~0.3 MiB | JSON, sharded binary only |
| Label pool | 0–512 MiB | 0–512 MiB | Only while [labels](/rendering/labels) are shown: 287 KB per label brick with more than one ID, grows as needed up to `labelBudgetBytes` |

Render targets and other GPU allocations come on top. With more channels the atlas grid shrinks to stay within the budget; see [Multichannel atlas](/architecture/virtual-texturing#multichannel-atlas).
