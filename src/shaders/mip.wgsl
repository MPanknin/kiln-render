// Maximum Intensity Projection (MIP) rendering with windowing

fn rayMarchMIP(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let invDir = 1.0 / rayDir;

    // Get windowing parameters from uniforms
    let windowCenter = uniforms.windowCenter;
    let windowWidth = uniforms.windowWidth;

    var maxDensity = 0.0;
    var t = tStart;
    var tSample = -1.0;
    var rayStepSize = 0.0;

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        if (!brick.valid) {
            t = brick.tEnd + 0.0001;
            if (tSample >= 0.0 && tSample < t) { tSample = t; }
            continue;
        }

        if (tSample < 0.0) {
            rayStepSize = brick.stepSize;
            tSample = t + rand(rayToSeed(rayDir) + uniforms.frameIndex) * rayStepSize;
        }

        for (var i = 0u; i < brick.numSteps; i++) {
            if (tSample > brick.tEnd) { break; }

            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
            let rawDensity = sampleAtlas(voxel, brick.indirection, brick.lodScale);
            let density = clamp((rawDensity - uniforms.floatMin) / max(uniforms.floatMax - uniforms.floatMin, 0.0001), 0.0, 1.0);

            maxDensity = max(maxDensity, density);
            tSample += rayStepSize;
        }

        t = brick.tEnd + 0.0001;
    }

    // Apply windowing to final max density before TF lookup
    let windowedDensity = applyWindow(maxDensity, windowCenter, windowWidth);
    let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(windowedDensity, 0.5), 0.0);
    return vec4f(tfColor.rgb * windowedDensity, 1.0);
}
