// Common constants and shared functions for volume rendering

const LOGICAL_BRICK_SIZE: f32 = 64.0;
const PHYSICAL_BRICK_SIZE: f32 = 66.0;
const ATLAS_SIZE: f32 = 528.0;
const BORDER: f32 = 1.0;
const STEPS_PER_BRICK: f32 = 24.0;
const MAX_BRICK_TRAVERSALS: u32 = 96u;
const EARLY_EXIT_ALPHA: f32 = 0.95;

const RENDER_MODE_DVR: i32 = 0;
const RENDER_MODE_MIP: i32 = 1;
const RENDER_MODE_ISO: i32 = 2;
const RENDER_MODE_LOD: i32 = 3;

// Lighting constants
const LIGHT_DIR: vec3f = vec3f(0.1, -0.8, 0.1);
const AMBIENT: f32 = 0.3;
const DIFFUSE: f32 = 0.9;
const SPECULAR: f32 = 0.3;
const SHININESS: f32 = 32.0;

// LOD level colors for debugging (lodLevel is stored as lod+1, so 1=LOD0, 2=LOD1, etc.)
fn getLodColor(lodLevel: u32) -> vec3f {
    switch(lodLevel) {
        case 1u: { return vec3f(0.0, 1.0, 0.0); }  // LOD 0 = Green (finest)
        case 2u: { return vec3f(0.5, 1.0, 0.0); }  // LOD 1 = Yellow-Green
        case 3u: { return vec3f(1.0, 1.0, 0.0); }  // LOD 2 = Yellow
        case 4u: { return vec3f(1.0, 0.5, 0.0); }  // LOD 3 = Orange
        case 5u: { return vec3f(1.0, 0.0, 0.0); }  // LOD 4 = Red
        case 6u: { return vec3f(0.5, 0.0, 0.5); }  // LOD 5 = Purple
        case 7u: { return vec3f(0.0, 0.0, 1.0); }  // LOD 6 = Blue
        case 8u: { return vec3f(0.0, 0.5, 0.5); }  // LOD 7 = Cyan
        case 9u: { return vec3f(1.0, 0.0, 0.5); }  // LOD 8 = Magenta
        case 10u: { return vec3f(0.5, 0.5, 0.5); } // LOD 9 = Gray
        case 11u: { return vec3f(0.8, 0.4, 0.2); } // LOD 10 = Brown (coarsest)
        default: { return vec3f(0.2, 0.2, 0.2); } // Not loaded = Dark gray
    }
}

// Random number generation
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

// Coordinate transformations
fn normalizedToVoxel(normalizedPos: vec3f, normalizedSize: vec3f, datasetSize: vec3f) -> vec3f {
    let unitPos = (normalizedPos / normalizedSize) + 0.5;
    return unitPos * datasetSize;
}

fn voxelToNormalized(voxelPos: vec3f, normalizedSize: vec3f, datasetSize: vec3f) -> vec3f {
    let unitPos = voxelPos / datasetSize;
    return (unitPos - 0.5) * normalizedSize;
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

fn intersectBoxInv(rayOrigin: vec3f, invDir: vec3f, boxMin: vec3f, boxMax: vec3f) -> vec2f {
    let t0 = (boxMin - rayOrigin) * invDir;
    let t1 = (boxMax - rayOrigin) * invDir;
    let tmin = min(t0, t1);
    let tmax = max(t0, t1);
    let tNear = max(max(tmin.x, tmin.y), tmin.z);
    let tFar = min(min(tmax.x, tmax.y), tmax.z);
    return vec2f(tNear, tFar);
}

// Phong lighting
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

// Window/Level (windowing) for density remapping
// Maps a sub-range of density values to the full 0-1 range for better contrast
// windowCenter: center of the window (0-1)
// windowWidth: width of the window (0-1, where 1 = full range)
// Returns density remapped to 0-1 based on window settings
fn applyWindow(density: f32, windowCenter: f32, windowWidth: f32) -> f32 {
    let halfWidth = windowWidth * 0.5;
    let minVal = windowCenter - halfWidth;
    let maxVal = windowCenter + halfWidth;
    return clamp((density - minVal) / max(windowWidth, 0.001), 0.0, 1.0);
}
