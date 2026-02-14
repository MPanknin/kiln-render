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

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        if (!brick.valid) {
            t = brick.tEnd + 0.0001;
            prevDensity = 0.0;  // Reset at brick boundary
            continue;
        }

        let jitter = rand(rayToSeed(rayDir) + brickIter + uniforms.frameIndex) * brick.stepSize;
        var tSample = t + jitter;

        for (var i = 0u; i < brick.numSteps; i++) {
            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
            let rawDensity = sampleAtlas(voxel, brick.indirection, brick.lodScale);
            // Apply windowing to density for isosurface comparison
            let density = applyWindow(rawDensity, windowCenter, windowWidth);

            // Check for isosurface crossing (isoValue is in windowed space)
            if (prevDensity < isoValue && density >= isoValue) {
                let tSurface = refineIsoSurfaceWindowed(
                    rayOrigin, rayDir, prevT, tSample, isoValue,
                    normalizedSize, datasetSize, brick.indirection, brick.lodScale,
                    windowCenter, windowWidth
                );
                let surfacePos = rayOrigin + rayDir * tSurface;
                let surfaceVoxel = normalizedToVoxel(surfacePos, normalizedSize, datasetSize);
                let gradient = computeGradient(surfaceVoxel, brick.indirection, brick.lodScale);

                if (length(gradient) >= 0.001) {
                    let normal = -normalize(gradient);
                    let tfColor = textureSampleLevel(tfTexture, tfSampler, isoValue, 0.0);
                    return vec4f(phongLighting(normal, -rayDir, tfColor.rgb), 1.0);
                }
            }

            prevDensity = density;
            prevT = tSample;
            tSample += brick.stepSize;
        }

        t = brick.tEnd + 0.0001;
    }

    // No isosurface found
    return vec4f(0.0, 0.0, 0.0, 0.0);
}
