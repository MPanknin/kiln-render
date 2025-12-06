/**
 * WGSL Shaders
 */

import { CONFIG } from './config.js';

// ============================================================================
// Shared WGSL code used by both fragment and compute shaders
// ============================================================================

const sharedConstants = /* wgsl */ `
const BRICK_SIZE: f32 = ${CONFIG.BRICK_SIZE}.0;
const GRID_SIZE: f32 = ${CONFIG.GRID_SIZE}.0;
const ATLAS_SIZE: f32 = ${CONFIG.ATLAS_SIZE}.0;
const NUM_STEPS: u32 = 128u;
const EARLY_EXIT_ALPHA: f32 = 0.95;
`;

const sharedBindings = /* wgsl */ `
@group(0) @binding(1) var volumeSampler: sampler;
@group(0) @binding(2) var volumeTexture: texture_3d<f32>;
@group(0) @binding(3) var tfSampler: sampler;
@group(0) @binding(4) var tfTexture: texture_1d<f32>;
@group(0) @binding(5) var indirectionSampler: sampler;
@group(0) @binding(6) var indirectionTexture: texture_3d<f32>;
`;

const sharedFunctions = /* wgsl */ `
// Convert normalized position to virtual voxel coordinates
fn normalizedToVoxel(normalizedPos: vec3f, normalizedSize: vec3f, datasetSize: vec3f) -> vec3f {
  let unitPos = (normalizedPos / normalizedSize) + 0.5;
  return unitPos * datasetSize;
}

// Ray-box intersection: returns (tNear, tFar)
fn intersectBox(rayOrigin: vec3f, rayDir: vec3f, boxMin: vec3f, boxMax: vec3f) -> vec2f {
  let invDir = 1.0 / rayDir;
  let t0 = (boxMin - rayOrigin) * invDir;
  let t1 = (boxMax - rayOrigin) * invDir;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let tNear = max(max(tmin.x, tmin.y), tmin.z);
  let tFar = min(min(tmax.x, tmax.y), tmax.z);
  return vec2f(tNear, tFar);
}

// Sample with indirection: virtual voxel position -> density
fn sampleWithIndirection(voxelPos: vec3f, datasetSize: vec3f) -> f32 {
  let brickCoord = voxelPos / datasetSize;
  let indirection = textureSampleLevel(indirectionTexture, indirectionSampler, brickCoord, 0.0);

  if (indirection.w < 0.1) {
    return 0.0;
  }

  // Decode LOD level from w channel: w = (lod + 1) * 51 / 255
  let lodLevel = round(indirection.w * 5.0) - 1.0;
  let lodScale = pow(2.0, lodLevel);
  let brickExtent = BRICK_SIZE * lodScale;
  let posInBrick = (voxelPos % brickExtent) / lodScale;
  let atlasPos = indirection.xyz + (posInBrick / ATLAS_SIZE);

  return textureSampleLevel(volumeTexture, volumeSampler, atlasPos, 0.0).r;
}

// Sample volume (with or without indirection)
fn sampleVolume(voxelPos: vec3f, datasetSize: vec3f, useIndirection: f32) -> f32 {
  if (useIndirection > 0.5) {
    return sampleWithIndirection(voxelPos, datasetSize);
  } else {
    return textureSampleLevel(volumeTexture, volumeSampler, voxelPos / ATLAS_SIZE, 0.0).r;
  }
}

// Front-to-back compositing for a single sample
fn composeSample(density: f32, stepSize: f32, maxDim: f32, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
  if (density > 0.01) {
    let tfColor = textureSampleLevel(tfTexture, tfSampler, density, 0.0);
    let sampleAlpha = tfColor.a * stepSize * maxDim * 0.3;

    *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
    *alpha += sampleAlpha * (1.0 - *alpha);
  }
}

// Ray march through volume, returns (color, alpha)
fn rayMarch(
  rayOrigin: vec3f,
  rayDir: vec3f,
  tStart: f32,
  tEnd: f32,
  normalizedSize: vec3f,
  datasetSize: vec3f,
  useIndirection: f32
) -> vec4f {
  let stepSize = (tEnd - tStart) / f32(NUM_STEPS);
  let maxDim = max(datasetSize.x, max(datasetSize.y, datasetSize.z));

  var color = vec3f(0.0);
  var alpha = 0.0;

  for (var i = 0u; i < NUM_STEPS; i++) {
    let t = tStart + f32(i) * stepSize;
    let samplePos = rayOrigin + rayDir * t;
    let voxelPos = normalizedToVoxel(samplePos, normalizedSize, datasetSize);

    let density = sampleVolume(voxelPos, datasetSize, useIndirection);
    composeSample(density, stepSize, maxDim, &color, &alpha);

    if (alpha > EARLY_EXIT_ALPHA) { break; }
  }

  return vec4f(color, alpha);
}
`;

// ============================================================================
// Volume Fragment Shader (proxy box rasterization)
// ============================================================================

export const volumeShader = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4f,
  inverseModel: mat4x4f,
  cameraPos: vec3f,
  useIndirection: f32,
  datasetSize: vec3f,
  _pad1: f32,
  normalizedSize: vec3f,
  _pad2: f32,
}

${sharedConstants}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${sharedBindings}

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

${sharedFunctions}

@fragment
fn fs(@location(0) modelPos: vec3f) -> @location(0) vec4f {
  let camInModel = (uniforms.inverseModel * vec4f(uniforms.cameraPos, 1.0)).xyz;
  let rayOrigin = camInModel;
  let rayDir = normalize(modelPos - camInModel);

  // Ray-box intersection
  let halfSize = uniforms.normalizedSize * 0.5;
  let hit = intersectBox(rayOrigin, rayDir, -halfSize, halfSize);

  if (hit.x > hit.y || hit.y <= 0.0) { discard; }

  let tStart = max(hit.x, 0.0);
  let result = rayMarch(rayOrigin, rayDir, tStart, hit.y, uniforms.normalizedSize, uniforms.datasetSize, uniforms.useIndirection);

  return result;
}
`;

// ============================================================================
// Wireframe Shader
// ============================================================================

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

// ============================================================================
// Volume Compute Shader (per-pixel raycasting)
// ============================================================================

export const computeShader = /* wgsl */ `
struct Uniforms {
  inverseViewProj: mat4x4f,
  cameraPos: vec3f,
  useIndirection: f32,
  datasetSize: vec3f,
  _pad1: f32,
  normalizedSize: vec3f,
  _pad2: f32,
  screenSize: vec2f,
  _pad3: vec2f,
}

${sharedConstants}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${sharedBindings}
@group(0) @binding(7) var outputTexture: texture_storage_2d<rgba8unorm, write>;

${sharedFunctions}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let pixelCoord = vec2i(globalId.xy);
  let screenSize = vec2i(uniforms.screenSize);

  if (pixelCoord.x >= screenSize.x || pixelCoord.y >= screenSize.y) {
    return;
  }

  // NDC coordinates [-1, 1]
  let ndc = vec2f(
    (f32(pixelCoord.x) + 0.5) / f32(screenSize.x) * 2.0 - 1.0,
    1.0 - (f32(pixelCoord.y) + 0.5) / f32(screenSize.y) * 2.0
  );

  // Unproject to world space
  let nearPoint = uniforms.inverseViewProj * vec4f(ndc, -1.0, 1.0);
  let farPoint = uniforms.inverseViewProj * vec4f(ndc, 1.0, 1.0);
  let near = nearPoint.xyz / nearPoint.w;
  let far = farPoint.xyz / farPoint.w;

  let rayOrigin = uniforms.cameraPos;
  let rayDir = normalize(far - near);

  // Ray-box intersection
  let halfSize = uniforms.normalizedSize * 0.5;
  let hit = intersectBox(rayOrigin, rayDir, -halfSize, halfSize);

  let bgColor = vec3f(0.05, 0.05, 0.05);

  if (hit.x > hit.y || hit.y <= 0.0) {
    textureStore(outputTexture, pixelCoord, vec4f(bgColor, 1.0));
    return;
  }

  let tStart = max(hit.x, 0.0);
  let result = rayMarch(rayOrigin, rayDir, tStart, hit.y, uniforms.normalizedSize, uniforms.datasetSize, uniforms.useIndirection);

  // Blend with background
  let finalColor = result.rgb + bgColor * (1.0 - result.a);
  textureStore(outputTexture, pixelCoord, vec4f(finalColor, 1.0));
}
`;

// ============================================================================
// Fullscreen Blit Shader
// ============================================================================

export const blitShader = /* wgsl */ `
@group(0) @binding(0) var blitTexture: texture_2d<f32>;
@group(0) @binding(1) var blitSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  // Fullscreen triangle (oversized to cover screen)
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );

  var out: VertexOut;
  out.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  out.uv = uvs[vertexIndex];
  return out;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(blitTexture, blitSampler, uv);
}
`;

// ============================================================================
// Axis Shader
// ============================================================================

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
