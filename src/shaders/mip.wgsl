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

    // precompute per-channel windowing constants, a local copy of the channel
    // colors, and a compacted list of visible channels (alpha > 0) — hidden
    // channels then cost nothing in the per-sample loop below instead of a
    // dynamically-indexed uniform read + branch per channel per sample.
    var chLower: array<f32, 4>;
    var chInvWidth: array<f32, 4>;
    var chColorLocal: array<vec4f, 4>;
    var visibleCh: array<u32, 4>;
    var numVisible = 0u;
    if (numCh > 1u) {
        for (var ch = 0u; ch < numCh; ch++) {
            let ww = max(uniforms.channelWindowWidth[ch], 0.0001);
            chLower[ch] = uniforms.channelWindowCenter[ch] - ww * 0.5;
            chInvWidth[ch] = 1.0 / ww;
            let c = uniforms.channelColors[ch];
            chColorLocal[ch] = c;
            if (c.a > 0.0) {
                visibleCh[numVisible] = ch;
                numVisible++;
            }
        }
    }

    // precompute float normalisation
    let floatInvRange = 1.0 / max(uniforms.floatMax - uniforms.floatMin, 0.0001);

    // compute jitter fraction once for the whole ray
    // select() is not short-circuiting in WGSL — rand() would run even with jitter off.
    var jitterFrac = 0.0;
    if (uniforms.jitter != 0u) {
        jitterFrac = rand(raySeed + uniforms.frameIndex);
    }

    // Single-channel: scalar max. Multi-channel: per-channel max densities.
    var maxDensity = 0.0;
    var chMaxDensity: array<f32, 4>;
    var t = tStart;
    var tSample = -1.0;

    // Label surfaces, composited front to back and drawn over the projection
    var lm: LabelMarch;
    let labelCount = labelParams.layerCount;
    var labels = vec4f(0.0);
    let voxelsPerUnit = datasetSize / normalizedSize;

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);
        if (labelCount > 0u) { labelMarchBrick(&lm, brick.valid, brick.indirection); }

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

            if (labelCount > 0u && labels.a < EARLY_EXIT_ALPHA) {
                let surface = labelMarchSample(&lm, voxel, rayDir * brick.stepSize * voxelsPerUnit, brick.cell, voxelsPerUnit, -rayDir, true, true);
                labels += surface * (1.0 - labels.a);
            }

            if (numCh > 1u) {
                for (var vi = 0u; vi < numVisible; vi++) {
                    let ch = visibleCh[vi];
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
        for (var vi = 0u; vi < numVisible; vi++) {
            let ch = visibleCh[vi];
            let chColor = chColorLocal[ch];
            rgb += chMaxDensity[ch] * chColor.rgb * chColor.a;
            peak = max(peak, chMaxDensity[ch]);
        }
        if (peak > 0.0) { rgb /= peak; }
        return labelsOver(labels, vec4f(rgb * peak, peak));
    }

    // Single-channel: windowed TF lookup
    let windowedDensity = applyWindow(maxDensity, windowCenter, windowWidth);
    let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(windowedDensity, 0.5), 0.0);
    // Premultiplied output: alpha = windowed max density so the compute
    // entry point composites the background correctly.
    return labelsOver(labels, vec4f(tfColor.rgb * windowedDensity, windowedDensity));
}

// Premultiplied labels over a premultiplied projection
fn labelsOver(labels: vec4f, image: vec4f) -> vec4f {
    return labels + image * (1.0 - labels.a);
}
