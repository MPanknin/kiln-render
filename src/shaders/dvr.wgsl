// Direct Volume Rendering (DVR) - Front-to-back compositing with windowing

fn rayMarchDVR(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let maxDim = max(datasetSize.x, max(datasetSize.y, datasetSize.z));
    let invDir = 1.0 / rayDir;

    let windowCenter = uniforms.windowCenter;
    let windowWidth = uniforms.windowWidth;
    let numCh = uniforms.numChannels;

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

        let jitter = rand(rayToSeed(rayDir) + brickIter + uniforms.frameIndex) * brick.stepSize;
        var tSample = t + jitter;

        for (var i = 0u; i < brick.numSteps; i++) {
            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);

            if (numCh > 1u) {
                // Multi-channel: per-channel windowing + additive composite
                var weightedColor = vec3f(0.0);
                var maxDensity = 0.0;
                for (var ch = 0u; ch < numCh; ch++) {
                    let raw = sampleAtlasCh(ch, voxel, brick.indirection, brick.lodScale);
                    let wc = uniforms.channelWindowCenter[ch];
                    let ww = max(uniforms.channelWindowWidth[ch], 0.0001);
                    let density = clamp((raw - (wc - ww * 0.5)) / ww, 0.0, 1.0);
                    let chColor = uniforms.channelColors[ch];
                    weightedColor += density * chColor.rgb * chColor.a;
                    maxDensity = max(maxDensity, density);
                }
                composeSampleAdditive(weightedColor, maxDensity, brick.stepSize, maxDim, &color, &alpha);
            } else {
                // Single channel: TF-based DVR with windowing
                let density = sampleAtlas(voxel, brick.indirection, brick.lodScale);
                composeSampleWindowed(density, brick.stepSize, maxDim, windowCenter, windowWidth, &color, &alpha);
            }

            if (alpha > EARLY_EXIT_ALPHA) { break; }
            tSample += brick.stepSize;
        }

        t = brick.tEnd + 0.0001;
    }

    return vec4f(color, alpha);
}
