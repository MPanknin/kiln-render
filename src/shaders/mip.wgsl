// Maximum Intensity Projection (MIP) rendering with windowing

fn rayMarchMIP(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let invDir = 1.0 / rayDir;
    let numCh = uniforms.numChannels;

    // Get windowing parameters from uniforms
    let windowCenter = uniforms.windowCenter;
    let windowWidth = uniforms.windowWidth;

    // precompute per-channel windowing constants (multichannel path)
    var chLower: array<f32, 4>;
    var chInvWidth: array<f32, 4>;
    if (numCh > 1u) {
        for (var ch = 0u; ch < numCh; ch++) {
            let ww = max(uniforms.channelWindowWidth[ch], 0.0001);
            chLower[ch] = uniforms.channelWindowCenter[ch] - ww * 0.5;
            chInvWidth[ch] = 1.0 / ww;
        }
    }

    // precompute float normalisation
    let floatInvRange = 1.0 / max(uniforms.floatMax - uniforms.floatMin, 0.0001);

    // compute jitter fraction once for the whole ray
    let jitterFrac = select(0.0, rand(rayToSeed(rayDir) + uniforms.frameIndex), uniforms.jitter != 0u);

    // Single-channel: scalar max. Multi-channel: per-channel max densities.
    var maxDensity = 0.0;
    var chMaxDensity: array<f32, 4>;
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

            if (numCh > 1u) {
                for (var ch = 0u; ch < numCh; ch++) {
                    let chColor = uniforms.channelColors[ch];
                    if (chColor.a <= 0.0) { continue; }
                    let raw = sampleAtlasChAffine(ch, voxel, brick.atlasOffset, brick.atlasScale);
                    let norm = clamp((raw - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
                    let density = clamp((norm - chLower[ch]) * chInvWidth[ch], 0.0, 1.0);
                    chMaxDensity[ch] = max(chMaxDensity[ch], density);
                }
            } else {
                let rawDensity = sampleAtlasAffine(voxel, brick.atlasOffset, brick.atlasScale);
                let density = clamp((rawDensity - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
                maxDensity = max(maxDensity, density);
            }

            tSample += brick.stepSize;
        }

        // scale-sensitive epsilon
        t = brick.tEnd + max(0.0001, brick.tEnd * 1e-6);
    }

    if (numCh > 1u) {
        // Composite per-channel max densities with channel colors
        var rgb = vec3f(0.0);
        var peak = 0.0;
        for (var ch = 0u; ch < numCh; ch++) {
            let chColor = uniforms.channelColors[ch];
            if (chColor.a <= 0.0) { continue; }
            rgb += chMaxDensity[ch] * chColor.rgb * chColor.a;
            peak = max(peak, chMaxDensity[ch]);
        }
        if (peak > 0.0) { rgb /= peak; }
        return vec4f(rgb * peak, peak);
    }

    // Single-channel: windowed TF lookup
    let windowedDensity = applyWindow(maxDensity, windowCenter, windowWidth);
    let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(windowedDensity, 0.5), 0.0);
    // Premultiplied output: alpha = windowed max density so the compute
    // entry point composites the background correctly.
    return vec4f(tfColor.rgb * windowedDensity, windowedDensity);
}
