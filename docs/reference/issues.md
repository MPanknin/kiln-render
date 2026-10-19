# Known issues

## Rendering

- **LOD transitions:** when finer bricks arrive, their region switches resolution, briefly visible until the neighbours catch up.
- **Banding while refining:** accumulation restarts as bricks are committed, so during heavy refinement the image averages only a few jittered frames and can show stripes ("woodgrain"). It clears once streaming settles.
- **ISO seams at LOD boundaries:** isosurface normal taps can reach into a neighbouring brick at a different LOD, which can leave the boundary faintly visible. DVR gradients stay inside the ghost border.
- **Multichannel:** no ISO, no transfer function, no DVR shading ([limitations](/rendering/multichannel#known-limitations)).

## Streaming

- **OME-Zarr empty bricks are downloaded once:** without an index of brick statistics, a brick is recognised as empty only after its first load.
- **Fixed empty threshold:** a brick counts as empty below 1 (8-bit) or 100 of 65535 (16-bit), lowered to the lowest window start if there is one. It isn't derived from the data, so a noisy fluorescence background above it still streams.
- **Time series:** one timepoint at a time, no playback or prefetching.

## Local files

- **Sharded Zarr v3 can't be read from disk:** the local file store doesn't support partial reads yet. Serve such datasets over HTTP ([Local files](/data/local-files)).
