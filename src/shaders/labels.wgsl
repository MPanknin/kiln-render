// Label layers. Per shown layer and image atlas slot, an entry says how the image brick in that
// slot is labelled (see LabelGpu):
//   x: kind (bits 0–1: 2 one ID, 3 a brick in the pool), level (bits 4–7)
//   y: one ID: its packed RGBA colour; pool brick: offset of its palette in labelPalette
//   z: pool brick: its pool slot
// The level can be coarser than the image brick's while the brick's own labels load.
// Colours are resolved on the CPU, so a packed colour of 0 means "not drawn".

const LABEL_ONE_ID: u32 = 2u;
const LABEL_POOL: u32 = 3u;
const LABEL_STYLE_SURFACE: u32 = 1u;
const LABEL_STYLE_TINT: u32 = 2u;
const LABEL_SLICE_FILL: u32 = 1u;
const LABEL_SLICE_OUTLINE: u32 = 2u;

fn labelEntry(layer: u32, slot: u32) -> vec4u {
    return labelEntries[layer * labelParams.atlasSlots + slot];
}

// Image atlas slot index of an indirection entry
fn labelAtlasSlot(indirection: vec4u) -> u32 {
    let g = labelParams.atlasGrid;
    return indirection.x + g * (indirection.y + g * indirection.z);
}

fn labelOpacity(layer: u32) -> f32 { return labelParams.layers[layer].x; }
fn labelStyle3d(layer: u32) -> u32 { return u32(labelParams.layers[layer].y + 0.5); }
fn labelStyleSlice(layer: u32) -> u32 { return u32(labelParams.layers[layer].z + 0.5); }

// Whether the entry labels anything (one ID or a pool brick)
fn labelEntryActive(entry: vec4u) -> bool { return (entry.x & 3u) >= LABEL_ONE_ID; }

// First texel of a pool slot
fn labelPoolBase(slot: u32) -> vec3i {
    let g = labelParams.poolGrid;
    return vec3i(i32(slot % g), i32((slot / g) % g), i32(slot / (g * g))) * i32(PHYSICAL_BRICK_SIZE);
}

// Finest-level voxels per voxel of the entry's level
fn labelSpan(entry: vec4u) -> vec3f {
    return uniforms.lodScales[(entry.x >> 4u) & 15u].xyz;
}

// Continuous texel position (texel k spans [k, k + 1)) of a finest-level voxel position in the
// entry's brick; `cell` is the finest-level brick cell the image brick was looked up from
fn labelTexelPos(entry: vec4u, voxel: vec3f, cell: vec3f) -> vec3f {
    let span = labelSpan(entry);
    let origin = floor(cell / span) * span * LOGICAL_BRICK_SIZE;
    return (voxel - origin) / span + BORDER;
}

// Palette index at texel t (0…65) of a pool brick
fn labelIndexAt(entry: vec4u, t: vec3i) -> u32 {
    return textureLoad(labelPool, labelPoolBase(entry.z) + t, 0).r;
}

// Packed colour at texel t of the entry's brick (0: not drawn)
fn labelColorAtTexel(entry: vec4u, t: vec3i) -> u32 {
    let kind = entry.x & 3u;
    if (kind == LABEL_ONE_ID) { return entry.y; }
    if (kind != LABEL_POOL) { return 0u; }
    let index = labelIndexAt(entry, clamp(t, vec3i(0), vec3i(65)));
    if (index == 0u) { return 0u; }
    return labelPalette[entry.y + index];
}

// Which segment texel t of the entry's brick holds: the palette index, the same for every texel
// of a one-ID brick. Tells touching segments apart even when they share a colour.
fn labelSegmentAtTexel(entry: vec4u, t: vec3i) -> u32 {
    if ((entry.x & 3u) != LABEL_POOL) { return 1u; }
    return labelIndexAt(entry, clamp(t, vec3i(0), vec3i(65)));
}

// Packed colour at a finest-level voxel position, nearest voxel (IDs never blend)
fn labelColor(entry: vec4u, voxel: vec3f, cell: vec3f) -> u32 {
    let kind = entry.x & 3u;
    if (kind == LABEL_ONE_ID) { return entry.y; }
    if (kind != LABEL_POOL) { return 0u; }
    return labelColorAtTexel(entry, vec3i(floor(labelTexelPos(entry, voxel, cell))));
}

// Packed colour of `layer` at a finest-level voxel position, through the indirection table
fn labelColorAtVoxel(layer: u32, voxel: vec3f) -> u32 {
    let grid = vec3f(textureDimensions(indirectionTexture));
    let cell = clamp(floor(voxel / LOGICAL_BRICK_SIZE), vec3f(0.0), grid - 1.0);
    let indirection = lookupIndirection(cell);
    if (indirection.w == 0u || indirection.w == 255u) { return 0u; }
    return labelColor(labelEntry(layer, labelAtlasSlot(indirection)), voxel, cell);
}

// Gradient of a segment's mask (texels of colour `color`) at a voxel position, along the
// finest-level voxel axes, from the six neighbouring texels (inside the brick's border).
fn labelGradient(entry: vec4u, voxel: vec3f, cell: vec3f, color: u32) -> vec3f {
    if ((entry.x & 3u) != LABEL_POOL) { return vec3f(0.0); }
    let t = vec3i(floor(labelTexelPos(entry, voxel, cell)));
    var g = vec3f(0.0);
    for (var axis = 0u; axis < 3u; axis++) {
        var d = vec3i(0);
        d[axis] = 1;
        let hi = f32(labelColorAtTexel(entry, t + d) == color);
        let lo = f32(labelColorAtTexel(entry, t - d) == color);
        g[axis] = (hi - lo) * 0.5;
    }
    return g / labelSpan(entry);
}

// Shaded colour of a label surface; without a usable normal (the inside of a segment cut open
// by the clip box or the volume's edge) it faces the viewer
fn shadeLabelSurface(rgb: vec3f, gradient: vec3f, voxelsPerUnit: vec3f, lightDir: vec3f) -> vec3f {
    let g = gradient * voxelsPerUnit;
    if (dot(g, g) < 1e-10) { return rgb * (AMBIENT + DIFFUSE); }
    return shadeTwoSided(normalize(g), lightDir, rgb);
}
