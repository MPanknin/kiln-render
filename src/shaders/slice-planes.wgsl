// Axis-aligned slice planes: three instanced quads (X, Y, Z) sampled from the atlas.

struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0)       voxelPos: vec3f,
    // Axis the plane is normal to (0 x, 1 y, 2 z)
    @location(1) @interpolate(flat) axis: u32,
}

@vertex
fn vs(
    @builtin(vertex_index)   vi: u32,
    @builtin(instance_index) ii: u32,
) -> VertexOut {
    var out: VertexOut;
    out.voxelPos = vec3f(0.0);
    out.axis = ii;

    // Per-instance enable check — clip away disabled planes
    var enabled = false;
    if      (ii == 0u) { enabled = uniforms.sliceXEnabled != 0u; }
    else if (ii == 1u) { enabled = uniforms.sliceYEnabled != 0u; }
    else               { enabled = uniforms.sliceZEnabled != 0u; }

    if (!enabled) {
        out.position = vec4f(2.0, 2.0, 2.0, 1.0); // outside NDC, triangle discarded
        return out;
    }

    // Two-triangle quad (CCW): UV at each corner
    let quad_uv = array<vec2f, 6>(
        vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
        vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
    );
    let uv = quad_uv[vi];
    let ns = uniforms.normalizedSize;
    var pos = vec3f(0.0);

    if (ii == 0u) {
        // X-slice: YZ quad, X locked
        pos = vec3f(
            (uniforms.slicePositions.x - 0.5) * ns.x,
            (uv.x - 0.5) * ns.y,
            (uv.y - 0.5) * ns.z,
        );
    } else if (ii == 1u) {
        // Y-slice: XZ quad, Y locked
        pos = vec3f(
            (uv.x - 0.5) * ns.x,
            (uniforms.slicePositions.y - 0.5) * ns.y,
            (uv.y - 0.5) * ns.z,
        );
    } else {
        // Z-slice: XY quad, Z locked
        pos = vec3f(
            (uv.x - 0.5) * ns.x,
            (uv.y - 0.5) * ns.y,
            (uniforms.slicePositions.z - 0.5) * ns.z,
        );
    }

    out.position = uniforms.mvp * vec4f(pos, 1.0);
    out.voxelPos = normalizedToVoxel(pos, ns, uniforms.datasetSize);
    return out;
}

@fragment
fn fs(@location(0) voxelPos: vec3f, @location(1) @interpolate(flat) axis: u32) -> @location(0) vec4f {
    let brickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);
    let indirection = lookupIndirection(brickIndex);
    if (indirection.w == 0u || indirection.w == 255u) {
        if (uniforms.lodDebug != 0u) { return vec4f(0.2, 0.2, 0.2, 1.0); }
        return vec4f(0.0);
    }
    let lodScale = getLodScale(indirection);

    // LOD debug: color by LOD level, ignore data
    if (uniforms.lodDebug != 0u) {
        let lodColor = getLodColor(indirection.w);
        return vec4f(lodColor, 1.0);
    }
    return withSliceLabels(sliceImageColor(voxelPos, indirection, lodScale), voxelPos, brickIndex, indirection, axis);
}

// The image on the slice: straight alpha, blended over the scene
fn sliceImageColor(voxelPos: vec3f, indirection: vec4u, lodScale: vec3f) -> vec4f {

    if (uniforms.numChannels > 1u) {
        // Multi-channel additive blend, same composite as MIP: colour scales with
        // windowed intensity; alpha only marks coverage (pipeline blends src-alpha over).
        var rgb = vec3f(0.0);
        var peak: f32 = 0.0;
        let floatInvRange = 1.0 / max(uniforms.floatMax - uniforms.floatMin, 0.0001);
        for (var ch = 0u; ch < uniforms.numChannels; ch++) {
            let rawSample = sampleAtlasCh(ch, voxelPos, indirection, lodScale);
            let raw = clamp((rawSample - uniforms.floatMin) * floatInvRange, 0.0, 1.0);
            let wc = uniforms.channelWindowCenter[ch];
            let ww = max(uniforms.channelWindowWidth[ch], 0.0001);
            let intensity = clamp((raw - (wc - ww * 0.5)) / ww, 0.0, 1.0);
            let chColor = uniforms.channelColors[ch];
            rgb += chColor.rgb * intensity * chColor.a;
            peak = max(peak, intensity * step(0.001, chColor.a));
        }
        return vec4f(min(rgb, vec3f(1.0)), step(0.001, peak));
    } else {
        // Single channel: TF-based with windowing and float normalisation
        let rawDensity = sampleAtlas(voxelPos, indirection, lodScale);
        let density = clamp((rawDensity - uniforms.floatMin) / max(uniforms.floatMax - uniforms.floatMin, 0.0001), 0.0, 1.0);
        let windowed = applyWindow(density, uniforms.windowCenter, uniforms.windowWidth);
        return textureSampleLevel(tfTexture, tfSampler, vec2f(windowed, 0.5), 0.0);
    }
}

// Label layers over a slice colour, the first (top) layer drawn last. Fills cover at half the
// layer opacity, outlines (voxels with a differently labelled in-plane neighbour) at full.
fn withSliceLabels(image: vec4f, voxelPos: vec3f, cell: vec3f, indirection: vec4u, axis: u32) -> vec4f {
    let count = labelParams.layerCount;
    if (count == 0u) { return image; }
    let slot = labelAtlasSlot(indirection);
    var rgb = image.rgb;
    var a = image.a;
    for (var k = count; k > 0u; k--) {
        let layer = k - 1u;
        let style = labelStyleSlice(layer);
        let entry = labelEntry(layer, slot);
        if (style == 0u || !labelEntryActive(entry)) { continue; }
        let t = vec3i(floor(labelTexelPos(entry, voxelPos, cell)));
        let packed = labelColorAtTexel(entry, t);
        if (packed == 0u) { continue; }
        let c = unpack4x8unorm(packed);
        var w = 0.0;
        if ((style & LABEL_SLICE_FILL) != 0u) { w = 0.5 * labelOpacity(layer) * c.a; }
        if ((style & LABEL_SLICE_OUTLINE) != 0u) {
            // In-plane neighbours one voxel of the label level away (inside the brick's border)
            var du = vec3i(0);
            var dv = vec3i(0);
            du[(axis + 1u) % 3u] = 1;
            dv[(axis + 2u) % 3u] = 1;
            let id = labelSegmentAtTexel(entry, t);
            let edge = labelSegmentAtTexel(entry, t + du) != id || labelSegmentAtTexel(entry, t - du) != id
                    || labelSegmentAtTexel(entry, t + dv) != id || labelSegmentAtTexel(entry, t - dv) != id;
            if (edge) { w = labelOpacity(layer) * c.a; }
        }
        rgb = mix(rgb, c.rgb, w);
        a = max(a, w);
    }
    return vec4f(rgb, a);
}
