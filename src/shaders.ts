/**
 * WGSL Shaders
 */

export const volumeShader = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4f,
  inverseModel: mat4x4f,
  cameraPos: vec3f,
  useIndirection: f32,  // 0 = direct sampling, 1 = use indirection
}

const BRICK_SIZE: f32 = 64.0;
const GRID_SIZE: f32 = 8.0;
const ATLAS_SIZE: f32 = 512.0;

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var volumeSampler: sampler;
@group(0) @binding(2) var volumeTexture: texture_3d<f32>;
@group(0) @binding(3) var tfSampler: sampler;
@group(0) @binding(4) var tfTexture: texture_1d<f32>;
@group(0) @binding(5) var indirectionSampler: sampler;
@group(0) @binding(6) var indirectionTexture: texture_3d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) modelPos: vec3f,
}

@vertex
fn vs(@location(0) pos: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = uniforms.mvp * vec4f(pos, 1.0);
  out.modelPos = pos;
  return out;
}

// Sample with indirection: virtual position -> atlas position
fn sampleWithIndirection(virtualPos: vec3f) -> f32 {
  // Convert virtual position [0,512] to brick coordinate [0,1] for indirection lookup
  let brickCoord = virtualPos / ATLAS_SIZE;  // [0,1]

  // Sample indirection table (8x8x8 texture)
  // Returns: xyz = atlas brick offset (0-1), w = loaded flag
  let indirection = textureSampleLevel(indirectionTexture, indirectionSampler, brickCoord, 0.0);

  // If brick not loaded, return 0
  if (indirection.w < 0.5) {
    return 0.0;
  }

  // Calculate position within the brick [0, BRICK_SIZE]
  let posInBrick = virtualPos % BRICK_SIZE;

  // Calculate atlas position: brick offset + position within brick
  // indirection.xyz is in [0,1] range, representing atlas position
  let atlasPos = indirection.xyz + (posInBrick / ATLAS_SIZE);

  // Sample the volume atlas
  return textureSampleLevel(volumeTexture, volumeSampler, atlasPos, 0.0).r;
}

@fragment
fn fs(@location(0) modelPos: vec3f) -> @location(0) vec4f {
  let camInModel = (uniforms.inverseModel * vec4f(uniforms.cameraPos, 1.0)).xyz;
  let rayDir = normalize(modelPos - camInModel);
  let rayOrigin = camInModel;

  // Ray-box intersection for [0, 512] cube
  let invDir = 1.0 / rayDir;
  let t0 = (0.0 - rayOrigin) * invDir;
  let t1 = (512.0 - rayOrigin) * invDir;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let tNear = max(max(tmin.x, tmin.y), tmin.z);
  let tFar = min(min(tmax.x, tmax.y), tmax.z);

  if (tNear > tFar || tFar < 0.0) { discard; }

  let tStart = max(tNear, 0.0);
  let numSteps = 128u;
  let stepSize = (tFar - tStart) / f32(numSteps);

  var color = vec3f(0.0);
  var alpha = 0.0;

  for (var i = 0u; i < numSteps; i++) {
    let t = tStart + f32(i) * stepSize;
    let samplePos = rayOrigin + rayDir * t;

    // Sample volume (with or without indirection)
    var density: f32;
    if (uniforms.useIndirection > 0.5) {
      density = sampleWithIndirection(samplePos);
    } else {
      // Direct sampling: treat samplePos as atlas coordinates
      density = textureSampleLevel(volumeTexture, volumeSampler, samplePos / ATLAS_SIZE, 0.0).r;
    }

    if (density > 0.01) {
      let tfColor = textureSampleLevel(tfTexture, tfSampler, density, 0.0);
      let sampleAlpha = tfColor.a * stepSize * 2.0;

      color += tfColor.rgb * sampleAlpha * (1.0 - alpha);
      alpha += sampleAlpha * (1.0 - alpha);

      if (alpha > 0.95) { break; }
    }
  }

  return vec4f(color, alpha);
}
`;

export const wireframeShader = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return uniforms.mvp * vec4f(pos, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 1.0, 1.0);
}
`;

export const axisShader = /* wgsl */ `
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
`;
