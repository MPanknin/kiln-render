# Raymarching

A compute shader marches one ray per pixel (`src/shaders/`). Why compute rather than a fragment shader: see [design decisions](/architecture/design-decisions).

## Main loop

```wgsl
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    let ray = generateRay(pixelToNDC(globalId.xy, screenSize), inverseViewProj, cameraPos);
    let hit = intersectBox(ray, volumeAABB);
    if (hit.tNear > hit.tFar) { return; }

    var t = hit.tNear;
    var color = vec3f(0.0);
    var alpha = 0.0;
    for (var iter = 0u; iter < MAX_BRICK_TRAVERSALS; iter++) {
        let brick = setupBrick(ray, t);
        if (!brick.valid) { t = brick.tEnd; continue; }  // not loaded or empty: skip the brick

        for (var i = 0u; i < brick.numSteps; i++) {
            composeSample(sampleAtlas(ray, t, brick), &color, &alpha);
            if (alpha > 0.95) { break; }                  // early ray termination
            t += brick.stepSize;
        }
        t = brick.tEnd;
    }
    textureStore(output, globalId.xy, vec4f(color, alpha));
}
```

## Brick setup

For each brick a ray enters, the shader looks up its indirection texel, intersects the ray with the brick's box, and picks a step size: 64 steps per brick diagonal, times the brick's coarsest per-axis LOD scale (at most 4).

```wgsl
fn setupBrick(ray, t) -> BrickInfo {
    let brickIndex = floor(worldToVoxel(ray.origin + ray.dir * t) / LOGICAL_BRICK_SIZE);
    let indirection = textureLoad(indirectionTexture, brickIndex, 0);
    info.valid = indirection.w > 0u && indirection.w < 255u;   // 0: not loaded, 255: empty
    if (info.valid) {
        info.lodScale = uniforms.lodScales[indirection.w - 1u].xyz; // finest voxels per voxel, per axis
        let lodStepMul = min(max(info.lodScale.x, max(info.lodScale.y, info.lodScale.z)), 4.0);
        info.stepSize = (brickWorldSize / STEPS_PER_BRICK) * lodStepMul;
    }
    return info;
}
```

## Atlas sampling

```wgsl
fn sampleAtlas(voxelPos: vec3f, indirection: vec4u, lodScale: vec3f) -> f32 {
    let posInBrick = (voxelPos % (LOGICAL_BRICK_SIZE * lodScale)) / lodScale;  // [0, 64)
    let atlasBase = vec3f(indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE;
    // Skip the border voxel. posInBrick is already centred (voxel i spans [i, i + 1)),
    // so there is no extra half-texel offset.
    let atlasUV = atlasBase + (posInBrick + BORDER) / ATLAS_SIZE;
    return textureSampleLevel(volumeTexture, volumeSampler, atlasUV, 0.0).r;
}
```

`lodScale` maps finest-level coordinates into a coarse brick: in a 2:1 pyramid a LOD 2 brick covers 256³ voxels with 64³ samples, so coordinates are divided by 4; native pyramids can use a different factor per axis. The hot loop precomputes the same mapping per brick as `atlasOffset + voxelPos * atlasScale`.
