/**
 * OME-Zarr label images: segmentations stored as integer IDs next to the image they label
 * (`<image>/labels/<name>`), with optional per-ID colours and properties in `image-label`.
 *
 * A label image is read on the image's own level grid: alignLabelLevels() picks, for every image
 * level, the label array to read and the per-axis scale between the two, so label bricks have the
 * same addresses as image bricks whatever the label pyramid looks like (fewer or more levels,
 * labels at a coarser or finer resolution, a single scale).
 */

import { open, root, Array as ZarrArray } from 'zarrita';
import type { ArrayMetadata, AbsolutePath, DataType, Readable } from 'zarrita';
import { UnsupportedDatasetError } from './data-provider.js';
import { extractMultiscales, normalizeAxes, spatialOrder } from './zarr-validator.js';
import { v2ToV3ArrayMetadata } from './zarr-v2-metadata.js';
import type { ZarrV2ArrayJson } from './zarr-v2-metadata.js';
import { pickXyz } from './chunk-math.js';
import type { SpatialOrder } from './chunk-math.js';
import type { Vec3 } from '../core/pyramid.js';

/** A colour from `image-label.colors`: the label value and its 0–255 RGBA. */
export interface LabelColor {
  value: number;
  rgba: [number, number, number, number];
}

/** Integer types accepted for label images (floats are rounded, as some tools write them). */
const LABEL_DTYPE = /^(bool|u?int(8|16|32|64)|float(32|64))$/;

export function isLabelDtype(dtype: string): boolean {
  return LABEL_DTYPE.test(dtype);
}

/** Label value of a stored voxel: non-positive values (and NaN) are background, floats round. */
export function toLabelId(raw: number | bigint | boolean): number {
  if (typeof raw === 'bigint') return raw > 0n ? Number(raw) : 0;
  const id = Math.round(Number(raw));
  return id > 0 ? id : 0;
}

/** OME attributes live under `ome` in v0.5 and at the top level in v0.4. */
function omeAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const ome = attrs['ome'];
  return ome && typeof ome === 'object' ? ome as Record<string, unknown> : attrs;
}

/** Label image names listed by a `labels` group's attributes. */
export function parseLabelNames(attrs: Record<string, unknown>): string[] {
  const labels = omeAttrs(attrs)['labels'];
  return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string' && l.length > 0) : [];
}

/** Colours from a label image's `image-label` attributes. */
export function parseLabelColors(attrs: Record<string, unknown>): LabelColor[] {
  const imageLabel = omeAttrs(attrs)['image-label'] as { colors?: unknown } | undefined;
  if (!Array.isArray(imageLabel?.colors)) return [];
  return imageLabel.colors.flatMap((c: { 'label-value'?: unknown; rgba?: unknown }) => {
    const rgba = c?.rgba;
    const value = Number(c?.['label-value']);
    if (!Number.isFinite(value) || !Array.isArray(rgba) || rgba.length !== 4) return [];
    return [{ value: toLabelId(value), rgba: rgba.map(v => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))) as LabelColor['rgba'] }];
  }).filter(c => c.value > 0);
}

/** Per-ID properties from `image-label.properties` (everything but `label-value`). */
export function parseLabelProperties(attrs: Record<string, unknown>): Map<number, Record<string, unknown>> {
  const imageLabel = omeAttrs(attrs)['image-label'] as { properties?: unknown } | undefined;
  const props = new Map<number, Record<string, unknown>>();
  if (!Array.isArray(imageLabel?.properties)) return props;
  for (const p of imageLabel.properties as Array<Record<string, unknown>>) {
    const id = toLabelId(Number(p?.['label-value']));
    if (!(id > 0)) continue;
    const { 'label-value': _value, ...rest } = p;
    props.set(id, rest);
  }
  return props;
}

/** A readable name for a segment from its properties: the first of name, class, label, type. */
export function segmentName(properties: Record<string, unknown> | undefined): string | undefined {
  if (!properties) return undefined;
  for (const key of ['name', 'class', 'label', 'type', 'description']) {
    const v = properties[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** One array (resolution level) of a label image, in Kiln's [x, y, z] order. */
export interface LabelArrayInfo {
  /** Path of the array within the label image group */
  path: string;
  dims: Vec3;
  /** Chunk shape as read (inner chunks of a sharded array), all dimensions and [x, y, z] */
  chunkShape: number[];
  chunks: Vec3;
  /** Physical voxel spacing and origin, when the multiscales metadata has them */
  spacing?: Vec3;
  origin?: Vec3;
  /** Zarr v3 array metadata (v2 converted), so readers build arrays without fetching it again */
  metadata: ArrayMetadata<DataType>;
}

/** Everything about a label image that reading and showing it needs. */
export interface LabelImageInfo {
  /** Display name: the label image's name in the `labels` group, or the last URL segment */
  name: string;
  dtype: string;
  arrays: LabelArrayInfo[];
  /** Array rank; the spatial axes are the last three */
  rank: number;
  spatialOrder: SpatialOrder;
  channelAxisIdx: number;
  timeAxisIdx: number;
  timepointCount: number;
  colors: LabelColor[];
  properties: Map<number, Record<string, unknown>>;
}

/** What the image provides for alignment: its level grid and level-0 placement. */
export interface ImageGeometry {
  /** Per image level: voxel dimensions and per-axis log2 downsampling relative to level 0 */
  levels: Array<{ dims: Vec3; exponent: Vec3 }>;
  /** Level-0 physical spacing and origin, when the image has valid multiscale transforms */
  spacing?: Vec3;
  origin?: Vec3;
}

/** How one image level reads its labels: which label array, and how its voxels map onto the level. */
export interface LabelLevelParams {
  /** Index into LabelImageInfo.arrays */
  array: number;
  /** Label voxels per image-level voxel, per axis (1 = same grid, 2 = labels twice as fine) */
  scale: Vec3;
  /** Image level dimensions; voxels outside them are background */
  dims: Vec3;
  /** Label array dimensions and chunk shape */
  arrayDims: Vec3;
  chunks: Vec3;
  rank: number;
  spatialOrder: SpatialOrder;
  channelAxisIdx: number;
  channelChunkSize: number;
  timeAxisIdx: number;
  timeChunkSize: number;
}

/** Most label voxels per image voxel, per axis, read for one brick; coarser levels show no labels. */
export const MAX_LABEL_DOWNSAMPLE = 8;

const fmt = (v: readonly number[]) => v.map(x => +x.toPrecision(5)).join(' × ');

/** Whether `ratio` is a power of two (1/8 … 8) within one voxel of rounding at `dim` voxels. */
function powerOfTwoRatio(labelDim: number, imageDim: number): boolean {
  for (let k = -3; k <= 3; k++) {
    if (Math.abs(labelDim - imageDim * 2 ** k) <= Math.max(1, 2 ** k)) return true;
  }
  return false;
}

/**
 * Check that the label image covers the image, and choose per image level the label array to
 * read: the coarsest one at least as fine as the level (exact when a level matches), else the
 * finest one (labels coarser than the level are upsampled). Levels that would read more than
 * MAX_LABEL_DOWNSAMPLE label voxels per voxel and axis get none. Throws when the label image
 * belongs to a different image. `notes` lists what users should know (shown as warnings).
 */
export function alignLabelLevels(image: ImageGeometry, label: LabelImageInfo): { levels: Array<LabelLevelParams | null>; notes: string[] } {
  const notes: string[] = [];
  const base = image.levels[0];
  const first = label.arrays[0];
  if (!base || !first) throw new UnsupportedDatasetError(['Label image has no arrays']);

  // Placement: physical extent and origin when both have transforms, else power-of-two dimensions
  if (image.spacing && first.spacing) {
    const extentImage = base.dims.map((d, i) => d * image.spacing![i]!);
    const extentLabel = first.dims.map((d, i) => d * first.spacing![i]!);
    const voxel = image.spacing.map((s, i) => Math.max(s, first.spacing![i]!));
    if (extentImage.some((e, i) => Math.abs(e - extentLabel[i]!) > voxel[i]! * 1.001)) {
      throw new UnsupportedDatasetError([
        `Labels cover ${fmt(extentLabel)}, the image ${fmt(extentImage)} (physical units): they belong to another image`,
      ]);
    }
    const originImage = image.origin ?? [0, 0, 0];
    const originLabel = first.origin ?? [0, 0, 0];
    if (originImage.some((o, i) => Math.abs(o - originLabel[i]!) > voxel[i]! * 0.501)) {
      throw new UnsupportedDatasetError([
        `Labels start at (${fmt(originLabel)}), the image at (${fmt(originImage)}): they are placed differently`,
      ]);
    }
  } else if (!first.dims.every((d, i) => powerOfTwoRatio(d, base.dims[i]!))) {
    throw new UnsupportedDatasetError([`Labels are ${fmt(first.dims)} voxels, the image ${fmt(base.dims)}`]);
  }

  if (label.timepointCount > 1) {
    throw new UnsupportedDatasetError([`Labels with ${label.timepointCount} timepoints are not supported yet`]);
  }

  const missing: number[] = [];
  const levels = image.levels.map((level, lod) => {
    // Label voxels per image-level voxel: the level spans 2^e level-0 voxels per voxel
    const scales = label.arrays.map(a => a.dims.map((d, i) => (2 ** level.exponent[i]!) * d / base.dims[i]!) as Vec3);
    const fine = scales.map((s, a) => ({ s, a })).filter(({ s }) => s.every(v => v >= 0.999));
    const pick = fine.length > 0
      ? fine.reduce((best, c) => Math.max(...c.s) < Math.max(...best.s) ? c : best)
      : scales.map((s, a) => ({ s, a })).reduce((best, c) => Math.min(...c.s) > Math.min(...best.s) ? c : best);
    if (Math.max(...pick.s) > MAX_LABEL_DOWNSAMPLE * 1.001) {
      missing.push(lod);
      return null;
    }
    const array = label.arrays[pick.a]!;
    return {
      array: pick.a,
      scale: pick.s.map(v => Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v) as Vec3,
      dims: level.dims,
      arrayDims: array.dims,
      chunks: array.chunks,
      rank: label.rank,
      spatialOrder: label.spatialOrder,
      channelAxisIdx: label.channelAxisIdx,
      channelChunkSize: label.channelAxisIdx >= 0 ? array.chunkShape[label.channelAxisIdx] ?? 1 : 1,
      timeAxisIdx: label.timeAxisIdx,
      timeChunkSize: label.timeAxisIdx >= 0 ? array.chunkShape[label.timeAxisIdx] ?? 1 : 1,
    } satisfies LabelLevelParams;
  });

  if (levels.every(l => l === null)) {
    throw new UnsupportedDatasetError([`Labels are ${fmt(first.dims)} voxels and have no level close to the image's`]);
  }
  if (missing.length > 0) {
    notes.push(`no labels at the ${missing.length} coarsest level${missing.length > 1 ? 's' : ''}: the label image has no level near ${missing.length > 1 ? 'them' : 'it'}; zoom in to see them`);
  }
  return { levels, notes };
}

/** Reads JSON documents of a Zarr hierarchy (remote or local), absent documents as null. */
export type JsonReader = (key: string) => Promise<Record<string, unknown> | null>;

/** A JsonReader over any zarrita-style store. */
export function jsonReader(store: { get(key: AbsolutePath): Promise<Uint8Array | undefined> }): JsonReader {
  return async (key) => {
    const bytes = await store.get(key as AbsolutePath).catch(() => undefined);
    if (!bytes) return null;
    try { return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch { return null; }
  };
}

/** Attributes of the group at `prefix` ('' = root): v3 `zarr.json` attributes or v2 `.zattrs`. */
async function groupAttrs(read: JsonReader, prefix: string): Promise<Record<string, unknown> | null> {
  const [v3, v2] = await Promise.all([read(`${prefix}/zarr.json`), read(`${prefix}/.zattrs`)]);
  return (v3?.['attributes'] as Record<string, unknown> | undefined) ?? v2;
}

/** Names of the label images in the `labels` group under `prefix` (the image group). */
export async function listLabelNames(read: JsonReader, prefix = ''): Promise<string[]> {
  const attrs = await groupAttrs(read, `${prefix}/labels`);
  return attrs ? parseLabelNames(attrs) : [];
}

/** Array metadata at `path`: zarr.json (v3) or .zarray (v2, converted); null when neither exists. */
async function arrayMetadata(read: JsonReader, path: string): Promise<ArrayMetadata<DataType> | null> {
  const [v3, v2] = await Promise.all([read(`/${path}/zarr.json`), read(`/${path}/.zarray`)]);
  if (v3 && v3['node_type'] === 'array') return v3 as unknown as ArrayMetadata<DataType>;
  return v2 ? v2ToV3ArrayMetadata(v2 as unknown as ZarrV2ArrayJson) : null;
}

interface OmeTransform { type: string; scale?: number[]; translation?: number[] }

/**
 * Read a label image's metadata from the root of `store`: multiscales, array geometry,
 * `image-label` colours and properties. Throws UnsupportedDatasetError when it isn't a label
 * image Kiln can show.
 */
export async function readLabelImage(
  store: { get(key: AbsolutePath): Promise<Uint8Array | undefined> },
  name: string,
): Promise<LabelImageInfo> {
  const read = jsonReader(store);
  let attrs = await groupAttrs(read, '');
  let ms = attrs ? extractMultiscales(attrs) : null;
  if (!ms) {
    // Some writers only produce zarr.json files zarrita understands better than we do
    try {
      const group = await open(root(store as never), { kind: 'group' });
      attrs = group.attrs as Record<string, unknown>;
      ms = extractMultiscales(attrs);
    } catch { /* not a group */ }
  }
  if (!attrs || !ms) throw new UnsupportedDatasetError(['No OME-NGFF multiscales metadata found for the labels']);

  const datasets = (ms as { datasets: Array<{ path: string; coordinateTransformations?: OmeTransform[] }> }).datasets;
  const groupTransforms = (ms as { coordinateTransformations?: OmeTransform[] }).coordinateTransformations;
  const metadata = await Promise.all(datasets.map(ds => arrayMetadata(read, ds.path)));
  if (metadata.some(m => !m)) throw new UnsupportedDatasetError(['A label array is missing its metadata']);

  const shape = metadata[0]!.shape;
  const rank = shape.length;
  if (rank < 3) throw new UnsupportedDatasetError([`Label arrays have ${rank} dimensions; a volume needs 3`]);
  const axes = normalizeAxes((ms as { axes?: unknown }).axes);
  const order = spatialOrder(axes, rank);
  const axisOf = (type: string) => axes.length === rank ? axes.findIndex(a => a.type === type) : -1;
  const channelAxisIdx = axisOf('channel');
  const timeAxisIdx = axisOf('time');
  const dtype = String(metadata[0]!.data_type);
  if (!isLabelDtype(dtype)) {
    throw new UnsupportedDatasetError([`Label data type "${dtype}" is not supported (integers)`]);
  }
  for (const m of metadata) {
    if (m!.shape.length !== rank) throw new UnsupportedDatasetError(['Label arrays differ in rank']);
  }
  if (channelAxisIdx >= 0 && (shape[channelAxisIdx] ?? 1) > 1) {
    console.warn(`[Kiln] labels "${name}" have ${shape[channelAxisIdx]} channels; showing the first`);
  }

  const xyz = (v: number[] | undefined): Vec3 | undefined => (v && v.length === rank ? pickXyz(v, order) : undefined);
  const groupScale = xyz(groupTransforms?.find(t => t.type === 'scale')?.scale);
  const groupTranslation = xyz(groupTransforms?.find(t => t.type === 'translation')?.translation);
  const arrays: LabelArrayInfo[] = datasets.map((ds, i) => {
    const m = metadata[i]!;
    // zarrita reports the inner chunk shape of sharded arrays, which is what reads address
    const chunkShape = new ZarrArray(store as unknown as Readable, `/${ds.path}` as AbsolutePath, m).chunks;
    const t = ds.coordinateTransformations ?? [];
    const scale = xyz(t.find(x => x.type === 'scale')?.scale);
    const translation = xyz(t.find(x => x.type === 'translation')?.translation);
    const valid = (v?: Vec3) => !!v && v.every(Number.isFinite);
    return {
      path: ds.path,
      dims: pickXyz(m.shape, order),
      chunkShape,
      chunks: pickXyz(chunkShape, order),
      spacing: valid(scale) && scale!.every(s => s > 0) ? scale!.map((s, a) => s * (groupScale?.[a] ?? 1)) as Vec3 : undefined,
      origin: valid(translation) || groupTranslation
        ? (translation ?? [0, 0, 0]).map((o, a) => o * (groupScale?.[a] ?? 1) + (groupTranslation?.[a] ?? 0)) as Vec3
        : undefined,
      metadata: m,
    };
  });

  return {
    name,
    dtype,
    arrays,
    rank,
    spatialOrder: order,
    channelAxisIdx,
    timeAxisIdx,
    timepointCount: timeAxisIdx >= 0 ? shape[timeAxisIdx] ?? 1 : 1,
    colors: parseLabelColors(attrs),
    properties: parseLabelProperties(attrs),
  };
}

/** zarrita arrays for a label image, built from metadata already read (no network round trips). */
export function labelArrays(store: Readable, info: Pick<LabelImageInfo, 'arrays'>): ZarrArray<DataType, Readable>[] {
  return info.arrays.map(a => new ZarrArray(store, `/${a.path}` as AbsolutePath, a.metadata));
}
