# Known Issues

## Rendering

- **LOD transitions while streaming.** When finer bricks arrive, the region they cover switches resolution, which can show as a brief discontinuity until the neighbouring bricks catch up.
- **Banding while refining.** Temporal accumulation restarts when new bricks are committed, so during heavy refinement the image is built from only a few jittered frames and can show stripes or a woodgrain pattern. It clears once streaming settles and accumulation converges.
- **ISO seams at LOD boundaries.** Isosurface normals are central differences whose taps can cross into a neighbouring brick. When that brick is at a different LOD, the normal changes abruptly and the boundary can be faintly visible. DVR gradients stay inside the brick's ghost border and are not affected.
- **Multichannel:** no ISO mode, no transfer function, and DVR is not shaded yet. See [Multichannel → Known limitations](/rendering/multichannel#known-limitations).

## Streaming

- **OME-Zarr empty bricks are downloaded once.** The sharded binary format stores per-brick statistics, so empty bricks are skipped before any request. OME-Zarr has no such index: a brick is recognised as empty only after it has been assembled, and is skipped from then on.
- **The empty threshold is fixed, not learned.** A brick counts as empty when its maximum is below a threshold set by the data type (1 for 8-bit, 100 of 65535 for 16-bit), lowered to the lowest channel window start when there is one. It is not derived from the data's distribution, so a noisy fluorescence background above that threshold still streams.
- **Time series:** one timepoint is loaded at a time; there is no playback or prefetching.

## Local files

- **Sharded Zarr v3 stores can't be opened from disk.** Reading one chunk out of a shard needs partial reads, which the local file store does not implement yet. Serve such datasets over HTTP instead. See [Local files](/data/local-files).
