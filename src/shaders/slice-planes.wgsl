// Axis-aligned slice planes through the volume in 3D space.
// Three instanced quads (instance 0=X, 1=Y, 2=Z) positioned in normalized
// volume space and sampled from the atlas.
//
// Prepend: common.wgsl + sampling.wgsl

struct Uniforms {
    mvp:             mat4x4f,
    normalizedSize:  vec3f,
    _pad0:           f32,
    datasetSize:     vec3f,
    _pad1:           f32,
    windowCenter:    f32,
    windowWidth:     f32,
    floatMin:        f32,
    floatMax:        f32,
    slicePositions:  vec3f,  // X, Y, Z slice positions in [0, 1]
    _pad2:           f32,
    sliceXEnabled:   u32,
    sliceYEnabled:   u32,
    sliceZEnabled:   u32,
    _pad3:           u32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var volumeSampler: sampler;
@group(0) @binding(2) var volumeTexture: texture_3d<f32>;
@group(0) @binding(3) var tfSampler: sampler;
@group(0) @binding(4) var tfTexture: texture_2d<f32>;
@group(0) @binding(6) var indirectionTexture: texture_3d<u32>;

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
    let rawDensity     = sampleWithIndirection(voxelPos);
    let density        = clamp((rawDensity - uniforms.floatMin) / max(uniforms.floatMax - uniforms.floatMin, 0.0001), 0.0, 1.0);
    let windowed       = applyWindow(density, uniforms.windowCenter, uniforms.windowWidth);
    return textureSampleLevel(tfTexture, tfSampler, vec2f(windowed, 0.5), 0.0);
}
