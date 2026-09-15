// Volume sampling functions with indirection table support

// Indirection table lookup (exact integer lookup, no interpolation)
fn lookupIndirection(brickIndex: vec3f) -> vec4u {
    return textureLoad(indirectionTexture, vec3i(brickIndex), 0);
}

// Per-axis finest-voxels-per-level-voxel for a LOD, from the uniform table
fn getLodScale(indirection: vec4u) -> vec3f {
    // w channel stores lod+1 (0 = not loaded, 1+ = lod level, 255 = empty)
    return uniforms.lodScales[indirection.w - 1u].xyz;
}

// Sample from the atlas texture using indirection mapping
fn sampleAtlas(voxelPos: vec3f, indirection: vec4u, lodScale: vec3f) -> f32 {
    // Position within the logical brick [0, LOGICAL_BRICK_SIZE)
    let posInBrick = (voxelPos % (LOGICAL_BRICK_SIZE * lodScale)) / lodScale;
    // Compute atlas base from integer slot indices (exact, no precision loss)
    let atlasBase = vec3f(indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE;
    // Offset by BORDER to skip the border voxel. posInBrick already carries
    // the voxel-centre +0.5 (voxel i's centre lies at continuous coord i+0.5),
    // so an extra +0.5 here shifted every sample by half a texel — half a
    // *coarse* voxel at LOD>0 — misaligning adjacent LODs at transitions.
    let atlasPos = atlasBase + ((posInBrick + BORDER) / ATLAS_SIZE);
    return textureSampleLevel(volumeTexture, volumeSampler, atlasPos, 0.0).r;
}

// Sample from a specific channel atlas using the shared indirection mapping
fn sampleAtlasCh(ch: u32, voxelPos: vec3f, indirection: vec4u, lodScale: vec3f) -> f32 {
    let posInBrick = (voxelPos % (LOGICAL_BRICK_SIZE * lodScale)) / lodScale;
    let atlasBase = vec3f(indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE;
    let atlasPos = atlasBase + ((posInBrick + BORDER) / ATLAS_SIZE);
    switch (ch) {
        case 0u: { return textureSampleLevel(volumeTexture,  volumeSampler, atlasPos, 0.0).r; }
        case 1u: { return textureSampleLevel(volumeTexture1, volumeSampler, atlasPos, 0.0).r; }
        case 2u: { return textureSampleLevel(volumeTexture2, volumeSampler, atlasPos, 0.0).r; }
        default: { return textureSampleLevel(volumeTexture3, volumeSampler, atlasPos, 0.0).r; }
    }
}

// hot-path atlas sampling using precomputed affine transform
// atlasOffset and atlasScale are computed once per brick in setupBrick
fn sampleAtlasAffine(voxelPos: vec3f, atlasOffset: vec3f, atlasScale: vec3f) -> f32 {
    let atlasPos = atlasOffset + voxelPos * atlasScale;
    return textureSampleLevel(volumeTexture, volumeSampler, atlasPos, 0.0).r;
}

// multi-channel variant of the affine hot-path sampler.
fn sampleAtlasChAffine(ch: u32, voxelPos: vec3f, atlasOffset: vec3f, atlasScale: vec3f) -> f32 {
    let atlasPos = atlasOffset + voxelPos * atlasScale;
    switch (ch) {
        case 0u: { return textureSampleLevel(volumeTexture,  volumeSampler, atlasPos, 0.0).r; }
        case 1u: { return textureSampleLevel(volumeTexture1, volumeSampler, atlasPos, 0.0).r; }
        case 2u: { return textureSampleLevel(volumeTexture2, volumeSampler, atlasPos, 0.0).r; }
        default: { return textureSampleLevel(volumeTexture3, volumeSampler, atlasPos, 0.0).r; }
    }
}

// Direct atlas sampling without indirection (for debugging)
fn sampleDirect(voxelPos: vec3f, datasetSize: vec3f) -> f32 {
    let atlasPos = voxelPos / ATLAS_SIZE;
    return textureSampleLevel(volumeTexture, volumeSampler, atlasPos, 0.0).r;
}

// Sample with full indirection lookup
fn sampleWithIndirection(voxelPos: vec3f) -> f32 {
    let brickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);
    let indirection = lookupIndirection(brickIndex);
    // w=0: not loaded, w=255: known empty brick - both return 0
    if (indirection.w == 0u || indirection.w == 255u) { return 0.0; }
    let lodScale = getLodScale(indirection);
    return sampleAtlas(voxelPos, indirection, lodScale);
}

// Sample at an offset, reusing the center brick's indirection when the offset
// stays in the same brick. Falls back to full lookup at brick boundaries.
fn sampleGradientOffset(
    offsetPos: vec3f,
    centerBrickIndex: vec3f,
    indirection: vec4u,
    lodScale: vec3f,
) -> f32 {
    let offsetBrickIndex = floor(offsetPos / LOGICAL_BRICK_SIZE);
    if (all(offsetBrickIndex == centerBrickIndex)) {
        return sampleAtlas(offsetPos, indirection, lodScale);
    }
    return sampleWithIndirection(offsetPos);
}

// Compute gradient at a position (for isosurface normals); central differences one level voxel apart per axis
fn computeGradient(voxelPos: vec3f, indirection: vec4u, lodScale: vec3f) -> vec3f {
    let h = lodScale;
    let centerBrickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);
    let dx = sampleGradientOffset(voxelPos + vec3f(h.x, 0.0, 0.0), centerBrickIndex, indirection, lodScale) -
             sampleGradientOffset(voxelPos - vec3f(h.x, 0.0, 0.0), centerBrickIndex, indirection, lodScale);
    let dy = sampleGradientOffset(voxelPos + vec3f(0.0, h.y, 0.0), centerBrickIndex, indirection, lodScale) -
             sampleGradientOffset(voxelPos - vec3f(0.0, h.y, 0.0), centerBrickIndex, indirection, lodScale);
    let dz = sampleGradientOffset(voxelPos + vec3f(0.0, 0.0, h.z), centerBrickIndex, indirection, lodScale) -
             sampleGradientOffset(voxelPos - vec3f(0.0, 0.0, h.z), centerBrickIndex, indirection, lodScale);
    return vec3f(dx, dy, dz);
}
