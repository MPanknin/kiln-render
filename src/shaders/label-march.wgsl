// Label layers along a ray (compute shader only): a segment's surface is drawn where the ray's
// nearest-voxel label changes to it, shaded from the mask gradient; tints colour the image
// samples. The first drawn label under the pick pixel is recorded for picking.

// Set in main(): this ray belongs to the pick pixel
var<private> pickRay: bool;

struct LabelMarch {
    // Colour of each layer at the previous sample (a surface starts where it changes)
    prev: array<u32, MAX_LABEL_LAYERS>,
    // Entries of the current brick, per layer (zero: not drawn in 3D or nothing here)
    entries: array<vec4u, MAX_LABEL_LAYERS>,
    // Tint of the current sample: colour and opacity
    tint: vec4f,
    picked: bool,
}

// Load every layer's entry for a brick; a brick without labels ends the layer's surface
fn labelMarchBrick(m: ptr<function, LabelMarch>, valid: bool, indirection: vec4u) {
    let slot = labelAtlasSlot(indirection);
    for (var i = 0u; i < labelParams.layerCount; i++) {
        var entry = vec4u(0u);
        if (valid && labelStyle3d(i) != 0u) { entry = labelEntry(i, slot); }
        (*m).entries[i] = entry;
        if (!labelEntryActive(entry)) { (*m).prev[i] = 0u; }
    }
}

// The label layers at one sample. Returns the premultiplied colour of surfaces starting here, to
// composite in front of the image sample, and leaves the sample's tint in m.tint. `shade` lights
// surfaces from the mask gradient.
fn labelMarchSample(
    m: ptr<function, LabelMarch>, voxel: vec3f, cell: vec3f, voxelsPerUnit: vec3f, lightDir: vec3f, shade: bool,
) -> vec4f {
    var surface = vec4f(0.0);
    var tint = vec4f(0.0);
    for (var i = 0u; i < labelParams.layerCount; i++) {
        let entry = (*m).entries[i];
        if (!labelEntryActive(entry)) { continue; }
        let packed = labelColor(entry, voxel, cell);
        if (packed != 0u) {
            let c = unpack4x8unorm(packed);
            let a = labelOpacity(i) * c.a;
            if (labelStyle3d(i) == LABEL_STYLE_TINT) {
                // Upper layers (lower index) tint over lower ones
                if (tint.a == 0.0) { tint = vec4f(c.rgb, a); }
            } else if (packed != (*m).prev[i] && surface.a < 0.999) {
                var rgb = c.rgb;
                if (shade) { rgb = shadeLabelSurface(rgb, labelGradient(entry, voxel, cell, packed), voxelsPerUnit, lightDir); }
                surface += vec4f(rgb * a, a) * (1.0 - surface.a);
            }
            labelPickHit(m, voxel);
        }
        (*m).prev[i] = packed;
    }
    (*m).tint = tint;
    return surface;
}

// Record the first drawn label of the pick pixel's ray
fn labelPickHit(m: ptr<function, LabelMarch>, voxel: vec3f) {
    if (pickRay && !(*m).picked) {
        labelPick.hit = vec4f(voxel, 1.0);
        (*m).picked = true;
    }
}

// Pick: the segment of every shown layer at the voxel in labelPick.hit (written by the ray march
// for the pick pixel, or by the CPU for slice planes). Per layer: atlas slot + 1, palette index,
// colour, entry kind; the CPU looks the ID up in its copy of the brick's palette.
@compute @workgroup_size(1)
fn pickLabels() {
    for (var i = 0u; i < MAX_LABEL_LAYERS; i++) { labelPick.layers[i] = vec4u(0u); }
    let hit = labelPick.hit;
    if (hit.w < 0.5) { return; }
    let voxel = hit.xyz;
    let grid = vec3f(textureDimensions(indirectionTexture));
    let cell = clamp(floor(voxel / LOGICAL_BRICK_SIZE), vec3f(0.0), grid - 1.0);
    let indirection = lookupIndirection(cell);
    if (indirection.w == 0u || indirection.w == 255u) { return; }
    let slot = labelAtlasSlot(indirection);
    for (var i = 0u; i < labelParams.layerCount; i++) {
        let entry = labelEntry(i, slot);
        let kind = entry.x & 3u;
        var index = 0u;
        var color = 0u;
        if (kind == LABEL_ONE_ID) {
            color = entry.y;
        } else if (kind == LABEL_POOL) {
            index = labelIndexAt(entry, clamp(vec3i(floor(labelTexelPos(entry, voxel, cell))), vec3i(0), vec3i(65)));
            if (index != 0u) { color = labelPalette[entry.y + index]; }
        }
        labelPick.layers[i] = vec4u(slot + 1u, index, color, kind);
    }
}
