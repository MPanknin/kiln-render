// Ray marching core - brick traversal and integration

// Brick setup information
struct BrickInfo {
    indirection: vec4u,
    lodScale: f32,
    tEnd: f32,
    numSteps: u32,
    stepSize: f32,
    valid: bool,
}

// Set up brick traversal parameters
fn setupBrick(
    rayOrigin: vec3f, rayDir: vec3f, invDir: vec3f, t: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> BrickInfo {
    var info: BrickInfo;

    let samplePos = rayOrigin + rayDir * t;
    let voxelPos = normalizedToVoxel(samplePos, normalizedSize, datasetSize);
    let brickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);

    let brickMinVoxel = brickIndex * LOGICAL_BRICK_SIZE;
    let brickMaxVoxel = brickMinVoxel + LOGICAL_BRICK_SIZE;
    let brickMinWorld = voxelToNormalized(brickMinVoxel, normalizedSize, datasetSize);
    let brickMaxWorld = voxelToNormalized(brickMaxVoxel, normalizedSize, datasetSize);

    let tBrick = intersectBoxInv(rayOrigin, invDir, brickMinWorld, brickMaxWorld);
    info.tEnd = min(tBrick.y, tEnd);

    info.indirection = lookupIndirection(brickIndex);
    // w=0 means not loaded, w=255 means known empty - both are invalid
    info.valid = info.indirection.w > 0u && info.indirection.w < 255u;

    if (info.valid) {
        info.lodScale = getLodScale(info.indirection);
        let brickLength = info.tEnd - t;
        let brickWorldSize = length(brickMaxWorld - brickMinWorld);
        info.numSteps = max(1u, u32(STEPS_PER_BRICK * brickLength / brickWorldSize));
        info.stepSize = brickLength / f32(info.numSteps);
    }

    return info;
}

// Refine isosurface position using bisection
fn refineIsoSurface(
    rayOrigin: vec3f, rayDir: vec3f, tLow: f32, tHigh: f32, isoValue: f32,
    normalizedSize: vec3f, datasetSize: vec3f, indirection: vec4u, lodScale: f32
) -> f32 {
    var lo = tLow;
    var hi = tHigh;
    for (var i = 0u; i < 4u; i++) {
        let mid = (lo + hi) * 0.5;
        let pos = rayOrigin + rayDir * mid;
        let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
        let density = sampleAtlas(voxel, indirection, lodScale);
        if (density >= isoValue) { hi = mid; } else { lo = mid; }
    }
    return (lo + hi) * 0.5;
}

// Simple ray march without brick traversal (direct atlas sampling)
fn rayMarchSimple(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let maxDim = max(datasetSize.x, max(datasetSize.y, datasetSize.z));
    let rayLength = tEnd - tStart;
    let numSteps = 256u;
    let stepSize = rayLength / f32(numSteps);

    var color = vec3f(0.0);
    var alpha = 0.0;

    for (var i = 0u; i < numSteps; i++) {
        let t = tStart + f32(i) * stepSize;
        let pos = rayOrigin + rayDir * t;
        let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
        let density = sampleDirect(voxel, datasetSize);
        composeSample(density, stepSize, maxDim, &color, &alpha);
        if (alpha > EARLY_EXIT_ALPHA) { break; }
    }

    return vec4f(color, alpha);
}
