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

    // precompute per-channel windowing constants 
    var chLower: array<f32, 4>;
    var chInvWidth: array<f32, 4>;
    if (numCh > 1u) {
        for (var ch = 0u; ch < numCh; ch++) {
            let ww = max(uniforms.channelWindowWidth[ch], 0.0001);
            chLower[ch] = uniforms.channelWindowCenter[ch] - ww * 0.5;
            chInvWidth[ch] = 1.0 / ww;
        }
    }

    // precompute float normalisation — shared by single- and multi-channel
    // paths (identity for uint data where floatMin=0, floatMax=1)
    let floatInvRange = 1.0 / max(uniforms.floatMax - uniforms.floatMin, 0.0001);

    // compute jitter fraction once for the whole ray
    let jitterFrac = select(0.0, rand(rayToSeed(rayDir) + uniforms.frameIndex), uniforms.jitter != 0u);

    var color = vec3f(0.0);
    var alpha = 0.0;
    var t = tStart;
    var tSample = -1.0;  // sentinel: not yet initialized

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }
        if (alpha > EARLY_EXIT_ALPHA) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        if (!brick.valid) {
            // scale-sensitive epsilon
            t = brick.tEnd + max(0.0001, brick.tEnd * 1e-6);
            continue;
        }

        let extinctionScale = brick.stepSize * uniforms.densityScale * maxDim * 0.5 * LOG2E;

        if (tSample < 0.0) {
            // First valid brick: start the sampling comb with jitter
            tSample = t + jitterFrac * brick.stepSize;
        } else if (tSample < t) {
            // after skipping invalid bricks, advance by whole steps
            // to preserve the jitter phase instead of snapping to t
            let steps = ceil((t - tSample) / brick.stepSize);
            tSample += steps * brick.stepSize;
        }

        for (var i = 0u; i < brick.numSteps; i++) {
            if (tSample > brick.tEnd) { break; }

            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);

            if (numCh > 1u) {
                // Multi-channel: per-channel windowing + additive composite
                var weightedColor = vec3f(0.0);
                var maxDensity = 0.0;
                for (var ch = 0u; ch < numCh; ch++) {
                    let chColor = uniforms.channelColors[ch];
                    // Hidden channels (alpha 0) must contribute NOTHING —
                    // previously they still drove maxDensity (extinction) and
                    // diluted the hue normalisation, so toggling a dense
                    // channel off darkened/blacked out the composite.
                    if (chColor.a <= 0.0) { continue; }
                    let raw = sampleAtlasChAffine(ch, voxel, brick.atlasOffset, brick.atlasScale);
                    // Normalise raw float range to [0,1] BEFORE per-channel
                    // windowing (identity for uint data). Without this,
                    // float32 datasets compared raw values (e.g. 0–3000)
                    // against [0,1]-space windows.
                    let norm = clamp((raw - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
                    let density = clamp((norm - chLower[ch]) * chInvWidth[ch], 0.0, 1.0);
                    weightedColor += density * chColor.rgb * chColor.a;
                    maxDensity = max(maxDensity, density);
                }
                composeSampleAdditive(weightedColor, maxDensity, extinctionScale, &color, &alpha);
            } else {
                // Single channel: TF-based DVR with windowing and float normalisation
                let rawDensity = sampleAtlasAffine(voxel, brick.atlasOffset, brick.atlasScale);
                let density = clamp((rawDensity - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
                composeSampleWindowed(density, extinctionScale, windowCenter, windowWidth, &color, &alpha);
            }

            if (alpha > EARLY_EXIT_ALPHA) { break; }
            tSample += brick.stepSize;
        }

        // scale-sensitive epsilon
        t = brick.tEnd + max(0.0001, brick.tEnd * 1e-6);
    }

    return vec4f(color, alpha);
}
