// Isosurface rendering with Phong shading and windowing

fn rayMarchISO(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f, isoValue: f32
) -> vec4f {
    let invDir = 1.0 / rayDir;

    // Get windowing parameters from uniforms
    let windowCenter = uniforms.windowCenter;
    let windowWidth = uniforms.windowWidth;

    var prevDensity = 0.0;
    var prevT = tStart;
    var t = tStart;
    var tSample = -1.0;  // sentinel: not yet initialized
    var rayStepSize = 0.0;

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        if (!brick.valid) {
            t = brick.tEnd + 0.0001;
            if (tSample >= 0.0 && tSample < t) { tSample = t; }
            prevDensity = 0.0;  // Reset across empty space to avoid false crossings
            continue;
        }

        // Apply jitter once for the whole ray on the first valid brick
        if (tSample < 0.0) {
            rayStepSize = brick.stepSize;
            tSample = t + rand(rayToSeed(rayDir) + uniforms.frameIndex) * rayStepSize;
        }

        for (var i = 0u; i < brick.numSteps; i++) {
            if (tSample > brick.tEnd) { break; }

            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
            let rawDensity = sampleAtlas(voxel, brick.indirection, brick.lodScale);
            // Normalize from raw float range to [0, 1] (no-op for uint data where floatMin=0, floatMax=1)
            let normalizedDensity = clamp((rawDensity - uniforms.floatMin) / max(uniforms.floatMax - uniforms.floatMin, 0.0001), 0.0, 1.0);
            // Apply windowing to density for isosurface comparison
            let density = applyWindow(normalizedDensity, windowCenter, windowWidth);

            // Check for isosurface crossing (isoValue is in windowed space)
            if (prevDensity < isoValue && density >= isoValue) {
                let tSurface = refineIsoSurfaceWindowed(
                    rayOrigin, rayDir, prevT, tSample, isoValue,
                    normalizedSize, datasetSize,
                    windowCenter, windowWidth
                );
                let surfacePos = rayOrigin + rayDir * tSurface;
                let surfaceVoxel = normalizedToVoxel(surfacePos, normalizedSize, datasetSize);
                // Look up the indirection for the actual surface brick, which may differ
                // from the current brick when the crossing straddles a brick boundary
                let surfaceBrickIdx = floor(surfaceVoxel / LOGICAL_BRICK_SIZE);
                let surfaceIndirection = lookupIndirection(surfaceBrickIdx);
                let surfaceLodScale = getLodScale(surfaceIndirection);
                let gradient = computeGradient(surfaceVoxel, surfaceIndirection, surfaceLodScale);

                if (length(gradient) >= 0.001) {
                    let normal = -normalize(gradient);
                    let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(isoValue, 0.5), 0.0);
                    return vec4f(phongLighting(normal, -rayDir, tfColor.rgb), 1.0);
                }
            }

            prevDensity = density;
            prevT = tSample;
            tSample += rayStepSize;
        }

        t = brick.tEnd + 0.0001;
    }

    // No isosurface found
    return vec4f(0.0, 0.0, 0.0, 0.0);
}
