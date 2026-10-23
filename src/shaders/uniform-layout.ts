/** Single source of truth for WGSL uniform struct layouts. */

type WGSLType =
  | 'f32' | 'u32' | 'i32'
  | 'vec2f' | 'vec3f' | 'vec4f'
  | 'mat4x4f'
  | `array<vec4f, ${number}>`;

interface UniformLayout<T extends string> {
  /** WGSL struct body text (indented field lines) */
  fields: string;
  /** Byte offset of each field (keyed by field name) */
  offsets: Record<T, number>;
  /** Total struct size in bytes (rounded to max alignment) */
  size: number;
}

function typeInfo(type: WGSLType): { size: number; align: number } {
  switch (type) {
    case 'f32': case 'u32': case 'i32':
      return { size: 4, align: 4 };
    case 'vec2f':
      return { size: 8, align: 8 };
    case 'vec3f':
      return { size: 12, align: 16 };
    case 'vec4f':
      return { size: 16, align: 16 };
    case 'mat4x4f':
      return { size: 64, align: 16 };
    default: {
      const m = type.match(/^array<vec4f, (\d+)>$/);
      if (!m) throw new Error(`Unknown WGSL type: ${type}`);
      return { size: 16 * Number(m[1]), align: 16 };
    }
  }
}

function alignUp(offset: number, align: number): number {
  return (offset + align - 1) & ~(align - 1);
}

function defineUniformStruct<T extends string>(
  fields: { name: T; type: WGSLType }[]
): UniformLayout<T> {
  let offset = 0;
  let maxAlign = 0;
  const offsets = {} as Record<T, number>;
  const lines: string[] = [];

  for (const { name, type } of fields) {
    const info = typeInfo(type);
    offset = alignUp(offset, info.align);
    offsets[name] = offset;
    lines.push(`    ${name}: ${type},`);
    offset += info.size;
    maxAlign = Math.max(maxAlign, info.align);
  }

  // Struct total size rounds up to max member alignment
  offset = alignUp(offset, maxAlign);

  return { fields: lines.join('\n'), offsets, size: offset };
}

/** Per-level scale table length; datasets with more levels are rejected at load. */
export const MAX_LOD_LEVELS = 12;

// ---------------------------------------------------------------------------
// Compute shader uniforms (480 bytes)
// ---------------------------------------------------------------------------
export const COMPUTE_UNIFORMS = defineUniformStruct([
  { name: 'inverseViewProj', type: 'mat4x4f' },
  { name: 'cameraPos',       type: 'vec3f' },
  { name: 'useIndirection',  type: 'f32' },
  { name: 'datasetSize',     type: 'vec3f' },
  { name: 'renderMode',      type: 'i32' },
  { name: 'normalizedSize',  type: 'vec3f' },
  { name: 'isoValue',        type: 'f32' },
  { name: 'screenSize',      type: 'vec2f' },
  { name: 'frameIndex',      type: 'u32' },
  { name: 'jitter',          type: 'u32' },
  { name: 'windowCenter',    type: 'f32' },
  { name: 'windowWidth',     type: 'f32' },
  { name: 'floatMin',        type: 'f32' },
  { name: 'floatMax',        type: 'f32' },
  { name: 'clipMin',         type: 'vec3f' },
  { name: 'densityScale',    type: 'f32' },
  { name: 'clipMax',         type: 'vec3f' },
  { name: 'numChannels',     type: 'u32' },
  { name: 'channelColors',   type: 'array<vec4f, 4>' },
  { name: 'channelWindowCenter', type: 'vec4f' },
  { name: 'channelWindowWidth',  type: 'vec4f' },
  { name: 'lodScales',       type: `array<vec4f, ${MAX_LOD_LEVELS}>` },
  { name: 'shading',         type: 'f32' },
  { name: 'gradientOpacity', type: 'f32' },
  { name: 'orthographic',    type: 'u32' },
  // Pixel whose first label hit is recorded for picking; negative: none
  { name: 'pickPixel',       type: 'vec2f' },
]);

// ---------------------------------------------------------------------------
// Label layer uniforms (144 bytes), shared by the compute and slice shaders
// ---------------------------------------------------------------------------
/** Label layers shown at once; each has a row of entries and a slot in LABEL_UNIFORMS.layers. */
export const MAX_LABEL_LAYERS = 8;

export const LABEL_UNIFORMS = defineUniformStruct([
  { name: 'layerCount',      type: 'u32' },
  // Image atlas slots and slots per axis, to index entries by slot
  { name: 'atlasSlots',      type: 'u32' },
  { name: 'atlasGrid',       type: 'u32' },
  // Label pool slots per axis in x and y (it grows in z)
  { name: 'poolGrid',        type: 'u32' },
  // Per layer: opacity, 3D style (0 off, 1 surface, 2 tint), slice style (0 off, 1 fill, 2 outline, 3 both), unused
  { name: 'layers',          type: `array<vec4f, ${MAX_LABEL_LAYERS}>` },
]);

// ---------------------------------------------------------------------------
// Slice planes uniforms (432 bytes)
// ---------------------------------------------------------------------------
export const SLICE_UNIFORMS = defineUniformStruct([
  { name: 'mvp',             type: 'mat4x4f' },
  { name: 'normalizedSize',  type: 'vec3f' },
  { name: 'datasetSize',     type: 'vec3f' },
  { name: 'windowCenter',    type: 'f32' },
  { name: 'windowWidth',     type: 'f32' },
  { name: 'floatMin',        type: 'f32' },
  { name: 'floatMax',        type: 'f32' },
  { name: 'slicePositions',  type: 'vec3f' },
  { name: 'sliceXEnabled',   type: 'u32' },
  { name: 'sliceYEnabled',   type: 'u32' },
  { name: 'sliceZEnabled',   type: 'u32' },
  { name: 'numChannels',     type: 'u32' },
  { name: 'lodDebug',        type: 'u32' },
  { name: 'channelColors',   type: 'array<vec4f, 4>' },
  { name: 'channelWindowCenter', type: 'vec4f' },
  { name: 'channelWindowWidth',  type: 'vec4f' },
  { name: 'lodScales',       type: `array<vec4f, ${MAX_LOD_LEVELS}>` },
]);
