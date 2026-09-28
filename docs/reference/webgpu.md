# WebGPU Notes

Why Kiln uses WebGPU, how it compares to WebGL for volume rendering, and future GPU optimization opportunities.

## WebGPU vs WebGL for volume rendering

Kiln is built on WebGPU rather than WebGL. This section documents the technical differences relevant to volume rendering.

### 16-bit and float texture support

WebGPU's `r16float` format stores half-precision floats with hardware trilinear filtering, and is a core feature (no extension required). Kiln stores all `uint16`, `int16` and `float32` data in `r16float`: `uint16` values are normalised by 65535 and converted to half precision, while `int16` and `float32` values are stored as raw half-precision values and normalised in the shader.

**Fallback chain**: Kiln detects format support at runtime:
- **r16float** (preferred) — half-precision, filterable, core WebGPU
- **r8unorm** (last resort) — workers downsample 16→8 bit via high-byte extraction (`>> 8`)

The r8unorm fallback triggers a console warning and shows `(⚠️ downsampled)` in the UI.

WebGL lacks native 16-bit single-channel textures. Common workarounds include:
- **Two-channel packing**: Store high/low bytes in separate channels, reconstruct in shader
- **Float textures**: Use `R32F` (wastes memory, requires `OES_texture_float`)
- **Half-float textures**: Use `R16F` (different precision characteristics than integer)

Each workaround adds shader complexity and may affect filtering behavior at brick boundaries.

### Compute shaders

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

Kiln does not yet leverage compute-specific features like shared memory, subgroup operations, or indirect dispatch. The compute choice is an architectural investment in future headroom rather than a current necessity.

### Asynchronous texture updates

WebGPU's `device.queue.writeTexture()` queues texture uploads without blocking the CPU or stalling rendering. Multiple brick uploads can be batched and executed asynchronously.

WebGL's `texSubImage3D()` is synchronous on the CPU timeline. While the GPU may process it asynchronously, the CPU call blocks until the data is transferred to GPU-accessible memory. This can cause frame drops during intensive streaming.

### 3D texture limits

WebGPU allows querying actual device limits via `device.limits.maxTextureDimension3D`. Modern GPUs commonly support 16384³, though this varies by hardware.

WebGL 2 specifies a minimum of 256³ for 3D textures, with most implementations supporting 2048³. Larger atlases may require multiple textures or texture arrays.

### Integer texture formats

The indirection table uses `rgba8uint` format to store slot indices and LOD levels as exact integers. WebGPU provides `textureLoad()` for non-interpolated integer sampling.

WebGL 2 supports integer textures but with more limited format options and requires careful handling to avoid unintended filtering.

### Summary

| Capability | WebGL 2 | WebGPU |
|------------|---------|--------|
| 16-bit / float textures | Emulated | Native `r16float` |
| 3D texture limit | Typically 2048³ | Up to 16384³ |
| Compute shaders | No | Yes (pipeline flexibility, future headroom) |
| Texture uploads | Synchronous | Asynchronous queue |
| Integer textures | Limited | Full support |

These differences don't make WebGL unsuitable for volume rendering—capable WebGL renderers exist. However, WebGPU provides a more direct mapping to the hardware capabilities needed for streaming virtual textures.
