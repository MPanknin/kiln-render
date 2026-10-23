/**
 * Label brick assembly: read a 66³ brick of label IDs on the image's level grid (see
 * alignLabelLevels) and compress it into a palette of distinct IDs plus byte planes of
 * per-voxel palette indices. Most bricks are background only or one ID, and need no voxels
 * at all; the rest usually need one byte per voxel. Shared by the label worker (remote) and
 * the main-thread reader (local folders), so both produce identical bricks.
 */

import { chunkCoords, chunkLayout } from './chunk-math.js';
import { toLabelId } from './label-image.js';
import type { LabelLevelParams } from './label-image.js';

export const LABEL_LOGICAL_SIZE = 64;
export const LABEL_PHYSICAL_SIZE = 66;
const VOXELS = LABEL_PHYSICAL_SIZE ** 3;

/** A label brick: background only, one ID throughout, or a palette with per-voxel indices. */
export interface LabelBrickData {
  kind: 'empty' | 'uniform' | 'mixed';
  /** Distinct IDs; index 0 is always background (ID 0). Uniform: [0, id]. */
  palette: Float64Array;
  /** Mixed only: 66³ palette indices as 1–3 byte planes, least significant first. */
  planes: Uint8Array[];
}

/** A decoded chunk as zarrita returns it. */
export interface DecodedChunk {
  data: ArrayLike<number | bigint | boolean>;
  shape: number[];
  stride: number[];
}

/** Fetches one chunk of `array` (null: missing, read as background). */
export type ChunkGetter = (array: number, coords: number[], key: string) => Promise<DecodedChunk | null>;

/** Index of the label voxel read for each of the brick's 66 voxels along one axis; -1 outside the image. */
export function labelAxisMap(brick: number, scale: number, dim: number, arrayDim: number): Int32Array {
  const map = new Int32Array(LABEL_PHYSICAL_SIZE);
  for (let i = 0; i < LABEL_PHYSICAL_SIZE; i++) {
    const v = brick * LABEL_LOGICAL_SIZE - 1 + i;
    // Nearest label voxel to the voxel centre: exact on equal grids, centred when resampling
    map[i] = v < 0 || v >= dim ? -1 : Math.min(arrayDim - 1, Math.max(0, Math.floor((v + 0.5) * scale)));
  }
  return map;
}

/** Chunk keys shared by all readers of a label image: array, time chunk, chunk position. */
export function labelChunkKey(level: LabelLevelParams, timepoint: number, cx: number, cy: number, cz: number): string {
  return `${level.array}:t${Math.floor(timepoint / level.timeChunkSize)}:${cz}/${cy}/${cx}`;
}

/** Brick (bx, by, bz) of an image level, read through `getChunk`. */
export async function assembleLabelBrick(
  level: LabelLevelParams, bx: number, by: number, bz: number, timepoint: number,
  getChunk: ChunkGetter, signal?: AbortSignal,
): Promise<LabelBrickData> {
  const mx = labelAxisMap(bx, level.scale[0], level.dims[0], level.arrayDims[0]);
  const my = labelAxisMap(by, level.scale[1], level.dims[1], level.arrayDims[1]);
  const mz = labelAxisMap(bz, level.scale[2], level.dims[2], level.arrayDims[2]);
  const range = (map: Int32Array, cs: number): [number, number] | null => {
    let lo = Infinity, hi = -Infinity;
    for (const v of map) if (v >= 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return lo <= hi ? [Math.floor(lo / cs), Math.floor(hi / cs)] : null;
  };
  const rx = range(mx, level.chunks[0]);
  const ry = range(my, level.chunks[1]);
  const rz = range(mz, level.chunks[2]);
  if (!rx || !ry || !rz) return emptyBrick();

  const ncx = rx[1] - rx[0] + 1;
  const ncy = ry[1] - ry[0] + 1;
  const ncz = rz[1] - rz[0] + 1;
  const chunks: Array<{ data: ArrayLike<number | bigint>; base: number; sx: number; sy: number; sz: number } | null> =
    new Array(ncx * ncy * ncz).fill(null);
  const prefix = level.rank - 3;
  const fetches: Promise<void>[] = [];
  for (let cz = rz[0]; cz <= rz[1]; cz++) {
    for (let cy = ry[0]; cy <= ry[1]; cy++) {
      for (let cx = rx[0]; cx <= rx[1]; cx++) {
        const slot = (cz - rz[0]) * ncy * ncx + (cy - ry[0]) * ncx + (cx - rx[0]);
        const coords = chunkCoords(prefix, level.channelAxisIdx, level.channelChunkSize, 0, cz, cy, cx,
          level.spatialOrder, level.timeAxisIdx, level.timeChunkSize, timepoint);
        fetches.push(getChunk(level.array, coords, labelChunkKey(level, timepoint, cx, cy, cz)).then(chunk => {
          if (!chunk) return;
          const layout = chunkLayout(chunk, level.channelAxisIdx, level.channelChunkSize, 0,
            level.spatialOrder, level.timeAxisIdx, level.timeChunkSize, timepoint);
          chunks[slot] = { data: indexable(chunk.data), base: layout.base, sx: layout.strideX, sy: layout.strideY, sz: layout.strideZ };
        }));
      }
    }
  }
  await Promise.all(fetches);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Per-axis LUTs: chunk slot offset and voxel offset within the chunk, -1 outside the image
  const lut = (map: Int32Array, cs: number, first: number, stride: number) => {
    const chunk = new Int32Array(LABEL_PHYSICAL_SIZE);
    const offset = new Int32Array(LABEL_PHYSICAL_SIZE);
    for (let i = 0; i < LABEL_PHYSICAL_SIZE; i++) {
      const v = map[i]!;
      chunk[i] = v < 0 ? -1 : (Math.floor(v / cs) - first) * stride;
      offset[i] = v < 0 ? 0 : v % cs;
    }
    return { chunk, offset };
  };
  const lx = lut(mx, level.chunks[0], rx[0], 1);
  const ly = lut(my, level.chunks[1], ry[0], ncx);
  const lz = lut(mz, level.chunks[2], rz[0], ncx * ncy);

  return palettize((emit) => {
    for (let z = 0; z < LABEL_PHYSICAL_SIZE; z++) {
      const cz = lz.chunk[z]!;
      const oz = lz.offset[z]!;
      for (let y = 0; y < LABEL_PHYSICAL_SIZE; y++) {
        const cy = ly.chunk[y]!;
        const oy = ly.offset[y]!;
        for (let x = 0; x < LABEL_PHYSICAL_SIZE; x++) {
          const cx = lx.chunk[x]!;
          if (cz < 0 || cy < 0 || cx < 0) { emit(0); continue; }
          const c = chunks[cz + cy + cx];
          if (!c) { emit(0); continue; }
          emit(c.data[c.base + oz * c.sz + oy * c.sy + lx.offset[x]! * c.sx]!);
        }
      }
    }
  });
}

/** zarrita returns booleans as a BoolArray, which has no index access; read its bytes. */
function indexable(data: ArrayLike<number | bigint | boolean>): ArrayLike<number | bigint> {
  if (ArrayBuffer.isView(data)) return data as unknown as ArrayLike<number | bigint>;
  const bytes = data as unknown as { buffer?: ArrayBuffer; byteOffset?: number; byteLength?: number };
  if (bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset ?? 0, bytes.byteLength);
  return Array.from(data, v => toLabelId(v));
}

function emptyBrick(): LabelBrickData {
  return { kind: 'empty', palette: Float64Array.of(0), planes: [] };
}

/**
 * Compress the 66³ voxels that `scan` emits (in x, y, z order) into a palette and index planes.
 * Consecutive equal raw values skip the palette lookup, which covers the long runs labels have.
 */
export function palettize(scan: (emit: (raw: number | bigint | boolean) => void) => void): LabelBrickData {
  const indices = new Uint32Array(VOXELS);
  const palette: number[] = [0];
  const lookup = new Map<number, number>();
  let i = 0;
  let zeros = 0;
  let lastRaw: number | bigint | boolean = 0;
  let lastIndex = 0;
  scan((raw) => {
    let index: number;
    if (raw === lastRaw) {
      index = lastIndex;
    } else {
      const id = toLabelId(raw);
      if (id === 0) {
        index = 0;
      } else {
        index = lookup.get(id) ?? -1;
        if (index < 0) {
          index = palette.length;
          palette.push(id);
          lookup.set(id, index);
        }
      }
      lastRaw = raw;
      lastIndex = index;
    }
    if (index === 0) zeros++;
    indices[i++] = index;
  });

  if (palette.length === 1) return emptyBrick();
  if (palette.length === 2 && zeros === 0) return { kind: 'uniform', palette: Float64Array.from(palette), planes: [] };

  const planeCount = palette.length <= 0x100 ? 1 : palette.length <= 0x10000 ? 2 : 3;
  const planes = Array.from({ length: planeCount }, () => new Uint8Array(VOXELS));
  const [p0, p1, p2] = planes;
  for (let v = 0; v < VOXELS; v++) {
    const index = indices[v]!;
    p0![v] = index & 0xff;
    if (p1) p1[v] = (index >> 8) & 0xff;
    if (p2) p2[v] = index >> 16;
  }
  return { kind: 'mixed', palette: Float64Array.from(palette), planes };
}
