// Ray marching core - brick traversal and integration

// Brick setup information
struct BrickInfo {
    indirection: vec4u,
    lodScale: vec3f,
    tEnd: f32,
    numSteps: u32,
    stepSize: f32,
    valid: bool,
    // affine atlas transform: atlasPos = atlasOffset + voxelPos * atlasScale
    // precomputed per brick to replace fmod + divides in the hot loop
    atlasOffset: vec3f,
    atlasScale: vec3f,
    // voxel range this brick's atlas slot can be sampled in: the logical brick
    // plus half of its ghost border (beyond that, filtering reads the next slot)
    sampleMin: vec3f,
    sampleMax: vec3f,
}

// Set up brick traversal parameters
fn setupBrick(
    rayOrigin: vec3f, rayDir: vec3f, invDir: vec3f, t: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> BrickInfo {
    var info: BrickInfo;

    let samplePos = rayOrigin + rayDir * t;
    let voxelPos = clamp(
        normalizedToVoxel(samplePos, normalizedSize, datasetSize),
        vec3f(0.0),
        datasetSize - vec3f(0.001)
    );
    let brickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);

    let brickMinVoxel = brickIndex * LOGICAL_BRICK_SIZE;
    let brickMaxVoxel = brickMinVoxel + LOGICAL_BRICK_SIZE;
    let brickMinWorld = voxelToNormalized(brickMinVoxel, normalizedSize, datasetSize);
    let brickMaxWorld = voxelToNormalized(brickMaxVoxel, normalizedSize, datasetSize);

    let tBrick = intersectBoxInv(rayOrigin, invDir, brickMinWorld, brickMaxWorld);
    info.tEnd = min(tBrick.y, tEnd);

    markRayVisited(brickIndex);

    info.indirection = lookupIndirection(brickIndex);
    // w=0 means not loaded, w=255 means known empty - both are invalid
    info.valid = info.indirection.w > 0u && info.indirection.w < 255u;

    if (info.valid) {
        info.lodScale = getLodScale(info.indirection);

        // LOD-adaptive step size — coarse bricks use larger steps (coarsest axis, as the
        // legacy scalar did); compositing uses exact Beer-Lambert (1 - exp2)
        let brickWorldSize = length(brickMaxWorld - brickMinWorld);
        let brickLength = info.tEnd - t;
        let lodStepMul = min(max(info.lodScale.x, max(info.lodScale.y, info.lodScale.z)), 4.0);
        info.stepSize = (brickWorldSize / STEPS_PER_BRICK) * lodStepMul;
        info.numSteps = max(1u, u32(ceil(brickLength / info.stepSize)) + 1u);

        // precompute affine atlas transform for the hot loop
        let coarseBrickOrigin = floor(brickIndex / info.lodScale) * info.lodScale * LOGICAL_BRICK_SIZE;
        info.atlasScale = 1.0 / (info.lodScale * ATLAS_SIZE);
        // BORDER only — must match the corrected sampleAtlas / sampleAtlasCh
        // (no extra half-texel; see sampling.wgsl for the derivation).
        info.atlasOffset = vec3f(info.indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE
                         + BORDER / ATLAS_SIZE
                         - coarseBrickOrigin * info.atlasScale;
        info.sampleMin = coarseBrickOrigin - 0.5 * BORDER * info.lodScale;
        info.sampleMax = coarseBrickOrigin + (LOGICAL_BRICK_SIZE + 0.5 * BORDER) * info.lodScale;
    }

    return info;
}

// Ray-guided streaming: record that a ray entered this finest-level brick cell.
// Called per brick a ray steps into, so cells behind early ray termination,
// outside the clip box or never reached stay unmarked. The atomic read avoids
// redundant atomic writes when many rays share a cell; it still has a GPU cost.
fn markRayVisited(brickIndex: vec3f) {
    let words = arrayLength(&rayVisited);
    if (words <= 1u) { return; }
    let grid = textureDimensions(indirectionTexture);
    // ISO gradient offsets may leave the volume. Reject them before unsigned
    // conversion / flattening, which could otherwise alias an unrelated cell.
    if (any(brickIndex < vec3f(0.0)) || any(brickIndex >= vec3f(grid))) { return; }
    let c = vec3u(brickIndex);
    let cell = (c.z * grid.y + c.y) * grid.x + c.x;
    let word = 1u + (cell >> 5u);
    let bit = 1u << (cell & 31u);
    if (word < words && (atomicLoad(&rayVisited[word]) & bit) == 0u) {
        atomicOr(&rayVisited[word], bit);
    }
}

// ISO normals depend on six samples, including cells no ray entered (e.g. just
// beyond a clip plane). Keep those cells eligible for refinement as well.
fn markIsoGradientVisited(voxelPos: vec3f, lodScale: vec3f) {
    if (arrayLength(&rayVisited) <= 1u) { return; }
    let center = floor(voxelPos / LOGICAL_BRICK_SIZE);
    for (var axis = 0u; axis < 3u; axis++) {
        var offset = vec3f(0.0);
        offset[axis] = lodScale[axis];
        let lo = floor((voxelPos - offset) / LOGICAL_BRICK_SIZE);
        let hi = floor((voxelPos + offset) / LOGICAL_BRICK_SIZE);
        if (any(lo != center)) { markRayVisited(lo); }
        if (any(hi != center)) { markRayVisited(hi); }
    }
}

// Central-difference gradient from the current brick's atlas slot alone, so the
// DVR hot loop needs no indirection lookups. Offsets are clamped to the slot's
// sampleable range; near a brick face the difference then spans less than two
// level voxels, and dividing by the actual span keeps the slope right.
// Returns raw texel units per level voxel, along the voxel axes.
fn brickGradient(voxel: vec3f, brick: BrickInfo) -> vec3f {
    let h = brick.lodScale;
    return vec3f(
        brickSlope(voxel, vec3f(h.x, 0.0, 0.0), h.x, brick),
        brickSlope(voxel, vec3f(0.0, h.y, 0.0), h.y, brick),
        brickSlope(voxel, vec3f(0.0, 0.0, h.z), h.z, brick),
    );
}

// One axis of brickGradient: offset is one level voxel (h finest voxels) along that axis
fn brickSlope(voxel: vec3f, offset: vec3f, h: f32, brick: BrickInfo) -> f32 {
    let hi = clamp(voxel + offset, brick.sampleMin, brick.sampleMax);
    let lo = clamp(voxel - offset, brick.sampleMin, brick.sampleMax);
    let span = max(dot(hi - lo, offset) / (h * h), 0.001); // in level voxels
    return (sampleAtlasAffine(hi, brick.atlasOffset, brick.atlasScale)
          - sampleAtlasAffine(lo, brick.atlasOffset, brick.atlasScale)) / span;
}

// Refine isosurface position using bisection with windowing.
// Uses sampleWithIndirection so bisection across brick boundaries is correct.
fn refineIsoSurfaceWindowed(
    rayOrigin: vec3f, rayDir: vec3f, tLow: f32, tHigh: f32, isoValue: f32,
    normalizedSize: vec3f, datasetSize: vec3f,
    windowCenter: f32, windowWidth: f32
) -> f32 {
    var lo = tLow;
    var hi = tHigh;
    for (var i = 0u; i < 4u; i++) {
        let mid = (lo + hi) * 0.5;
        let pos = rayOrigin + rayDir * mid;
        let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
        let rawDensity = sampleWithIndirection(voxel);
        let normalizedDensity = clamp((rawDensity - uniforms.floatMin) / max(uniforms.floatMax - uniforms.floatMin, 0.0001), 0.0, 1.0);
        let density = applyWindow(normalizedDensity, windowCenter, windowWidth);
        if (density >= isoValue) { hi = mid; } else { lo = mid; }
    }
    return (lo + hi) * 0.5;
}

// Simple ray march without brick traversal (direct atlas sampling)
// This renders the raw atlas texture as a debug view
fn rayMarchSimple(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    // For atlas debug view, use atlas size as the volume dimension
    let atlasSize = ATLAS_SIZE;
    let rayLength = tEnd - tStart;
    let numSteps = 512u;  // More steps for full atlas
    let stepSize = rayLength / f32(numSteps);
    let extinctionScale = stepSize * atlasSize * 0.5 * LOG2E;

    var color = vec3f(0.0);
    var alpha = 0.0;

    for (var i = 0u; i < numSteps; i++) {
        let t = tStart + f32(i) * stepSize;
        let pos = rayOrigin + rayDir * t;
        // Convert normalized position [-0.5, 0.5] to UV [0, 1] for atlas sampling
        let atlasUV = (pos / normalizedSize) + 0.5;
        let rawDensity = textureSampleLevel(volumeTexture, volumeSampler, atlasUV, 0.0).r;
        let density = clamp((rawDensity - uniforms.floatMin) / max(uniforms.floatMax - uniforms.floatMin, 0.0001), 0.0, 1.0);
        composeSampleWindowed(density, extinctionScale, uniforms.windowCenter, uniforms.windowWidth, &color, &alpha);
        if (alpha > EARLY_EXIT_ALPHA) { break; }
    }

    return vec4f(color, alpha);
}

