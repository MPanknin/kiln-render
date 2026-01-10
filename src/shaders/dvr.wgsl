// Direct Volume Rendering (DVR) - Front-to-back compositing

fn rayMarchDVR(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let maxDim = max(datasetSize.x, max(datasetSize.y, datasetSize.z));
    let invDir = 1.0 / rayDir;

    var color = vec3f(0.0);
    var alpha = 0.0;
    var t = tStart;

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }
        if (alpha > EARLY_EXIT_ALPHA) { break; }

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

            composeSample(density, brick.stepSize, maxDim, &color, &alpha);
            if (alpha > EARLY_EXIT_ALPHA) { break; }

            tSample += brick.stepSize;
        }

        t = brick.tEnd + 0.0001;
    }

    return vec4f(color, alpha);
}
