/**
 * Generalised multiscale pyramid: per-level native dims, per-axis downsampling
 * exponent relative to level 0, physical spacing and origin. Built from OME-Zarr
 * transforms (or inferred from dims) and validated for the 1×/2× steps Kiln supports.
 */

export type Vec3 = [number, number, number];

/** Temporary rollout switch: Kiln's historical uniform 2:1 model vs. per-axis factors from metadata. */
export type PyramidPolicy = 'legacy' | 'native';

export interface PyramidLevel {
  lod: number;
  /** Native voxel dimensions [x, y, z]. */
  dims: Vec3;
  /** log2 of the downsampling factor relative to level 0, per axis. */
  exponent: Vec3;
  /** Physical voxel spacing per axis. */
  spacing: Vec3;
  /** Physical position of voxel (0,0,0) per axis, after group transforms. */
  origin: Vec3;
}

/** One level as read from metadata, all vectors in [x, y, z] order. */
export interface PyramidLevelInput {
  dims: Vec3;
  scale?: Vec3;
  translation?: Vec3;
}

export interface PyramidBuild {
  levels: PyramidLevel[];
  /** Human-readable reasons the layout is unsupported; empty when valid. */
  issues: string[];
}

const AXES = ['x', 'y', 'z'] as const;
const REL_TOLERANCE = 1e-3;

/** Build and validate a pyramid; group-level transforms compose after per-level ones. */
export function buildPyramid(inputs: PyramidLevelInput[], groupScale?: Vec3, groupTranslation?: Vec3): PyramidBuild {
  const issues: string[] = [];
  const levels: PyramidLevel[] = [];
  const first = inputs[0];
  if (!first) return { levels, issues: ['No pyramid levels'] };
  inputs.forEach((input, lod) => validateInput(input, lod, issues));
  if (issues.length > 0) return { levels, issues };

  const spacing0 = composeScale(first.scale ?? [1, 1, 1], groupScale);
  // An absent translation is the identity; no alignment is assumed for incomplete metadata
  const origin0 = composeTranslation(first.translation ?? [0, 0, 0], groupScale, groupTranslation);
  levels.push({ lod: 0, dims: first.dims, exponent: [0, 0, 0], spacing: spacing0, origin: origin0 });

  for (let lod = 1; lod < inputs.length; lod++) {
    const input = inputs[lod]!;
    const prevInput = inputs[lod - 1]!;
    const prev = levels[lod - 1]!;
    const exponent: Vec3 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const factor = stepFactor(prevInput, input, a, lod, issues);
      exponent[a] = prev.exponent[a]! + (factor === 2 ? 1 : 0);
    }
    const spacing = input.scale ? composeScale(input.scale, groupScale) : scaledSpacing(spacing0, exponent);
    const origin = composeTranslation(input.translation ?? [0, 0, 0], groupScale, groupTranslation);
    checkOrigin(origin, origin0, spacing0, exponent, lod, issues);
    levels.push({ lod, dims: input.dims, exponent, spacing, origin });
  }
  return { levels, issues };
}

/** Kiln's historical model: every level halves every axis, dims = ceil(dims0 / 2^lod), origins ignored. */
export function legacyPyramid(dims0: Vec3, spacing0: Vec3, numLevels: number): PyramidLevel[] {
  return Array.from({ length: numLevels }, (_, lod) => {
    const exponent: Vec3 = [lod, lod, lod];
    return {
      lod,
      dims: dims0.map(d => Math.ceil(d / (1 << lod))) as Vec3,
      exponent,
      spacing: scaledSpacing(spacing0, exponent),
      origin: [0, 0, 0],
    };
  });
}

/** Finest-grid voxels covered by one logical brick of this level, per axis. */
export function levelSpan(level: PyramidLevel, brickSize: number): Vec3 {
  return level.exponent.map(e => brickSize << e) as Vec3;
}

function validateInput(input: PyramidLevelInput, lod: number, issues: string[]): void {
  if (!input.dims.every(d => Number.isInteger(d) && d > 0)) {
    issues.push(`level ${lod}: dimensions must be positive integers, got [${input.dims}]`);
  }
  if (input.scale && !input.scale.every(s => Number.isFinite(s) && s > 0)) {
    issues.push(`level ${lod}: scale must be finite and positive, got [${input.scale}]`);
  }
  if (input.translation && !input.translation.every(Number.isFinite)) {
    issues.push(`level ${lod}: translation must be finite, got [${input.translation}]`);
  }
}

/** Downsampling factor of one axis between consecutive levels: 1 or 2, else an issue. */
function stepFactor(prev: PyramidLevelInput, cur: PyramidLevelInput, axis: number, lod: number, issues: string[]): 1 | 2 {
  const dPrev = prev.dims[axis]!;
  const dCur = cur.dims[axis]!;
  const halves = dCur === Math.ceil(dPrev / 2) || dCur === Math.floor(dPrev / 2);
  const same = dCur === dPrev;

  let factor: number;
  if (prev.scale && cur.scale) {
    // Both uncomposed: group transforms cancel in the ratio
    const ratio = cur.scale[axis]! / prev.scale[axis]!;
    factor = Math.round(ratio);
    if (Math.abs(ratio - factor) > REL_TOLERANCE * factor) {
      issues.push(`level ${lod} ${AXES[axis]}: scale ratio ${ratio.toFixed(4)} is not an integer factor`);
      return 1;
    }
  } else {
    factor = same ? 1 : halves ? 2 : dPrev / dCur;
  }

  if (factor !== 1 && factor !== 2) {
    const shown = Number.isInteger(factor) ? factor : factor.toFixed(2);
    issues.push(`level ${lod} ${AXES[axis]}: downsampling factor ${shown} is not supported (only 1 or 2)`);
    return 1;
  }
  if ((factor === 1 && !same) || (factor === 2 && !halves)) {
    issues.push(`level ${lod} ${AXES[axis]}: ${dCur} voxels do not match factor ${factor} of ${dPrev}`);
  }
  return factor;
}

function composeScale(scale: Vec3, group?: Vec3): Vec3 {
  return group ? scale.map((s, i) => s * group[i]!) as Vec3 : [...scale] as Vec3;
}

function composeTranslation(translation: Vec3, groupScale?: Vec3, groupTranslation?: Vec3): Vec3 {
  return translation.map((t, i) => t * (groupScale?.[i] ?? 1) + (groupTranslation?.[i] ?? 0)) as Vec3;
}

function scaledSpacing(spacing0: Vec3, exponent: Vec3): Vec3 {
  return spacing0.map((s, i) => s * (1 << exponent[i]!)) as Vec3;
}

/** Accept an unshifted origin or the box-filter half-voxel shift, (2^e − 1) / 2 fine voxels; else unsupported. */
function checkOrigin(origin: Vec3, origin0: Vec3, spacing0: Vec3, exponent: Vec3, lod: number, issues: string[]): void {
  for (let a = 0; a < 3; a++) {
    const shifted = origin0[a]! + ((1 << exponent[a]!) - 1) / 2 * spacing0[a]!;
    const tolerance = spacing0[a]! * 1e-3;
    const ok = Math.abs(origin[a]! - shifted) <= tolerance || Math.abs(origin[a]! - origin0[a]!) <= tolerance;
    if (!ok) issues.push(`level ${lod} ${AXES[a]}: translation ${origin[a]} is not a supported offset of level 0`);
  }
}
