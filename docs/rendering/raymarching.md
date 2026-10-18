# Raymarching

Kiln implements a **compute shader** raymarcher (`src/shaders/`) that generates one thread per pixel. The core loop is functionally equivalent to fragment shader raymarching — the compute pipeline was chosen for cleaner post-processing chaining (temporal accumulation) and future optimization headroom (see [Compute Shader Raymarching](/architecture/design-decisions#9-compute-shader-raymarching)).

## Overview

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

## Brick traversal

For each ray segment, the shader:

1. **Computes brick index**: `floor(voxelPos / LOGICAL_BRICK_SIZE)`
2. **Looks up indirection**: `textureLoad(indirectionTexture, brickIndex)`
3. **Calculates brick exit**: Ray-box intersection with brick AABB
4. **Samples within brick**: Steps 64 times per brick diagonal, times the brick's coarsest per-axis LOD scale (capped at 4), so coarse bricks take larger steps

```wgsl
fn setupBrick(ray, t) -> BrickInfo {
    let voxelPos = worldToVoxel(ray.origin + ray.dir * t);
    let brickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);

    let indirection = textureLoad(indirectionTexture, brickIndex, 0);

    // w=0: not loaded, w=255: known empty
    info.valid = indirection.w > 0u && indirection.w < 255u;

    if (info.valid) {
        // Per-axis finest voxels per voxel of this level (w = LOD + 1), from a uniform table
        info.lodScale = uniforms.lodScales[indirection.w - 1u].xyz;
        let lodStepMul = min(max(info.lodScale.x, max(info.lodScale.y, info.lodScale.z)), 4.0);
        info.stepSize = (brickWorldSize / STEPS_PER_BRICK) * lodStepMul;
    }

    return info;
}
```

## Atlas sampling

The shader transforms logical voxel coordinates to atlas texture coordinates:

```wgsl
fn sampleAtlas(voxelPos: vec3f, indirection: vec4u, lodScale: vec3f) -> f32 {
    // Position within logical brick [0, 64)
    let posInBrick = (voxelPos % (LOGICAL_BRICK_SIZE * lodScale)) / lodScale;

    // Atlas base from integer slot indices
    let atlasBase = vec3f(indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE;

    // Skip the 1-voxel border. posInBrick already sits on voxel centres
    // (voxel i spans [i, i + 1)), so no extra half-texel offset.
    let atlasUV = atlasBase + (posInBrick + BORDER) / ATLAS_SIZE;

    return textureSampleLevel(volumeTexture, volumeSampler, atlasUV, 0.0).r;
}
```

The `lodScale` factor handles coarse LOD sampling: in a 2:1 pyramid a LOD 2 brick covers 256³ finest-level voxels but only contains 64³ actual samples, so coordinates are divided by 4 before indexing into the brick. Native pyramids that downsample axes differently get a different factor per axis. The hot loop uses the same mapping, precomputed per brick as an affine transform (`atlasOffset + voxelPos * atlasScale`).
