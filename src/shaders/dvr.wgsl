// Direct Volume Rendering (DVR) - Front-to-back compositing with windowing

// Edge strength = 1 - 2^(-EDGE_GAIN * slope), slope in windowed density per
// finest-level voxel: ~0.2 for noise-level slopes, ~0.65 at 0.25, ~1 at sharp boundaries.
const EDGE_GAIN: f32 = 6.0;
// Below this contribution to the pixel a sample keeps its unshaded colour,
// which saves the six gradient reads in near-transparent regions.
const MIN_SHADED_CONTRIBUTION: f32 = 0.002;

fn rayMarchDVR(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let maxDim = max(datasetSize.x, max(datasetSize.y, datasetSize.z));
    let invDir = 1.0 / rayDir;

    let windowCenter = uniforms.windowCenter;
    let windowWidth = uniforms.windowWidth;
    let numCh = uniforms.numChannels;

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

    // precompute float normalisation — shared by single- and multi-channel
    // paths (identity for uint data where floatMin=0, floatMax=1)
    let floatInvRange = 1.0 / max(uniforms.floatMax - uniforms.floatMin, 0.0001);

    // Gradient shading and boundary emphasis (single channel only for now)
    let shading = uniforms.shading;
    let gradientOpacity = uniforms.gradientOpacity;
    let useGradient = shading > 0.0 || gradientOpacity > 0.0;
    // raw texel slope → windowed-density slope, scaled for the edge curve
    let edgeGain = EDGE_GAIN * floatInvRange / max(windowWidth, 0.001);
    // voxel axes → world axes, so normals stay right on anisotropic voxels
    let voxelsPerUnit = datasetSize / normalizedSize;
    let lightDir = -rayDir;

    // compute jitter fraction once for the whole ray
    // select() is not short-circuiting in WGSL — rand() would run even with jitter off.
    var jitterFrac = 0.0;
    if (uniforms.jitter != 0u) {
        jitterFrac = rayJitter();
    }

    var color = vec3f(0.0);
    var alpha = 0.0;
    var t = tStart;
    var tSample = -1.0;  // sentinel: not yet initialized
    var lm: LabelMarch;
    let labelCount = labelParams.layerCount;

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }
        if (alpha > EARLY_EXIT_ALPHA) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);
        if (labelCount > 0u) { labelMarchBrick(&lm, brick.valid, brick.indirection); }

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

            // Label surfaces starting here lie in front of this sample
            var tint = vec4f(0.0);
            if (labelCount > 0u) {
                let surface = labelMarchSample(&lm, voxel, rayDir * brick.stepSize * voxelsPerUnit, brick.cell, voxelsPerUnit, lightDir, true, false);
                color += surface.rgb * (1.0 - alpha);
                alpha += surface.a * (1.0 - alpha);
                tint = lm.tint;
            }

            if (numCh > 1u) {
                // Multi-channel: per-channel windowing + additive composite
                var weightedColor = vec3f(0.0);
                var maxDensity = 0.0;
                for (var vi = 0u; vi < numVisible; vi++) {
                    let ch = visibleCh[vi];
                    let chColor = chColorLocal[ch];
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
                if (tint.a > 0.0) {
                    // Tinted: visible samples take the label colour by its opacity, and are at least that opaque
                    let visible = maxDensity > 0.01;
                    let rgb = mix(select(vec3f(0.0), weightedColor / maxDensity, visible), tint.rgb, select(1.0, tint.a, visible));
                    maxDensity = max(select(0.0, maxDensity, visible), tint.a);
                    weightedColor = rgb * maxDensity;
                }
                composeSampleAdditive(weightedColor, maxDensity, extinctionScale, &color, &alpha);
            } else {
                // Single channel: TF-based DVR with windowing and float normalisation
                let rawDensity = sampleAtlasAffine(voxel, brick.atlasOffset, brick.atlasScale);
                let density = clamp((rawDensity - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
                let windowed = applyWindow(density, windowCenter, windowWidth);
                var rgb = vec3f(0.0);
                var opacity = 0.0;
                if (windowed > 0.01) {
                    let tf = textureSampleLevel(tfTexture, tfSampler, vec2f(windowed, 0.5), 0.0);
                    rgb = tf.rgb;
                    opacity = tf.a;
                    // Boundary emphasis can only lower opacity, so with it on every sample
                    // needs a gradient; shading alone skips samples that barely contribute.
                    if (useGradient && (gradientOpacity > 0.0
                        || (1.0 - exp2(-opacity * extinctionScale)) * (1.0 - alpha) > MIN_SHADED_CONTRIBUTION)) {
                        let g = brickGradient(voxel, brick);
                        let edge = 1.0 - exp2(-length(g) * edgeGain);
                        opacity *= mix(1.0, edge, gradientOpacity);
                        if (shading > 0.0 && edge > 0.001) {
                            let n = normalize(g * voxelsPerUnit);
                            rgb = mix(rgb, shadeTwoSided(n, lightDir, rgb), shading * edge);
                        }
                    }
                }
                if (tint.a > 0.0) {
                    // Tinted: the label colour mixes into visible samples and makes the rest visible
                    rgb = mix(rgb, tint.rgb, select(tint.a, 1.0, opacity == 0.0));
                    opacity = max(opacity, tint.a);
                }
                if (opacity > 0.0) {
                    let sampleAlpha = 1.0 - exp2(-opacity * extinctionScale);
                    color += rgb * sampleAlpha * (1.0 - alpha);
                    alpha += sampleAlpha * (1.0 - alpha);
                }
            }

            if (alpha > EARLY_EXIT_ALPHA) { break; }
            tSample += brick.stepSize;
        }

        // scale-sensitive epsilon
        t = brick.tEnd + max(0.0001, brick.tEnd * 1e-6);
    }

    return vec4f(color, alpha);
}
