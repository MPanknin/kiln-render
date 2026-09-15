// Axis-aligned slice planes: three instanced quads (X, Y, Z) sampled from the atlas.

struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0)       voxelPos: vec3f,
}

@vertex
fn vs(
    @builtin(vertex_index)   vi: u32,
    @builtin(instance_index) ii: u32,
) -> VertexOut {
    var out: VertexOut;
    out.voxelPos = vec3f(0.0);

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
fn fs(@location(0) voxelPos: vec3f) -> @location(0) vec4f {
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
