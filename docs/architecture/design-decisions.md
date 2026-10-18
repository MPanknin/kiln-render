# Design decisions

1. **Screen-space error LOD selection.** Refine where a voxel covers more than `maxPixelError` pixels (default 8). One threshold adapts to resolution, field of view and distance.
2. **LRU eviction.** Bricks are touched every frame they are desired; the least recently used one is evicted when the atlas is full, which keeps the current working set.
3. **Differential updates.** Only missing bricks are loaded, so small camera moves cost few requests and uploads.
4. **Empty-brick skipping.** The sharded index's statistics skip empty bricks before any request; OME-Zarr bricks found empty are never requested again. This pays off for CT with air around the object and microscopy with dark background.
5. **Coarse bricks fill many cells.** A coarse brick writes its slot into every indirection cell it covers, and finer bricks overwrite theirs, so the shader always reads the finest loaded data without choosing a LOD itself.
6. **255 = empty.** An explicit empty marker stops coarse data from showing through regions known to be empty at a finer level.
7. **66³ physical bricks.** The one-voxel border lets hardware trilinear filtering work across brick edges with no special cases in the shader.
8. **Pinned base level.** The coarsest level is loaded first and never evicted, so the whole volume is always visible at some resolution.
9. **Compute shader raymarching.** The ray loop is one thread per pixel, equivalent to a fullscreen fragment shader, and uses no compute-only features yet. Compute makes the pipeline simpler: accumulation chains compute to compute, results go out with `textureStore`, and resolution scaling is a smaller dispatch instead of an intermediate framebuffer. It also leaves room for shared memory, subgroups and indirect dispatch. See [WebGPU notes](/reference/webgpu).
