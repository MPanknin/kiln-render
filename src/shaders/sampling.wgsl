// Volume sampling functions with indirection table support

// Indirection table lookup (exact integer lookup, no interpolation)
fn lookupIndirection(brickIndex: vec3f) -> vec4u {
    return textureLoad(indirectionTexture, vec3i(brickIndex), 0);
}

// Get the scale factor for a LOD level
fn getLodScale(indirection: vec4u) -> f32 {
    // w channel stores lod+1 (0 = not loaded, 1-4 = lod 0-3)
    let lodLevel = f32(indirection.w) - 1.0;
    return exp2(lodLevel);
}

// Sample from the atlas texture using indirection mapping
fn sampleAtlas(voxelPos: vec3f, indirection: vec4u, lodScale: f32) -> f32 {
    // Position within the logical brick [0, LOGICAL_BRICK_SIZE)
    let posInBrick = (voxelPos % (LOGICAL_BRICK_SIZE * lodScale)) / lodScale;
    // Compute atlas base from integer slot indices (exact, no precision loss)
    let atlasBase = vec3f(indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE;
    // Offset by BORDER to skip the border voxel, add 0.5 to sample voxel centers
    let atlasPos = atlasBase + ((posInBrick + BORDER + 0.5) / ATLAS_SIZE);
    return textureSampleLevel(volumeTexture, volumeSampler, atlasPos, 0.0).r;
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

// Compute gradient at a position (for isosurface normals)
fn computeGradient(voxelPos: vec3f, indirection: vec4u, lodScale: f32) -> vec3f {
    // Use per-sample indirection lookup to handle brick boundaries correctly
    let h = lodScale;
    let dx = sampleWithIndirection(voxelPos + vec3f(h, 0.0, 0.0)) -
             sampleWithIndirection(voxelPos - vec3f(h, 0.0, 0.0));
    let dy = sampleWithIndirection(voxelPos + vec3f(0.0, h, 0.0)) -
             sampleWithIndirection(voxelPos - vec3f(0.0, h, 0.0));
    let dz = sampleWithIndirection(voxelPos + vec3f(0.0, 0.0, h)) -
             sampleWithIndirection(voxelPos - vec3f(0.0, 0.0, h));
    return vec3f(dx, dy, dz);
}
