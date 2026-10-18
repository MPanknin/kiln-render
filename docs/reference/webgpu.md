# WebGPU notes

What Kiln relies on in WebGPU, and how it compares to WebGL 2 for volume rendering.

## 16-bit textures

`uint16` is stored bit-exact as `r16unorm` only when the device accepts it as a **filterable 3D texture**. The optional `texture-formats-tier1` feature alone doesn't guarantee that: an implementation may expose `r16unorm` as `unfilterable-float` only. `KilnEngine.createDevice()` requests the feature when offered, and setup validates a small texture against the shaders' `float` binding inside an error scope before choosing the format.

Fallback chain:

1. **`r16unorm`**: bit-exact; needs `texture-formats-tier1` and passing validation
2. **`r16float`**: core and filterable. Half floats hold every integer in [−2048, 2048], so Kiln stores `value − 2048`: 12-bit data stays exact, higher values get half-float precision. `int16` and `float32` always use this format, as raw values normalised in the shader
3. **`r8unorm`**: last resort; workers keep the high byte. Logs a warning and shows "(⚠️ downsampled)" in the UI

WebGL 2 has `R16F` in core, but `R16` only through `EXT_texture_norm16`, and filterable `R32F` needs `OES_texture_float_linear`.

## Compute shaders

The ray marcher is a compute shader, one thread per pixel. For the core loop this is equivalent to a fragment shader on a fullscreen triangle, but compute keeps the pipeline simple:

- results are written with `textureStore`, no framebuffer setup
- temporal accumulation chains compute to compute, without render-pass transitions
- resolution scaling is a smaller dispatch instead of an intermediate framebuffer and blit
- no vertex stage or rasterizer

Kiln doesn't use shared memory, subgroups or indirect dispatch yet; compute leaves room for them.

## Other differences

| Capability | WebGL 2 | WebGPU |
|------------|---------|--------|
| 16-bit textures | `R16F` core, `R16` via extension | `r16float` core, `r16unorm` via `texture-formats-tier1` |
| 3D texture size | 256³ guaranteed, typically 2048³ | 2048³ guaranteed, more if the adapter allows |
| Compute shaders | no | yes |
| Texture uploads | `texSubImage3D`, synchronous on the CPU timeline | `queue.writeTexture`, queued |
| Integer textures | yes, with fewer formats | yes; `textureLoad` reads them exactly |

Kiln's largest atlas, 660³ per channel, fits the guaranteed 3D size, and `createDevice()` requests the adapter's maximum anyway. Capable WebGL volume renderers exist; WebGPU maps more directly onto what streaming virtual textures need.
