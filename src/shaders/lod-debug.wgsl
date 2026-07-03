// LOD visualization mode - shows which LOD level is being rendered

fn rayMarchLOD(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let maxDim = max(datasetSize.x, max(datasetSize.y, datasetSize.z));
    let invDir = 1.0 / rayDir;

    // compute jitter fraction once for the whole ray
    let jitterFrac = select(0.0, rand(rayToSeed(rayDir) + uniforms.frameIndex), uniforms.jitter != 0u);

    var color = vec3f(0.0);
    var alpha = 0.0;
    var t = tStart;
    var tSample = -1.0;

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }
        if (alpha > EARLY_EXIT_ALPHA) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        if (!brick.valid) {
            // scale-sensitive epsilon
            t = brick.tEnd + max(0.0001, brick.tEnd * 1e-6);
            continue;
        }

        // per-brick extinction scale (no densityScale for LOD debug)
        let extinctionScale = brick.stepSize * maxDim * 0.5 * LOG2E;

        if (tSample < 0.0) {
            tSample = t + jitterFrac * brick.stepSize;
        } else if (tSample < t) {
            let steps = ceil((t - tSample) / brick.stepSize);
            tSample += steps * brick.stepSize;
        }

        for (var i = 0u; i < brick.numSteps; i++) {
            if (tSample > brick.tEnd) { break; }

            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
            let density = sampleAtlasAffine(voxel, brick.atlasOffset, brick.atlasScale);

            // Use LOD color with TF opacity
            let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(density, 0.5), 0.0);
            let lodColor = getLodColor(brick.indirection.w);
            composeSampleWithColor(density, extinctionScale, vec4f(lodColor, tfColor.a), &color, &alpha);

            if (alpha > EARLY_EXIT_ALPHA) { break; }
            tSample += brick.stepSize;
        }

        // scale-sensitive epsilon
        t = brick.tEnd + max(0.0001, brick.tEnd * 1e-6);
    }

    return vec4f(color, alpha);
}
