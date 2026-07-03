// Maximum Intensity Projection (MIP) rendering with windowing

fn rayMarchMIP(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let invDir = 1.0 / rayDir;

    // Get windowing parameters from uniforms
    let windowCenter = uniforms.windowCenter;
    let windowWidth = uniforms.windowWidth;

    // precompute float normalisation
    let floatInvRange = 1.0 / max(uniforms.floatMax - uniforms.floatMin, 0.0001);

    // compute jitter fraction once for the whole ray
    let jitterFrac = select(0.0, rand(rayToSeed(rayDir) + uniforms.frameIndex), uniforms.jitter != 0u);

    var maxDensity = 0.0;
    var t = tStart;
    var tSample = -1.0;

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        if (!brick.valid) {
            // scale-sensitive epsilon
            t = brick.tEnd + max(0.0001, brick.tEnd * 1e-6);
            continue;
        }

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
            let rawDensity = sampleAtlasAffine(voxel, brick.atlasOffset, brick.atlasScale);
            let density = clamp((rawDensity - uniforms.floatMin) * floatInvRange, 0.0, 1.0);

            maxDensity = max(maxDensity, density);
            tSample += brick.stepSize;
        }

        // scale-sensitive epsilon
        t = brick.tEnd + max(0.0001, brick.tEnd * 1e-6);
    }

    // Apply windowing to final max density before TF lookup
    let windowedDensity = applyWindow(maxDensity, windowCenter, windowWidth);
    let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(windowedDensity, 0.5), 0.0);
    // Premultiplied output: alpha = windowed max density so the compute
    // entry point composites the background correctly. alpha=1.0 made MIP
    // misses/zero-signal rays render pure black instead of bgColor and made
    // the whole image opaque regardless of signal.
    return vec4f(tfColor.rgb * windowedDensity, windowedDensity);
}
