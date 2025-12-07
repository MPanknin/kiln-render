/**
 * WGSL Shaders
 */

import { CONFIG } from './config.js';

const sharedConstants = /* wgsl */ `
const LOGICAL_BRICK_SIZE: f32 = 64.0;
const PHYSICAL_BRICK_SIZE: f32 = 66.0;
const ATLAS_SIZE: f32 = ${CONFIG.ATLAS_SIZE}.0;
const BORDER: f32 = 1.0;
const STEPS_PER_BRICK: f32 = 32.0;
const MAX_BRICK_TRAVERSALS: u32 = 64u;
const EARLY_EXIT_ALPHA: f32 = 0.95;

const RENDER_MODE_DVR: i32 = 0;
const RENDER_MODE_MIP: i32 = 1;
const RENDER_MODE_ISO: i32 = 2;
const RENDER_MODE_LOD: i32 = 3;

// LOD level colors for debugging (lodLevel is stored as lod+1, so 1=LOD0, 2=LOD1, etc.)
fn getLodColor(lodLevel: u32) -> vec3f {
    switch(lodLevel) {
        case 1u: { return vec3f(0.0, 1.0, 0.0); }  // LOD 0 = Green (finest)
        case 2u: { return vec3f(0.5, 1.0, 0.0); }  // LOD 1 = Yellow-Green
        case 3u: { return vec3f(1.0, 1.0, 0.0); }  // LOD 2 = Yellow
        case 4u: { return vec3f(1.0, 0.5, 0.0); }  // LOD 3 = Orange
        case 5u: { return vec3f(1.0, 0.0, 0.0); }  // LOD 4 = Red (coarsest)
        case 6u: { return vec3f(0.5, 0.0, 0.5); }  // LOD 5 = Purple
        default: { return vec3f(0.2, 0.2, 0.2); } // Not loaded = Dark gray
    }
}

const LIGHT_DIR: vec3f = vec3f(0.5, -0.8, 0.3);
const AMBIENT: f32 = 0.2;
const DIFFUSE: f32 = 0.7;
const SPECULAR: f32 = 0.3;
const SHININESS: f32 = 32.0;
`;

const sharedBindings = /* wgsl */ `
@group(0) @binding(1) var volumeSampler: sampler;
@group(0) @binding(2) var volumeTexture: texture_3d<f32>;
@group(0) @binding(3) var tfSampler: sampler;
@group(0) @binding(4) var tfTexture: texture_1d<f32>;
@group(0) @binding(6) var indirectionTexture: texture_3d<u32>;
`;

const sharedFunctions = /* wgsl */ `
fn hash(n: u32) -> u32 {
    var x = n;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = (x >> 16u) ^ x;
    return x;
}

fn rand(seed: u32) -> f32 {
    return f32(hash(seed)) / f32(0xffffffffu);
}

fn rayToSeed(rayDir: vec3f) -> u32 {
    let x = u32((rayDir.x + 1.0) * 32768.0);
    let y = u32((rayDir.y + 1.0) * 32768.0);
    let z = u32((rayDir.z + 1.0) * 32768.0);
    return x + y * 65536u + z * 17u;
}

fn normalizedToVoxel(normalizedPos: vec3f, normalizedSize: vec3f, datasetSize: vec3f) -> vec3f {
    let unitPos = (normalizedPos / normalizedSize) + 0.5;
    return unitPos * datasetSize;
}

fn voxelToNormalized(voxelPos: vec3f, normalizedSize: vec3f, datasetSize: vec3f) -> vec3f {
    let unitPos = voxelPos / datasetSize;
    return (unitPos - 0.5) * normalizedSize;
}

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

fn intersectBoxInv(rayOrigin: vec3f, invDir: vec3f, boxMin: vec3f, boxMax: vec3f) -> vec2f {
    let t0 = (boxMin - rayOrigin) * invDir;
    let t1 = (boxMax - rayOrigin) * invDir;
    let tmin = min(t0, t1);
    let tmax = max(t0, t1);
    let tNear = max(max(tmin.x, tmin.y), tmin.z);
    let tFar = min(min(tmax.x, tmax.y), tmax.z);
    return vec2f(tNear, tFar);
}

fn lookupIndirection(brickIndex: vec3f) -> vec4u {
    // Use textureLoad for exact integer lookup (no interpolation)
    return textureLoad(indirectionTexture, vec3i(brickIndex), 0);
}

fn getLodScale(indirection: vec4u) -> f32 {
    // w channel stores lod+1 (0 = not loaded, 1-4 = lod 0-3)
    let lodLevel = f32(indirection.w) - 1.0;
    return exp2(lodLevel);
}

fn sampleAtlas(voxelPos: vec3f, indirection: vec4u, lodScale: f32) -> f32 {
    // Position within the logical brick [0, LOGICAL_BRICK_SIZE)
    let posInBrick = (voxelPos % (LOGICAL_BRICK_SIZE * lodScale)) / lodScale;
    // Compute atlas base from integer slot indices (exact, no precision loss)
    let atlasBase = vec3f(indirection.xyz) * PHYSICAL_BRICK_SIZE / ATLAS_SIZE;
    // Offset by BORDER to skip the border voxel, add 0.5 to sample voxel centers
    let atlasPos = atlasBase + ((posInBrick + BORDER + 0.5) / ATLAS_SIZE);
    return textureSampleLevel(volumeTexture, volumeSampler, atlasPos, 0.0).r;
}

// Direct atlas sampling without indirection (for debugging)
fn sampleDirect(voxelPos: vec3f, datasetSize: vec3f) -> f32 {
    let atlasPos = voxelPos / ATLAS_SIZE;
    return textureSampleLevel(volumeTexture, volumeSampler, atlasPos, 0.0).r;
}

fn composeSampleWithColor(density: f32, stepSize: f32, maxDim: f32, sampleColor: vec4f, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
    if (density > 0.01) {
        let extinction = sampleColor.a * stepSize * maxDim * 0.5;
        let sampleAlpha = 1.0 - exp(-extinction);
        *color += sampleColor.rgb * sampleAlpha * (1.0 - *alpha);
        *alpha += sampleAlpha * (1.0 - *alpha);
    }
}

fn composeSample(density: f32, stepSize: f32, maxDim: f32, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
    if (density > 0.01) {
        let tfColor = textureSampleLevel(tfTexture, tfSampler, density, 0.0);
        let extinction = tfColor.a * stepSize * maxDim * 0.5;
        let sampleAlpha = 1.0 - exp(-extinction);
        *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
        *alpha += sampleAlpha * (1.0 - *alpha);
    }
}

fn sampleWithIndirection(voxelPos: vec3f) -> f32 {
    let brickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);
    let indirection = lookupIndirection(brickIndex);
    if (indirection.w == 0u) { return 0.0; }
    let lodScale = getLodScale(indirection);
    return sampleAtlas(voxelPos, indirection, lodScale);
}

fn computeGradient(voxelPos: vec3f, indirection: vec4u, lodScale: f32) -> vec3f {
    // Use per-sample indirection lookup to handle brick boundaries correctly
    let h = lodScale;
    let dx = sampleWithIndirection(voxelPos + vec3f(h, 0.0, 0.0)) -
             sampleWithIndirection(voxelPos - vec3f(h, 0.0, 0.0));
    let dy = sampleWithIndirection(voxelPos + vec3f(0.0, h, 0.0)) -
             sampleWithIndirection(voxelPos - vec3f(0.0, h, 0.0));
    let dz = sampleWithIndirection(voxelPos + vec3f(0.0, 0.0, h)) -
             sampleWithIndirection(voxelPos - vec3f(0.0, 0.0, h));
    return vec3f(dx, dy, dz);
}

fn phongLighting(normal: vec3f, viewDir: vec3f, baseColor: vec3f) -> vec3f {
    let N = normalize(normal);
    let L = normalize(LIGHT_DIR);
    let V = normalize(viewDir);
    let R = reflect(-L, N);
    let ambient = AMBIENT * baseColor;
    let diffuse = DIFFUSE * max(dot(N, L), 0.0) * baseColor;
    let specular = SPECULAR * pow(max(dot(R, V), 0.0), SHININESS) * vec3f(1.0);
    return ambient + diffuse + specular;
}

fn refineIsoSurface(
    rayOrigin: vec3f, rayDir: vec3f, tLow: f32, tHigh: f32, isoValue: f32,
    normalizedSize: vec3f, datasetSize: vec3f, indirection: vec4u, lodScale: f32
) -> f32 {
    var lo = tLow;
    var hi = tHigh;
    for (var i = 0u; i < 4u; i++) {
        let mid = (lo + hi) * 0.5;
        let pos = rayOrigin + rayDir * mid;
        let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
        let density = sampleAtlas(voxel, indirection, lodScale);
        if (density >= isoValue) { hi = mid; } else { lo = mid; }
    }
    return (lo + hi) * 0.5;
}

struct BrickInfo {
    indirection: vec4u,
    lodScale: f32,
    tEnd: f32,
    numSteps: u32,
    stepSize: f32,
    valid: bool,
}

fn setupBrick(
    rayOrigin: vec3f, rayDir: vec3f, invDir: vec3f, t: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> BrickInfo {
    var info: BrickInfo;

    let samplePos = rayOrigin + rayDir * t;
    let voxelPos = normalizedToVoxel(samplePos, normalizedSize, datasetSize);
    let brickIndex = floor(voxelPos / LOGICAL_BRICK_SIZE);

    let brickMinVoxel = brickIndex * LOGICAL_BRICK_SIZE;
    let brickMaxVoxel = brickMinVoxel + LOGICAL_BRICK_SIZE;
    let brickMinWorld = voxelToNormalized(brickMinVoxel, normalizedSize, datasetSize);
    let brickMaxWorld = voxelToNormalized(brickMaxVoxel, normalizedSize, datasetSize);

    let tBrick = intersectBoxInv(rayOrigin, invDir, brickMinWorld, brickMaxWorld);
    info.tEnd = min(tBrick.y, tEnd);

    info.indirection = lookupIndirection(brickIndex);
    info.valid = info.indirection.w > 0u;  // w=0 means not loaded

    if (info.valid) {
        info.lodScale = getLodScale(info.indirection);
        let brickLength = info.tEnd - t;
        let brickWorldSize = length(brickMaxWorld - brickMinWorld);
        info.numSteps = max(1u, u32(STEPS_PER_BRICK * brickLength / brickWorldSize));
        info.stepSize = brickLength / f32(info.numSteps);
    }

    return info;
}

// Simple ray march without brick traversal (direct atlas sampling)
fn rayMarchSimple(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f
) -> vec4f {
    let maxDim = max(datasetSize.x, max(datasetSize.y, datasetSize.z));
    let rayLength = tEnd - tStart;
    let numSteps = 256u;
    let stepSize = rayLength / f32(numSteps);

    var color = vec3f(0.0);
    var alpha = 0.0;

    for (var i = 0u; i < numSteps; i++) {
        let t = tStart + f32(i) * stepSize;
        let pos = rayOrigin + rayDir * t;
        let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
        let density = sampleDirect(voxel, datasetSize);
        composeSample(density, stepSize, maxDim, &color, &alpha);
        if (alpha > EARLY_EXIT_ALPHA) { break; }
    }

    return vec4f(color, alpha);
}

fn rayMarchMode(
    rayOrigin: vec3f, rayDir: vec3f, tStart: f32, tEnd: f32,
    normalizedSize: vec3f, datasetSize: vec3f, renderMode: i32, isoValue: f32,
    useIndirection: bool
) -> vec4f {
    // Direct atlas sampling (no indirection) for debugging
    if (!useIndirection) {
        return rayMarchSimple(rayOrigin, rayDir, tStart, tEnd, normalizedSize, datasetSize);
    }

    let maxDim = max(datasetSize.x, max(datasetSize.y, datasetSize.z));
    let invDir = 1.0 / rayDir;

    var color = vec3f(0.0);
    var alpha = 0.0;
    var maxDensity = 0.0;
    var prevDensity = 0.0;
    var prevT = tStart;
    var t = tStart;

    for (var brickIter = 0u; brickIter < MAX_BRICK_TRAVERSALS; brickIter++) {
        if (t >= tEnd) { break; }
        if (renderMode == RENDER_MODE_DVR && alpha > EARLY_EXIT_ALPHA) { break; }

        let brick = setupBrick(rayOrigin, rayDir, invDir, t, tEnd, normalizedSize, datasetSize);

        if (!brick.valid) {
            t = brick.tEnd + 0.0001;
            if (renderMode == RENDER_MODE_ISO) { prevDensity = 0.0; }
            continue;
        }

        let jitter = rand(rayToSeed(rayDir) + brickIter) * brick.stepSize;
        var tSample = t + jitter;

        for (var i = 0u; i < brick.numSteps; i++) {
            let pos = rayOrigin + rayDir * tSample;
            let voxel = normalizedToVoxel(pos, normalizedSize, datasetSize);
            let density = sampleAtlas(voxel, brick.indirection, brick.lodScale);

            if (renderMode == RENDER_MODE_DVR) {
                composeSample(density, brick.stepSize, maxDim, &color, &alpha);
                if (alpha > EARLY_EXIT_ALPHA) { break; }
            } else if (renderMode == RENDER_MODE_LOD) {
                // LOD visualization: use LOD color with TF opacity
                let tfColor = textureSampleLevel(tfTexture, tfSampler, density, 0.0);
                let lodColor = getLodColor(brick.indirection.w);
                composeSampleWithColor(density, brick.stepSize, maxDim, vec4f(lodColor, tfColor.a), &color, &alpha);
                if (alpha > EARLY_EXIT_ALPHA) { break; }
            } else if (renderMode == RENDER_MODE_MIP) {
                maxDensity = max(maxDensity, density);
            } else if (renderMode == RENDER_MODE_ISO) {
                if (prevDensity < isoValue && density >= isoValue) {
                    let tSurface = refineIsoSurface(
                        rayOrigin, rayDir, prevT, tSample, isoValue,
                        normalizedSize, datasetSize, brick.indirection, brick.lodScale
                    );
                    let surfacePos = rayOrigin + rayDir * tSurface;
                    let surfaceVoxel = normalizedToVoxel(surfacePos, normalizedSize, datasetSize);
                    let gradient = computeGradient(surfaceVoxel, brick.indirection, brick.lodScale);

                    if (length(gradient) >= 0.001) {
                        let normal = -normalize(gradient);
                        let tfColor = textureSampleLevel(tfTexture, tfSampler, isoValue, 0.0);
                        return vec4f(phongLighting(normal, -rayDir, tfColor.rgb), 1.0);
                    }
                }
                prevDensity = density;
                prevT = tSample;
            }

            tSample += brick.stepSize;
        }

        t = brick.tEnd + 0.0001;
    }

    if (renderMode == RENDER_MODE_MIP) {
        let tfColor = textureSampleLevel(tfTexture, tfSampler, maxDensity, 0.0);
        return vec4f(tfColor.rgb * maxDensity, 1.0);
    }

    return vec4f(color, alpha);
}
`;

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
    _pad2: u32,
    _pad3: u32,
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

    let halfSize = uniforms.normalizedSize * 0.5;
    let hit = intersectBox(rayOrigin, rayDir, -halfSize, halfSize);

    if (hit.x > hit.y || hit.y <= 0.0) { discard; }

    let tStart = max(hit.x, 0.0);
    let useIndirection = uniforms.useIndirection > 0.5;
    return rayMarchMode(rayOrigin, rayDir, tStart, hit.y, uniforms.normalizedSize, uniforms.datasetSize, uniforms.renderMode, uniforms.isoValue, useIndirection);
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

    let tStart = max(hit.x, 0.0);
    let useIndirection = uniforms.useIndirection > 0.5;
    let result = rayMarchMode(rayOrigin, rayDir, tStart, hit.y, uniforms.normalizedSize, uniforms.datasetSize, uniforms.renderMode, uniforms.isoValue, useIndirection);

    let finalColor = result.rgb + bgColor * (1.0 - result.a);
    textureStore(outputTexture, pixelCoord, vec4f(finalColor, 1.0));
}
`;

export const blitShader = /* wgsl */ `
@group(0) @binding(0) var blitTexture: texture_2d<f32>;
@group(0) @binding(1) var blitSampler: sampler;

struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
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
