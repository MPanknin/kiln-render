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

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        if (!brick.valid) {
            t = brick.tEnd + 0.0001;
            continue;
        }

        let jitter = rand(rayToSeed(rayDir) + brickIter) * brick.stepSize;
        var tSample = t + jitter;

        for (var i = 0u; i < brick.numSteps; i++) {
            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
            let density = sampleAtlas(voxel, brick.indirection, brick.lodScale);

            maxDensity = max(maxDensity, density);
            tSample += brick.stepSize;
        }

        t = brick.tEnd + 0.0001;
    }

    // Apply windowing to final max density before TF lookup
    let windowedDensity = applyWindow(maxDensity, windowCenter, windowWidth);
    let tfColor = textureSampleLevel(tfTexture, tfSampler, windowedDensity, 0.0);
    return vec4f(tfColor.rgb * windowedDensity, 1.0);
}
