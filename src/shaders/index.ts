/**
 * Shader module assembly — combines modular WGSL components into
 * complete shader programs (compute, blit, overlays).
 */

import { CONFIG } from '../core/config.js';
import { COMPUTE_UNIFORMS, SLICE_UNIFORMS } from './uniform-layout.js';

// Import WGSL shader sources
import commonWGSL from './common.wgsl?raw';
import samplingWGSL from './sampling.wgsl?raw';
import compositingWGSL from './compositing.wgsl?raw';
import raymarchingWGSL from './raymarching.wgsl?raw';
import dvrWGSL from './dvr.wgsl?raw';
import mipWGSL from './mip.wgsl?raw';
import isoWGSL from './iso.wgsl?raw';
import lodDebugWGSL from './lod-debug.wgsl?raw';
import wireframeWGSL from './wireframe.wgsl?raw';
import axisWGSL from './axis.wgsl?raw';
import blitWGSL from './blit.wgsl?raw';
import accumulateWGSL from './accumulate.wgsl?raw';
import slicePlanesWGSL from './slice-planes.wgsl?raw';

// Inject all rendering constants from config into shader source
function injectConfig(shader: string): string {
  return shader
    .replace(/LOGICAL_BRICK_SIZE: f32 = \d+\.0/, `LOGICAL_BRICK_SIZE: f32 = ${CONFIG.LOGICAL_BRICK_SIZE}.0`)
    .replace(/PHYSICAL_BRICK_SIZE: f32 = \d+\.0/, `PHYSICAL_BRICK_SIZE: f32 = ${CONFIG.PHYSICAL_BRICK_SIZE}.0`)
    .replace(/ATLAS_SIZE: f32 = \d+\.0/, `ATLAS_SIZE: f32 = ${CONFIG.ATLAS_SIZE}.0`)
    .replace(/MAX_BRICK_TRAVERSALS: u32 = \d+u/, `MAX_BRICK_TRAVERSALS: u32 = ${CONFIG.MAX_BRICK_TRAVERSALS}u`);
}

// Shared bindings used by volume shaders
const sharedBindings = /* wgsl */ `
@group(0) @binding(1) var volumeSampler: sampler;
@group(0) @binding(2) var volumeTexture: texture_3d<f32>;
@group(0) @binding(3) var tfSampler: sampler;
@group(0) @binding(4) var tfTexture: texture_2d<f32>;
@group(0) @binding(6) var indirectionTexture: texture_3d<u32>;
@group(0) @binding(8) var volumeTexture1: texture_3d<f32>;
@group(0) @binding(9) var volumeTexture2: texture_3d<f32>;
@group(0) @binding(10) var volumeTexture3: texture_3d<f32>;
`;

// Assemble the common shader code
const sharedCode = [
  injectConfig(commonWGSL),
  samplingWGSL,
  compositingWGSL,
  raymarchingWGSL,
].join('\n');

// Mode dispatch function (calls appropriate render mode)
const modeDispatch = /* wgsl */ `
${dvrWGSL}
${mipWGSL}
${isoWGSL}
${lodDebugWGSL}

fn rayMarchMode(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f, renderMode: i32, isoValue: f32,
    useIndirection: bool
) -> vec4f {
    // Direct atlas sampling (no indirection) for debugging
    if (!useIndirection) {
        return rayMarchSimple(rayOrigin, rayDir, tStart, tEnd, normalizedSize, datasetSize);
    }

    if (renderMode == RENDER_MODE_MIP) {
        return rayMarchMIP(rayOrigin, rayDir, tStart, tEnd, normalizedSize, datasetSize);
    } else if (renderMode == RENDER_MODE_ISO) {
        return rayMarchISO(rayOrigin, rayDir, tStart, tEnd, normalizedSize, datasetSize, isoValue);
    } else if (renderMode == RENDER_MODE_LOD) {
        return rayMarchLOD(rayOrigin, rayDir, tStart, tEnd, normalizedSize, datasetSize);
    } else {
        return rayMarchDVR(rayOrigin, rayDir, tStart, tEnd, normalizedSize, datasetSize);
    }
}
`;

// Compute shader (full-screen ray marching)
export const computeShader = /* wgsl */ `
struct Uniforms {
${COMPUTE_UNIFORMS.fields}
}

${sharedCode}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${sharedBindings}
@group(0) @binding(7) var outputTexture: texture_storage_2d<rgba16float, write>;

${modeDispatch}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    let pixelCoord = vec2i(globalId.xy);
    let screenSize = vec2i(uniforms.screenSize);

    if (pixelCoord.x >= screenSize.x || pixelCoord.y >= screenSize.y) { return; }

    let ndc = vec2f(
        (f32(pixelCoord.x) + 0.5) / f32(screenSize.x) * 2.0 - 1.0,
        1.0 - (f32(pixelCoord.y) + 0.5) / f32(screenSize.y) * 2.0
    );

    let nearPoint = uniforms.inverseViewProj * vec4f(ndc, -1.0, 1.0);
    let farPoint = uniforms.inverseViewProj * vec4f(ndc, 1.0, 1.0);
    let near = nearPoint.xyz / nearPoint.w;
    let far = farPoint.xyz / farPoint.w;

    let rayOrigin = uniforms.cameraPos;
    let rayDir = normalize(far - near);

    let halfSize = uniforms.normalizedSize * 0.5;
    let hit = intersectBox(rayOrigin, rayDir, -halfSize, halfSize);

    let bgColor = vec3f(0.05, 0.05, 0.05);

    if (hit.x > hit.y || hit.y <= 0.0) {
        textureStore(outputTexture, pixelCoord, vec4f(bgColor, 1.0));
        return;
    }

    // Apply clipping planes
    let clipped = applyClippingPlanes(
        rayOrigin, rayDir, max(hit.x, 0.0), hit.y,
        uniforms.normalizedSize, uniforms.clipMin, uniforms.clipMax
    );

    if (clipped.x > clipped.y) {
        textureStore(outputTexture, pixelCoord, vec4f(bgColor, 1.0));
        return;
    }

    let useIndirection = uniforms.useIndirection > 0.5;
    let result = rayMarchMode(rayOrigin, rayDir, clipped.x, clipped.y, uniforms.normalizedSize, uniforms.datasetSize, uniforms.renderMode, uniforms.isoValue, useIndirection);

    let finalColor = result.rgb + bgColor * (1.0 - result.a);
    textureStore(outputTexture, pixelCoord, vec4f(finalColor, 1.0));
}
`;

// Re-export simple shaders directly
export const wireframeShader = wireframeWGSL;
export const axisShader = axisWGSL;
export const blitShader = blitWGSL;
export const accumulateShader = accumulateWGSL;

// Slice planes shader: axis-aligned cross-sections through the volume
export const slicePlanesShader = [
  `struct Uniforms {\n${SLICE_UNIFORMS.fields}\n}`,
  `@group(0) @binding(0) var<uniform> uniforms: Uniforms;`,
  sharedBindings,
  injectConfig(commonWGSL),
  samplingWGSL,
  slicePlanesWGSL,
].join('\n');
