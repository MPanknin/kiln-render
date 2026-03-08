/**
 * Shader module assembly
 *
 * Combines modular WGSL shader components into complete shader programs.
 *
 * Architecture:
 * - common.wgsl: Constants, utility functions, coordinate transforms
 * - sampling.wgsl: Indirection table and atlas sampling
 * - compositing.wgsl: Front-to-back volume compositing
 * - raymarching.wgsl: Brick traversal and integration core
 * - dvr.wgsl: Direct Volume Rendering mode
 * - mip.wgsl: Maximum Intensity Projection mode
 * - iso.wgsl: Isosurface rendering mode
 * - lod-debug.wgsl: LOD visualization mode
 * - wireframe.wgsl: Proxy box wireframe
 * - axis.wgsl: RGB axis helper
 * - blit.wgsl: Fullscreen texture blit
 */

import { CONFIG } from '../core/config.js';

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

// Volume shader (fragment-based rendering with proxy box)
export const volumeShader = /* wgsl */ `
struct Uniforms {
    mvp: mat4x4f,
    inverseModel: mat4x4f,
    cameraPos: vec3f,
    useIndirection: f32,
    datasetSize: vec3f,
    renderMode: i32,
    normalizedSize: vec3f,
    isoValue: f32,
    frameIndex: u32,
    _pad1: u32,
    windowCenter: f32,
    windowWidth: f32,
    _pad2: vec2f,
    clipMin: vec3f,
    _pad3: f32,
    clipMax: vec3f,
    _pad4: f32,
}

${sharedCode}

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

${modeDispatch}

@fragment
fn fs(@location(0) modelPos: vec3f) -> @location(0) vec4f {
    let camInModel = (uniforms.inverseModel * vec4f(uniforms.cameraPos, 1.0)).xyz;
    let rayOrigin = camInModel;
    let rayDir = normalize(modelPos - camInModel);

    let halfSize = uniforms.normalizedSize * 0.5;
    let hit = intersectBox(rayOrigin, rayDir, -halfSize, halfSize);

    if (hit.x > hit.y || hit.y <= 0.0) { discard; }

    // Apply clipping planes
    let clipped = applyClippingPlanes(
        rayOrigin, rayDir, max(hit.x, 0.0), hit.y,
        uniforms.normalizedSize, uniforms.clipMin, uniforms.clipMax
    );

    if (clipped.x > clipped.y) { discard; }

    let useIndirection = uniforms.useIndirection > 0.5;
    return rayMarchMode(rayOrigin, rayDir, clipped.x, clipped.y, uniforms.normalizedSize, uniforms.datasetSize, uniforms.renderMode, uniforms.isoValue, useIndirection);
}
`;

// Compute shader (full-screen ray marching)
export const computeShader = /* wgsl */ `
struct Uniforms {
    inverseViewProj: mat4x4f,
    cameraPos: vec3f,
    useIndirection: f32,
    datasetSize: vec3f,
    renderMode: i32,
    normalizedSize: vec3f,
    isoValue: f32,
    screenSize: vec2f,
    frameIndex: u32,
    _pad3: f32,
    windowCenter: f32,
    windowWidth: f32,
    _pad4: vec2f,
    clipMin: vec3f,
    _pad5: f32,
    clipMax: vec3f,
    _pad6: f32,
}

${sharedCode}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
${sharedBindings}
@group(0) @binding(7) var outputTexture: texture_storage_2d<rgba8unorm, write>;

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
