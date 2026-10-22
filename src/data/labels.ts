/**
 * OME-Zarr label images: segmentations stored as integer IDs next to the image they label
 * (`<image>/labels/<name>`), with optional per-ID colours in `image-label` metadata.
 */

import { UnsupportedDatasetError } from './data-provider.js';
import type { VolumeMetadata } from './data-provider.js';

/** A colour from `image-label.colors`: the label value and its 0–255 RGBA. */
export interface LabelColor {
  value: number;
  rgba: [number, number, number, number];
}

/** Largest ID the r16uint label atlas holds; larger IDs wrap into 1…LABEL_ID_MAX. */
export const LABEL_ID_MAX = 0xffff;

/** Numeric data types accepted for label images. */
const LABEL_DTYPE = /^(u?int(8|16|32|64)|float(32|64))$/;

export function isLabelDtype(dtype: string): boolean {
  return LABEL_DTYPE.test(dtype);
}

/** Atlas value of a label: 0 stays background, IDs above 65535 wrap into 1–65535. */
export function labelId(raw: number | bigint): number {
  if (typeof raw === 'bigint') {
    if (raw <= 0n) return 0;
    return raw <= 0xffffn ? Number(raw) : Number((raw - 1n) % 0xffffn) + 1;
  }
  const id = Math.round(raw);
  if (!(id > 0)) return 0; // also NaN
  return id <= LABEL_ID_MAX ? id : ((id - 1) % LABEL_ID_MAX) + 1;
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
    if (typeof c?.['label-value'] !== 'number' || !Array.isArray(rgba) || rgba.length !== 4) return [];
    return [{ value: c['label-value'], rgba: rgba.map(v => Math.max(0, Math.min(255, Number(v) || 0))) as LabelColor['rgba'] }];
  });
}

/** Distinct colour for an ID without one: hues step by the golden ratio, so neighbouring IDs differ. */
function hashedColor(id: number): [number, number, number] {
  const h = (id * 0.6180339887) % 1 * 6;
  const s = 0.75;
  const v = 1;
  const f = h - Math.floor(h);
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  const rgb = ([[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]] as const)[Math.floor(h) % 6]!;
  return [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255];
}

/** 256 × 256 RGBA table indexed by atlas ID (x = id & 255, y = id >> 8); ID 0 is transparent. */
export function buildLabelColorTable(colors: readonly LabelColor[] = []): Uint8Array {
  const table = new Uint8Array((LABEL_ID_MAX + 1) * 4);
  for (let id = 1; id <= LABEL_ID_MAX; id++) {
    table.set([...hashedColor(id), 255], id * 4);
  }
  for (const { value, rgba } of colors) {
    const id = labelId(value);
    if (id > 0) table.set(rgba, id * 4);
  }
  return table;
}

/**
 * Which image levels the label image covers voxel for voxel. Labels are only shown where the
 * level matches; a mismatch at the finest level means the labels belong to another image.
 */
export function matchLabelLevels(image: VolumeMetadata, labels: VolumeMetadata): boolean[] {
  const levels = image.levels.map(level => {
    const match = labels.levels.find(l => l.lod === level.lod);
    return !!match && match.dimensions.every((d, i) => d === level.dimensions[i]);
  });
  if (!levels[0]) {
    throw new UnsupportedDatasetError([
      `Labels are ${labels.dimensions.join(' × ')} voxels, the image ${image.dimensions.join(' × ')}`,
    ]);
  }
  return levels;
}
