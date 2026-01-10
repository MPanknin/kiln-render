// Axis helper rendering shader (RGB axes)

struct Uniforms {
    vp: mat4x4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0) color: vec3f,
}

@vertex
fn vs(@location(0) pos: vec3f, @location(1) color: vec3f) -> VertexOut {
    var out: VertexOut;
    out.position = uniforms.vp * vec4f(pos, 1.0);
    out.color = color;
    return out;
}

@fragment
fn fs(@location(0) color: vec3f) -> @location(0) vec4f {
    return vec4f(color, 1.0);
}
