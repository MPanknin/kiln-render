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
  // Returns: xyz = atlas brick offset (0-1), w = loaded flag
  let indirection = textureSampleLevel(indirectionTexture, indirectionSampler, brickCoord, 0.0);

  // If brick not loaded, return 0
  if (indirection.w < 0.5) {
    return 0.0;
  }

  // Calculate position within the brick [0, BRICK_SIZE]
  let posInBrick = voxelPos % BRICK_SIZE;

  // Calculate atlas position: brick offset + position within brick
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
