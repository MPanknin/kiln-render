# WebGPU Notes

Why Kiln uses WebGPU, how it compares to WebGL for volume rendering, and future GPU optimization opportunities.

See also: [Architecture](architecture.md) | [Rendering Pipeline](rendering.md) | [Data Guide](data-guide.md)

## WebGPU vs WebGL for Volume Rendering

Kiln is built on WebGPU rather than WebGL. This section documents the technical differences relevant to volume rendering.

### Native 16-bit Texture Support

WebGPU provides native `r16unorm` texture format, where 16-bit unsigned integers are stored directly and normalized to `[0,1]` floats during sampling. Hardware trilinear filtering works correctly on the 16-bit values.

WebGL lacks native 16-bit single-channel textures. Common workarounds include:
- **Two-channel packing**: Store high/low bytes in separate channels, reconstruct in shader
- **Float textures**: Use `R32F` (wastes memory, requires `OES_texture_float`)
- **Half-float textures**: Use `R16F` (different precision characteristics than integer)

Each workaround adds shader complexity and may affect filtering behavior at brick boundaries.

### Compute Shaders

WebGPU compute shaders enable per-pixel raymarching with explicit thread dispatch:

```wgsl
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    // One thread per pixel, full control over execution
}
```

WebGL requires rendering a full-screen quad and performing raymarching in a fragment shader. This is functionally equivalent for the core raymarching loop, but compute shaders provide practical benefits for Kiln's pipeline:

- **Direct `textureStore` output**: Write results to storage textures without framebuffer configuration
- **Compute-to-compute chaining**: The temporal accumulation pass reads the raymarcher's output and writes the blended result, all within compute. Fragment shaders would require render pass transitions and intermediate framebuffer management
- **Cleaner resolution scaling**: Dispatch fewer threads (e.g. 1440×810 instead of 1920×1080) rather than managing an intermediate framebuffer and blit-upscale
- **No rasterizer overhead**: No vertex shader, fullscreen triangle, or rasterization stage

Kiln does not yet leverage compute-specific features like shared memory, subgroup operations, or indirect dispatch — see [Future Optimizations](#future-webgpu-native-optimizations) for the roadmap. The compute choice is an architectural investment in future headroom rather than a current necessity.

### Asynchronous Texture Updates

WebGPU's `device.queue.writeTexture()` queues texture uploads without blocking the CPU or stalling rendering. Multiple brick uploads can be batched and executed asynchronously.

WebGL's `texSubImage3D()` is synchronous on the CPU timeline. While the GPU may process it asynchronously, the CPU call blocks until the data is transferred to GPU-accessible memory. This can cause frame drops during intensive streaming.

### 3D Texture Limits

WebGPU allows querying actual device limits via `device.limits.maxTextureDimension3D`. Modern GPUs commonly support 16384³, though this varies by hardware.

WebGL 2 specifies a minimum of 256³ for 3D textures, with most implementations supporting 2048³. Larger atlases may require multiple textures or texture arrays.

### Integer Texture Formats

The indirection table uses `rgba8uint` format to store slot indices and LOD levels as exact integers. WebGPU provides `textureLoad()` for non-interpolated integer sampling.

WebGL 2 supports integer textures but with more limited format options and requires careful handling to avoid unintended filtering.

### Summary

| Capability | WebGL 2 | WebGPU |
|------------|---------|--------|
| 16-bit textures | Emulated | Native `r16unorm` |
| 3D texture limit | Typically 2048³ | Up to 16384³ |
| Compute shaders | No | Yes (pipeline flexibility, future headroom) |
| Texture uploads | Synchronous | Asynchronous queue |
| Integer textures | Limited | Full support |

These differences don't make WebGL unsuitable for volume rendering—capable WebGL renderers exist. However, WebGPU provides a more direct mapping to the hardware capabilities needed for streaming virtual textures.

---

## Future: WebGPU-Native Optimizations

Kiln currently uses WebGPU for compute shaders, async texture uploads, and native 16-bit support. Several additional WebGPU patterns could reduce CPU overhead by moving more work to the GPU.

### GPU-Driven Frustum Culling

**Current approach**: CPU computes desired brick set each frame via octree traversal, frustum culling, and SSE calculation in JavaScript.

**WebGPU-native approach**: Move visibility computation to a compute shader.

```
CPU:                              GPU:
┌──────────────────────┐         ┌─────────────────────────────────┐
│ Upload brick metadata│   →     │ Compute Pass: Cull + LOD Select │
│ (AABBs, LOD info)    │         │ - Test each brick vs frustum    │
│                      │         │ - Compute SSE per brick         │
│                      │         │ - atomicAdd to visible count    │
│                      │         │ - Write visible brick IDs       │
└──────────────────────┘         └─────────────────────────────────┘
```

**Implementation sketch**:
1. Storage buffer with all brick AABBs and metadata (flat array)
2. Compute shader tests each brick against 6 frustum planes
3. Visible bricks written to compacted output buffer via `atomicAdd` for index
4. Indirect dispatch buffer updated with visible count

**Benefits**:
- Eliminates CPU-GPU sync for visibility queries
- Scales better with large brick counts (1000s of bricks)
- Frees main thread for other work

**Complexity**: Medium — frustum math is straightforward in WGSL; atomic compaction is the tricky part.

---

### Indirect Dispatch for Raymarching

**Current approach**: CPU dispatches compute shader with fixed workgroup count based on screen size.

**WebGPU-native approach**: Use `dispatchWorkgroupsIndirect` where the dispatch parameters are written by a prior GPU pass.

```wgsl
// Buffer written by culling pass
struct IndirectDispatch {
    workgroup_count_x: u32,
    workgroup_count_y: u32,
    workgroup_count_z: u32,
}
```

**Use cases**:
- Dispatch only over visible tiles (tile-based culling)
- Variable workload based on GPU-computed brick count
- Chained passes where output of one determines input of next

**Benefits**:
- Zero CPU readback for dispatch sizing
- Enables fully GPU-driven rendering loop

---

### Bindless Textures (Future WebGPU Feature)

**Current approach**: Single 660³ atlas texture with indirection table for virtual addressing.

**True bindless approach**: Each brick as a separate texture, indexed dynamically in shader.

**WebGPU status**: Not yet supported. WebGPU lacks:
- `VK_EXT_descriptor_indexing` equivalent
- Dynamic non-uniform texture array indexing
- Unbounded descriptor arrays

**Why the atlas is still correct for now**:
- Hardware trilinear filtering works across the atlas
- Single bind group (no rebinding overhead)
- Indirection table already provides "virtual bindless" semantics
- Cache-coherent memory layout

**When to revisit**: If WebGPU adds `texture_2d_array` with dynamic indexing or descriptor indexing extensions, individual brick textures could reduce atlas management complexity.

---

### Subgroup Operations

**Current approach**: Each thread operates independently in compute shaders.

**WebGPU-native approach**: Use subgroup operations for efficient reductions and communication.

```wgsl
// Example: early ray termination across subgroup
let anyActive = subgroupAny(alpha < 0.95);
if (!anyActive) { return; }  // Entire subgroup done

// Example: shared brick lookup
let brickData = subgroupBroadcastFirst(loadBrick(leaderThread));
```

**WebGPU status**: Subgroup operations are available via the `subgroups` feature (check adapter capabilities).

**Use cases for Kiln**:
- Ballot operations for coherent ray termination
- Reduction for tile-based statistics
- Broadcast for shared brick metadata loads

**Benefits**:
- Reduced divergence in raymarching
- Faster reductions without shared memory

---

### Timestamp Queries for Profiling

**Current approach**: Performance measured via JavaScript `performance.now()` around render calls.

**WebGPU-native approach**: Use GPU timestamp queries for accurate per-pass timing.

```typescript
const querySet = device.createQuerySet({
    type: 'timestamp',
    count: 4,
});

passEncoder.writeTimestamp(querySet, 0);  // Before culling
// ... culling pass ...
passEncoder.writeTimestamp(querySet, 1);  // After culling
// ... raymarching pass ...
passEncoder.writeTimestamp(querySet, 2);  // After raymarching
```

**Benefits**:
- Accurate GPU timing independent of CPU-GPU sync
- Identify bottlenecks (culling vs raymarching vs compositing)
- Profile on actual hardware without JavaScript overhead

**WebGPU status**: Requires `timestamp-query` feature.

---

### Multi-Draw Indirect (for Hybrid Rasterization)

**Current approach**: Pure compute-based raymarching.

**Alternative**: Hybrid rasterization + raymarching where brick bounding boxes are rasterized first.

```
Pass 1: Rasterize brick AABBs (indirect draw from GPU-culled list)
        → Write brick IDs to per-pixel buffer

Pass 2: Raymarch only within each pixel's assigned bricks
        → Skip empty space traversal
```

**WebGPU support**: `drawIndirect` and `drawIndexedIndirect` are available.

**Benefits**:
- Hardware rasterization for coarse visibility
- Reduced ray setup cost (start at brick entry, not volume entry)
- Better GPU occupancy for sparse volumes

**Tradeoffs**:
- More complex pipeline
- May not benefit dense volumes where most rays hit most bricks

---

### Optimization Roadmap

| Optimization | Complexity | Impact | WebGPU Status |
|--------------|------------|--------|---------------|
| GPU frustum culling | Medium | High for large brick counts | Ready |
| Indirect dispatch | Low | Medium (enables GPU-driven) | Ready |
| Bindless textures | N/A | Blocked | Not in WebGPU spec |
| Subgroup operations | Medium | Medium (reduced divergence) | Feature flag |
| Timestamp queries | Low | Profiling only | Feature flag |
| Multi-draw indirect | High | Situational | Ready |

**Recommended priority**:
1. GPU frustum culling + indirect dispatch (biggest win, medium effort)
2. Timestamp queries (low effort, valuable for optimization)
3. Subgroup operations (if targeting modern hardware)

---

## References

- Virtual Texturing / Megatextures (id Tech 5)
- Sparse Voxel Octrees
- Out-of-core volume rendering (VTK, ParaView)
- NVIDIA IndeX brick-based streaming
- OpenVDS (OSDU)
