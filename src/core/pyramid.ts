/**
 * Generalised multiscale pyramid: per-level native dims, per-axis downsampling
 * exponent relative to level 0, physical spacing and origin. Built from OME-Zarr
 * transforms (or inferred from dims) and validated for the 1×/2× steps Kiln supports.
 */

export type Vec3 = [number, number, number];

export interface PyramidLevel {
  lod: number;
  /** Native voxel dimensions [x, y, z]. */
  dims: Vec3;
  /** log2 of the downsampling factor relative to level 0, per axis. */
  exponent: Vec3;
  /** Physical voxel spacing per axis. */
  spacing: Vec3;
  /** Physical position of voxel (0,0,0)'s centre per axis. */
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

  const spacing0 = composeScale(first.scale ?? [1, 1, 1], groupScale);
  const origin0 = composeTranslation(first.translation ?? [0, 0, 0], groupScale, groupTranslation);
  levels.push({ lod: 0, dims: first.dims, exponent: [0, 0, 0], spacing: spacing0, origin: origin0 });

  for (let lod = 1; lod < inputs.length; lod++) {
    const input = inputs[lod]!;
    const prev = levels[lod - 1]!;
    const exponent: Vec3 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const factor = stepFactor(prev, input, a, lod, issues);
      exponent[a] = prev.exponent[a]! + (factor === 2 ? 1 : 0);
    }
    const spacing = input.scale ? composeScale(input.scale, groupScale) : scaledSpacing(spacing0, exponent);
    const origin = input.translation
      ? composeTranslation(input.translation, groupScale, groupTranslation)
      : expectedOrigin(origin0, spacing0, exponent);
    checkOrigin(origin, origin0, spacing0, exponent, lod, issues);
    levels.push({ lod, dims: input.dims, exponent, spacing, origin });
  }
  return { levels, issues };
}

/** Kiln's historical model: every level halves every axis, dims = ceil(dims0 / 2^lod). */
export function legacyPyramid(dims0: Vec3, spacing0: Vec3, numLevels: number): PyramidLevel[] {
  return Array.from({ length: numLevels }, (_, lod) => {
    const exponent: Vec3 = [lod, lod, lod];
    return {
      lod,
      dims: dims0.map(d => Math.ceil(d / (1 << lod))) as Vec3,
      exponent,
      spacing: scaledSpacing(spacing0, exponent),
      origin: expectedOrigin([0, 0, 0], spacing0, exponent),
    };
  });
}

/** Finest-grid voxels covered by one logical brick of this level, per axis. */
export function levelSpan(level: PyramidLevel, brickSize: number): Vec3 {
  return level.exponent.map(e => brickSize << e) as Vec3;
}

/** Downsampling factor of one axis between two consecutive levels: 1 or 2, else an issue. */
function stepFactor(prev: PyramidLevel, input: PyramidLevelInput, axis: number, lod: number, issues: string[]): 1 | 2 {
  const dPrev = prev.dims[axis]!;
  const dCur = input.dims[axis]!;
  const halves = dCur === Math.ceil(dPrev / 2) || dCur === Math.floor(dPrev / 2);
  const same = dCur === dPrev;

  let factor: number;
  if (input.scale) {
    const ratio = input.scale[axis]! / prev.spacing[axis]!;
    factor = Math.round(ratio);
    if (Math.abs(ratio - factor) > REL_TOLERANCE * factor) {
      issues.push(`level ${lod} ${AXES[axis]}: scale ratio ${ratio.toFixed(4)} is not an integer factor`);
      return 1;
    }
  } else {
    factor = same ? 1 : halves ? 2 : 0;
  }

  if (factor !== 1 && factor !== 2) {
    issues.push(`level ${lod} ${AXES[axis]}: downsampling factor ${factor} is not supported (only 1 or 2)`);
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

/** Origin of a box-downsampled level: shifted by half of the extra footprint, (2^e − 1) / 2 voxels. */
function expectedOrigin(origin0: Vec3, spacing0: Vec3, exponent: Vec3): Vec3 {
  return origin0.map((o, i) => o + ((1 << exponent[i]!) - 1) / 2 * spacing0[i]!) as Vec3;
}

/** Accept either the box-filter half-voxel shift or an unshifted origin; anything else is unsupported. */
function checkOrigin(origin: Vec3, origin0: Vec3, spacing0: Vec3, exponent: Vec3, lod: number, issues: string[]): void {
  const shifted = expectedOrigin(origin0, spacing0, exponent);
  for (let a = 0; a < 3; a++) {
    const tolerance = spacing0[a]! * 1e-3;
    const ok = Math.abs(origin[a]! - shifted[a]!) <= tolerance || Math.abs(origin[a]! - origin0[a]!) <= tolerance;
    if (!ok) issues.push(`level ${lod} ${AXES[a]}: translation ${origin[a]} is not a supported offset of level 0`);
  }
}
