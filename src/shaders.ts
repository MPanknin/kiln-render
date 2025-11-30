/**
 * WGSL Shaders
 */

import { CONFIG } from './config.js';

export const volumeShader = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4f,
  inverseModel: mat4x4f,
  cameraPos: vec3f,
  useIndirection: f32,
  datasetSize: vec3f,      // Dataset dimensions in voxels (e.g., 512, 512, 256)
  _pad1: f32,
  normalizedSize: vec3f,   // Normalized proxy dimensions (e.g., 1.0, 1.0, 0.5)
  _pad2: f32,
}

const BRICK_SIZE: f32 = ${CONFIG.BRICK_SIZE}.0;
const GRID_SIZE: f32 = ${CONFIG.GRID_SIZE}.0;
const ATLAS_SIZE: f32 = ${CONFIG.ATLAS_SIZE}.0;

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

// Convert normalized position to virtual voxel coordinates
fn normalizedToVoxel(normalizedPos: vec3f) -> vec3f {
  // normalizedPos is in [-0.5*normalizedSize, 0.5*normalizedSize]
  // Map to [0, datasetSize]
  let unitPos = (normalizedPos / uniforms.normalizedSize) + 0.5;  // [0, 1]
  return unitPos * uniforms.datasetSize;  // [0, datasetSize]
}

// Sample with indirection: virtual voxel position -> atlas sample
fn sampleWithIndirection(voxelPos: vec3f) -> f32 {
  // Convert voxel position to brick coordinate [0,1] for indirection lookup
  // Use dataset size to determine the virtual grid extent
  let brickCoord = voxelPos / uniforms.datasetSize;  // [0,1]

  // Sample indirection table
  // Returns: xyz = atlas brick offset (0-1), w = LOD level encoded
  // w values: 0 = not loaded, 0.25 = lod0, 0.5 = lod1, 0.75 = lod2, 1.0 = lod3
  let indirection = textureSampleLevel(indirectionTexture, indirectionSampler, brickCoord, 0.0);

  // If brick not loaded (w < 0.1), return 0
  if (indirection.w < 0.1) {
    return 0.0;
  }

  // DEBUG: Return white if brick is loaded to verify indirection works
  // return 1.0;

  // Decode LOD level from w channel: w = (lod + 1) * 51 / 255
  // lod 0 -> 51/255 = 0.2, lod 1 -> 102/255 = 0.4, lod 2 -> 153/255 = 0.6, lod 3 -> 204/255 = 0.8
  let lodLevel = round(indirection.w * 5.0) - 1.0;  // 0, 1, 2, or 3
  let lodScale = pow(2.0, lodLevel);  // 1, 2, 4, or 8

  // For LOD bricks, the entire dataset maps to one brick
  // posInBrick = (voxelPos / datasetSize) * BRICK_SIZE for LOD 3
  // More generally: position within brick = fractional position * BRICK_SIZE
  // where fractional position = how far into this brick's coverage area we are
  let brickExtent = BRICK_SIZE * lodScale;  // How many voxels this LOD brick covers
  let posInBrick = (voxelPos % brickExtent) / lodScale;  // Scale down to [0, BRICK_SIZE]

  // Calculate atlas position: brick offset + position within brick normalized to atlas
  let atlasPos = indirection.xyz + (posInBrick / ATLAS_SIZE);

  // Sample the volume atlas
  return textureSampleLevel(volumeTexture, volumeSampler, atlasPos, 0.0).r;
}

@fragment
fn fs(@location(0) modelPos: vec3f) -> @location(0) vec4f {
  let camInModel = (uniforms.inverseModel * vec4f(uniforms.cameraPos, 1.0)).xyz;
  let rayDir = normalize(modelPos - camInModel);
  let rayOrigin = camInModel;

  // Ray-box intersection for normalized proxy box
  // Box is centered at origin: [-normalizedSize/2, normalizedSize/2]
  let halfSize = uniforms.normalizedSize * 0.5;
  let invDir = 1.0 / rayDir;
  let t0 = (-halfSize - rayOrigin) * invDir;
  let t1 = (halfSize - rayOrigin) * invDir;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let tNear = max(max(tmin.x, tmin.y), tmin.z);
  let tFar = min(min(tmax.x, tmax.y), tmax.z);

  // If ray misses box or exit point is behind camera, discard
  if (tNear > tFar || tFar <= 0.0) { discard; }

  // Handle camera inside volume: start from camera (0) if entry is behind us
  let tStart = max(tNear, 0.0);

  let numSteps = 128u;
  let stepSize = (tFar - tStart) / f32(numSteps);

  var color = vec3f(0.0);
  var alpha = 0.0;

  for (var i = 0u; i < numSteps; i++) {
    let t = tStart + f32(i) * stepSize;
    let samplePos = rayOrigin + rayDir * t;  // In normalized space

    // Convert normalized position to voxel coordinates for sampling
    let voxelPos = normalizedToVoxel(samplePos);

    // Sample volume (with or without indirection)
    var density: f32;
    if (uniforms.useIndirection > 0.5) {
      density = sampleWithIndirection(voxelPos);
    } else {
      // Direct sampling: treat voxelPos as atlas coordinates
      density = textureSampleLevel(volumeTexture, volumeSampler, voxelPos / ATLAS_SIZE, 0.0).r;
    }

    if (density > 0.01) {
      let tfColor = textureSampleLevel(tfTexture, tfSampler, density, 0.0);
      // Scale alpha: stepSize is in normalized space (~0.01), scale to voxel-like range
      // Use max dataset dimension as reference scale
      let maxDim = max(uniforms.datasetSize.x, max(uniforms.datasetSize.y, uniforms.datasetSize.z));
      let sampleAlpha = tfColor.a * stepSize * maxDim * 0.3;

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

/**
 * Compute shader for raycasting
 * Dispatched per-pixel, writes to output texture
 */
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

const BRICK_SIZE: f32 = ${CONFIG.BRICK_SIZE}.0;
const GRID_SIZE: f32 = ${CONFIG.GRID_SIZE}.0;
const ATLAS_SIZE: f32 = ${CONFIG.ATLAS_SIZE}.0;

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var volumeSampler: sampler;
@group(0) @binding(2) var volumeTexture: texture_3d<f32>;
@group(0) @binding(3) var tfSampler: sampler;
@group(0) @binding(4) var tfTexture: texture_1d<f32>;
@group(0) @binding(5) var indirectionSampler: sampler;
@group(0) @binding(6) var indirectionTexture: texture_3d<f32>;
@group(0) @binding(7) var outputTexture: texture_storage_2d<rgba8unorm, write>;

// Convert normalized position to virtual voxel coordinates
fn normalizedToVoxel(normalizedPos: vec3f) -> vec3f {
  let unitPos = (normalizedPos / uniforms.normalizedSize) + 0.5;
  return unitPos * uniforms.datasetSize;
}

// Sample with indirection
fn sampleWithIndirection(voxelPos: vec3f) -> f32 {
  let brickCoord = voxelPos / uniforms.datasetSize;
  let indirection = textureSampleLevel(indirectionTexture, indirectionSampler, brickCoord, 0.0);

  if (indirection.w < 0.1) {
    return 0.0;
  }

  let lodLevel = round(indirection.w * 5.0) - 1.0;
  let lodScale = pow(2.0, lodLevel);
  let brickExtent = BRICK_SIZE * lodScale;
  let posInBrick = (voxelPos % brickExtent) / lodScale;
  let atlasPos = indirection.xyz + (posInBrick / ATLAS_SIZE);

  return textureSampleLevel(volumeTexture, volumeSampler, atlasPos, 0.0).r;
}

// Ray-box intersection
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

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let pixelCoord = vec2i(globalId.xy);
  let screenSize = vec2i(uniforms.screenSize);

  // Skip if outside screen
  if (pixelCoord.x >= screenSize.x || pixelCoord.y >= screenSize.y) {
    return;
  }

  // Calculate ray from camera through pixel
  // NDC coordinates [-1, 1]
  let ndc = vec2f(
    (f32(pixelCoord.x) + 0.5) / f32(screenSize.x) * 2.0 - 1.0,
    1.0 - (f32(pixelCoord.y) + 0.5) / f32(screenSize.y) * 2.0  // Flip Y
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
  let tNear = hit.x;
  let tFar = hit.y;

  // Background color if ray misses
  if (tNear > tFar || tFar <= 0.0) {
    textureStore(outputTexture, pixelCoord, vec4f(0.05, 0.05, 0.05, 1.0));
    return;
  }

  let tStart = max(tNear, 0.0);
  let numSteps = 128u;
  let stepSize = (tFar - tStart) / f32(numSteps);

  var color = vec3f(0.0);
  var alpha = 0.0;

  for (var i = 0u; i < numSteps; i++) {
    let t = tStart + f32(i) * stepSize;
    let samplePos = rayOrigin + rayDir * t;
    let voxelPos = normalizedToVoxel(samplePos);

    var density: f32;
    if (uniforms.useIndirection > 0.5) {
      density = sampleWithIndirection(voxelPos);
    } else {
      density = textureSampleLevel(volumeTexture, volumeSampler, voxelPos / ATLAS_SIZE, 0.0).r;
    }

    if (density > 0.01) {
      let tfColor = textureSampleLevel(tfTexture, tfSampler, density, 0.0);
      let maxDim = max(uniforms.datasetSize.x, max(uniforms.datasetSize.y, uniforms.datasetSize.z));
      let sampleAlpha = tfColor.a * stepSize * maxDim * 0.3;

      color += tfColor.rgb * sampleAlpha * (1.0 - alpha);
      alpha += sampleAlpha * (1.0 - alpha);

      if (alpha > 0.95) { break; }
    }
  }

  // Blend with background
  let bgColor = vec3f(0.05, 0.05, 0.05);
  let finalColor = color + bgColor * (1.0 - alpha);

  textureStore(outputTexture, pixelCoord, vec4f(finalColor, 1.0));
}
`;

/**
 * Fullscreen blit shader - draws the compute output to screen
 */
export const blitShader = /* wgsl */ `
@group(0) @binding(0) var blitTexture: texture_2d<f32>;
@group(0) @binding(1) var blitSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  // Fullscreen triangle
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
