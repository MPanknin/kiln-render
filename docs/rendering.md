# Rendering Pipeline

Kiln's compute shader raymarching pipeline, compositing modes, and post-processing.

See also: [Architecture](architecture.md) | [WebGPU Notes](webgpu.md) | [Data Guide](data-guide.md)

## Raymarching Overview

Kiln implements a **compute shader** raymarcher (`src/shaders/`) that generates one thread per pixel. The core loop is functionally equivalent to fragment shader raymarching — the compute pipeline was chosen for cleaner post-processing chaining (temporal accumulation) and future optimization headroom (see [Design Decisions](architecture.md#9-compute-shader-raymarching)).

```wgsl
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    // 1. Generate ray from pixel coordinates
    let ndc = pixelToNDC(globalId.xy, screenSize);
    let ray = generateRay(ndc, inverseViewProj, cameraPos);

    // 2. Intersect volume bounding box
    let hit = intersectBox(ray, volumeAABB);
    if (hit.tNear > hit.tFar) { return; }  // Miss

    // 3. Brick-aware raymarching
    var t = hit.tNear;
    var color = vec3f(0.0);
    var alpha = 0.0;

    for (var iter = 0u; iter < MAX_BRICK_TRAVERSALS; iter++) {
        let brick = setupBrick(ray, t);

        if (!brick.valid) {
            t = brick.tEnd;  // Skip unloaded/empty region
            continue;
        }

        // March through this brick
        for (var i = 0u; i < brick.numSteps; i++) {
            let sample = sampleAtlas(ray, t, brick.indirection);
            composeSample(sample, &color, &alpha);

            if (alpha > 0.95) { break; }  // Early ray termination
            t += brick.stepSize;
        }

        t = brick.tEnd;
    }

    textureStore(output, globalId.xy, vec4f(color, alpha));
}
```

---

## Brick Traversal

For each ray segment, the shader:

1. **Computes brick index**: `floor(voxelPos / LOGICAL_BRICK_SIZE)`
2. **Looks up indirection**: `textureLoad(indirectionTexture, brickIndex)`
3. **Calculates brick exit**: Ray-box intersection with brick AABB
4. **Samples within brick**: Steps through at adaptive rate based on LOD

```wgsl
fn setupBrick(ray, t) -> BrickInfo {
    let voxelPos = worldToVoxel(ray.origin + ray.dir * t);
    let brickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);

    let indirection = textureLoad(indirectionTexture, brickIndex, 0);

    // w=0: not loaded, w=255: known empty
    info.valid = indirection.w > 0u && indirection.w < 255u;

    if (info.valid) {
        info.lodScale = exp2(f32(indirection.w) - 1.0);
        info.stepSize = computeStepSize(brickSize, lodScale);
    }

    return info;
}
```

---

## Atlas Sampling

The shader transforms logical voxel coordinates to atlas texture coordinates:

```wgsl
fn sampleAtlas(voxelPos: vec3f, indirection: vec4u, lodScale: f32) -> f32 {
    // Position within logical brick [0, 64)
    let posInBrick = (voxelPos % (LOGICAL_BRICK_SIZE * lodScale)) / lodScale;

    // Atlas base from integer slot indices
    let atlasBase = vec3f(indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE;

    // Offset by border (1 voxel), add 0.5 for texel center
    let atlasUV = atlasBase + (posInBrick + BORDER + 0.5) / ATLAS_SIZE;

    return textureSampleLevel(volumeTexture, volumeSampler, atlasUV, 0.0).r;
}
```

The `lodScale` factor handles coarse LOD sampling: a LOD 2 brick covers 256³ logical voxels but only contains 64³ actual samples, so coordinates are divided by 4 before indexing into the brick.

---

## Compositing Modes

| Mode | Algorithm | Use Case |
|------|-----------|----------|
| **DVR** | Front-to-back alpha compositing with transfer function | General visualization |
| **MIP** | Maximum intensity along ray | Angiography, vessel detection |
| **ISO** | First surface at threshold + Phong shading | Surface extraction |
| **LOD** | Color-coded by resolution level | Debug LOD distribution |

DVR compositing uses the optical model with extinction:

```wgsl
fn composeSample(density, stepSize, color, alpha) {
    let tfColor = textureSample(transferFunction, density);
    let extinction = tfColor.a * stepSize * volumeScale;
    let sampleAlpha = 1.0 - exp(-extinction);

    // Front-to-back blending
    *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
    *alpha += sampleAlpha * (1.0 - *alpha);
}
```

---

## Resolution Scaling

The compute shader can render at a reduced resolution to decrease the number of rays cast per frame. A configurable `renderScale` factor (0.25-1.0, default 0.75) multiplies the canvas dimensions to produce a smaller compute output texture. The blit pass then upscales this to the full canvas using bilinear filtering.

```
Canvas: 1920 × 1080
renderScale: 0.75
Compute texture: 1440 × 810  (56% fewer pixels)
Blit: bilinear upscale back to 1920 × 1080
```

The depth texture remains at full resolution for geometry overlays (wireframe, axis). The scaled dimensions are passed into the shader as `screenSize` so that ray generation and thread dispatch use the correct coordinate space.

---

## Temporal Jitter and Accumulation

Raymarching with fixed step offsets produces banding artifacts where iso-surfaces align with sample planes. Kiln addresses this in two stages:

**Stochastic jitter**: Each ray's starting offset is randomized per frame using the frame index as part of the seed:

```wgsl
let jitter = rand(rayToSeed(rayDir) + brickIter + uniforms.frameIndex);
t += jitter * stepSize;
```

This converts structured banding into high-frequency noise that varies every frame.

**Temporal accumulation**: A compute pass blends the current frame with a history buffer using an exponential moving average (EMA). Two ping-pong textures alternate as read and write targets to avoid read-write hazards:

```wgsl
let weight = 1.0 / (frameCount + 1);  // Progressive average
let blended = mix(history, current, weight);
```

On frame 0, `weight = 1.0` shows the raw noisy frame. By frame 10, each pixel averages 11 samples, substantially reducing noise. Accumulation caps at 64 frames to avoid diminishing returns.

The accumulation resets automatically when:
- The camera moves (detected by comparing the view-projection matrix between frames)
- Rendering parameters change (render mode, transfer function, window/level, ISO threshold)

This gives immediate visual feedback during interaction, with progressive refinement when the view is still.
