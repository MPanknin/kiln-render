// Labels: integer IDs in an r16uint atlas laid out slot for slot like the image atlas. A slot's
// labels are valid once its label brick has arrived (labelSlots); colours come from a 256 × 256
// table indexed by ID, where alpha 0 means unlabelled or hidden.

// Whether the label brick of this indirection entry's atlas slot has arrived
fn labelSlotReady(indirection: vec4u) -> bool {
    let grid = u32(ATLAS_SIZE / PHYSICAL_BRICK_SIZE + 0.5);
    let slot = indirection.x + grid * (indirection.y + grid * indirection.z);
    return slot < arrayLength(&labelSlots) && labelSlots[slot] != 0u;
}

// Label colour at an atlas position in [0, 1]³ (as for sampling), nearest voxel
fn labelColorAt(atlasPos: vec3f) -> vec4f {
    let id = textureLoad(labelAtlas, vec3i(atlasPos * ATLAS_SIZE), 0).r;
    if (id == 0u) { return vec4f(0.0); }
    return textureLoad(labelColors, vec2i(i32(id & 255u), i32(id >> 8u)), 0);
}

// Label colour at a finest-level voxel position, through the brick's indirection entry
fn labelColorAtVoxel(voxelPos: vec3f, indirection: vec4u, lodScale: vec3f) -> vec4f {
    if (!labelSlotReady(indirection)) { return vec4f(0.0); }
    let posInBrick = (voxelPos % (LOGICAL_BRICK_SIZE * lodScale)) / lodScale;
    let atlasBase = vec3f(indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE;
    return labelColorAt(atlasBase + (posInBrick + BORDER) / ATLAS_SIZE);
}

// Blend a label colour over a premultiplied pixel
fn overlayLabel(pixel: vec4f, label: vec4f, opacity: f32) -> vec4f {
    let w = opacity * label.a;
    return vec4f(mix(pixel.rgb, label.rgb, w), mix(pixel.a, 1.0, w));
}
