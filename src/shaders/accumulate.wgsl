// Temporal accumulation - progressive average of current frame with history

struct AccumUniforms {
    screenSize: vec2f,
    weight: f32,
}

@group(0) @binding(0) var<uniform> params: AccumUniforms;
@group(0) @binding(1) var currentTexture: texture_2d<f32>;
@group(0) @binding(2) var historyTexture: texture_2d<f32>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let coord = vec2i(gid.xy);
    if (coord.x >= i32(params.screenSize.x) || coord.y >= i32(params.screenSize.y)) { return; }

    let current = textureLoad(currentTexture, coord, 0);
    let history = textureLoad(historyTexture, coord, 0);
    let blended = mix(history, current, params.weight);
    textureStore(outputTexture, coord, blended);
}
