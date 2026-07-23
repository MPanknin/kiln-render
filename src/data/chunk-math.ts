/** Zarr chunk-range math for assembleBrick: which chunks a brick's fetch
 *  touches, and the LUT clamp keeping per-voxel assembly in range. */

export interface LodChunkParams {
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  actualDimX: number;
  actualDimY: number;
  actualDimZ: number;
  csx: number;
  csy: number;
  csz: number;
}

export interface ChunkRange {
  minCx: number;
  maxCx: number;
  minCy: number;
  maxCy: number;
  minCz: number;
  maxCz: number;
}

export interface BrickChunkFootprint extends ChunkRange {
  /** Virtual-space voxel origin (pre-chunk-mapping) — assembleBrick reuses
   *  these for its per-axis LUTs, so they're returned rather than recomputed. */
  vStartX: number;
  vStartY: number;
  vStartZ: number;
}

/** Which Zarr chunks a virtual brick's fetch touches, in this LOD's actual
 *  (downsampled) array space. `logicalSize`/`physSize` are LOGICAL_BRICK_SIZE/
 *  PHYSICAL_BRICK_SIZE (66³ physical brick, 1-voxel ghost border on each side). */
export function computeBrickChunkFootprint(
  params: LodChunkParams,
  bx: number,
  by: number,
  bz: number,
  logicalSize: number,
  physSize: number,
): BrickChunkFootprint {
  const vStartX = bx * logicalSize - 1;
  const vStartY = by * logicalSize - 1;
  const vStartZ = bz * logicalSize - 1;

  const aStartX = Math.max(0, Math.floor(Math.max(0, vStartX) * params.scaleX));
  const aStartY = Math.max(0, Math.floor(Math.max(0, vStartY) * params.scaleY));
  const aStartZ = Math.max(0, Math.floor(Math.max(0, vStartZ) * params.scaleZ));
  // round(), not floor() — must match clampedLutEntry's per-voxel rounding, or
  // the last voxel's true chunk can fall one past maxC and get clamped to the wrong voxel.
  const aEndX = Math.min(params.actualDimX - 1, Math.round((vStartX + physSize - 1) * params.scaleX));
  const aEndY = Math.min(params.actualDimY - 1, Math.round((vStartY + physSize - 1) * params.scaleY));
  const aEndZ = Math.min(params.actualDimZ - 1, Math.round((vStartZ + physSize - 1) * params.scaleZ));

  return {
    vStartX, vStartY, vStartZ,
    minCx: Math.floor(aStartX / params.csx),
    maxCx: Math.floor(aEndX / params.csx),
    minCy: Math.floor(aStartY / params.csy),
    maxCy: Math.floor(aEndY / params.csy),
    minCz: Math.floor(aStartZ / params.csz),
    maxCz: Math.floor(aEndZ / params.csz),
  };
}

/** Worst-case chunks one brick footprint can touch at this LOD, per channel —
 *  shared by the P1 fanout diagnostic and the (graduated) dynamic cache budget. */
export function estimateBrickChunkFanout(params: LodChunkParams, physSize: number): number {
  const span = (dim: number, cs: number, scale: number) =>
    Math.max(1, Math.min(Math.ceil(dim / cs), Math.floor(((physSize - 1) * scale) / cs) + 1));
  const spanX = span(params.actualDimX, params.csx, params.scaleX);
  const spanY = span(params.actualDimY, params.csy, params.scaleY);
  const spanZ = span(params.actualDimZ, params.csz, params.scaleZ);
  return spanX * spanY * spanZ;
}

/** Largest per-brick chunk fanout across all LODs, for sizing the (shared)
 *  per-worker chunk cache. Falls back to 8 if no LOD params are available. */
export function estimateDatasetFanoutMultiplier(lodParamsList: LodChunkParams[], physSize: number): number {
  if (lodParamsList.length === 0) return 8;
  return Math.max(1, ...lodParamsList.map(p => estimateBrickChunkFanout(p, physSize)));
}

/** One axis of the assembly LUT: the footprint bounds maxC via FLOOR but
 *  per-voxel assembly ROUNDs, so the index can land outside [minC, maxC] on
 *  non-integer scales — clamp it into range. */
export function clampedLutEntry(
  virtualCoord: number,
  scale: number,
  actualDim: number,
  cs: number,
  minC: number,
  maxC: number,
): { chunkIdx: number; offset: number } {
  const g = Math.max(0, Math.min(actualDim - 1, Math.round(virtualCoord * scale)));
  let cI = Math.floor(g / cs);
  if (cI < minC) cI = minC;
  else if (cI > maxC) cI = maxC;
  const offset = Math.max(0, Math.min(cs - 1, g - cI * cs));
  return { chunkIdx: cI - minC, offset };
}
