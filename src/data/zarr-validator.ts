/**
 * Zarr dataset validation for Kiln Render. Supports OME-NGFF v0.4/v0.5.
 * Shared by dialog pre-validation and provider-level safety-net.
 */

import { open, root } from 'zarrita';
import { TolerantFetchStore } from './tolerant-fetch-store.js';
import { FileSystemStore } from './filesystem-store.js';

interface MultiscalesEntry {
  axes?: unknown; // may be string[] (v0.4) or {name,type}[] (v0.5) or absent
  datasets: { path: string }[];
  version?: string;
}

/** Normalised axis descriptor used internally */
export interface NormalizedAxis {
  name: string;
  type: string;
}

/** Normalise axes from OME-NGFF v0.4 (strings) / v0.5 (typed objects) to uniform shape. */
export function normalizeAxes(raw: unknown): NormalizedAxis[] {
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    return [
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ];
  }
  return raw.map(a => {
    if (typeof a === 'string') {
      // v0.4 string form — infer type from conventional axis name
      const type = a === 't' ? 'time' : a === 'c' ? 'channel' : 'space';
      return { name: a, type };
    }
    const obj = a as { name?: string; type?: string };
    const name = obj.name ?? '';
    const type = obj.type ?? (name === 't' ? 'time' : name === 'c' ? 'channel' : 'space');
    return { name, type };
  });
}

/**
 * Extract the first multiscales entry from zarr group attrs.
 * Handles both v0.5 layout (attrs.ome.multiscales) and v0.4 (attrs.multiscales).
 */
export function extractMultiscales(attrs: Record<string, unknown>): MultiscalesEntry | null {
  const omeAttr = attrs['ome'] as { multiscales?: MultiscalesEntry[] } | undefined;
  return (
    omeAttr?.multiscales?.[0] ??
    (attrs['multiscales'] as MultiscalesEntry[] | undefined)?.[0] ??
    null
  );
}

/** Assembly indexes the last three array dims as [z, y, x]; reject layouts that do not match. */
function validateSpatialLayout(axes: NormalizedAxis[], axesProvided: boolean, rank: number): string[] {
  if (rank < 3) return [`Array has ${rank} dimensions — a volume needs at least 3`];
  if (!axesProvided) return [];
  if (axes.length !== rank) return [`Axes metadata lists ${axes.length} axes but the array has ${rank} dimensions`];

  const spatial = axes.map((a, i) => ({ ...a, i })).filter(a => a.type === 'space');
  if (spatial.length !== 3) return [`Expected 3 spatial axes, found ${spatial.length}`];
  if (spatial.some((a, k) => a.i !== rank - 3 + k)) return ['Spatial axes must be the last three array dimensions (…, z, y, x)'];

  const names = spatial.map(a => a.name.toLowerCase());
  if (names.every(n => 'xyz'.includes(n)) && names.join('') !== 'zyx') {
    return [`Spatial axis order "${names.join(', ')}" is not supported (expected z, y, x)`];
  }
  return [];
}

/**
 * Validate whether a dataset is supported.
 * Returns a list of human-readable reasons; empty array means fully supported.
 */
export function validateZarrSupport(
  ms: MultiscalesEntry,
  firstArrayShape: number[],
  dtype: string,
): string[] {
  const reasons: string[] = [];
  const axes = normalizeAxes(ms.axes);
  reasons.push(...validateSpatialLayout(axes, Array.isArray(ms.axes) && ms.axes.length > 0, firstArrayShape.length));

  if (ms.version && ms.version !== '0.5') {
    console.warn(`[Kiln] OME-NGFF version "${ms.version}" detected — parsing best-effort`);
  }

  if (axes.some(a => a.type === 'time')) {
    console.warn('[Kiln] Time series detected — loading timepoint 0 only');
  }

  const channelIdx = axes.findIndex(a => a.type === 'channel');
  if (channelIdx >= 0 && (firstArrayShape[channelIdx] ?? 1) > 4) {
    console.warn(
      `[Kiln] Multi-channel dataset has ${firstArrayShape[channelIdx]} channels — only first 4 will be rendered`,
    );
  }

  if (!['uint8', 'uint16', 'float32', 'float64'].includes(dtype)) {
    reasons.push(`Data type "${dtype}" is not supported (only uint8, uint16, or float32)`);
  } else if (dtype === 'float64') {
    console.warn('[Kiln] float64 detected — will be read as float32 (precision loss possible)');
  }

  return reasons;
}

/** Pre-validate a remote zarr URL (metadata only, no volume data fetched). */
export async function preValidateRemoteZarr(url: string): Promise<string[]> {
  const store = new TolerantFetchStore(url.replace(/\/$/, ''));
  const rootGroup = await open(root(store), { kind: 'group' });
  const attrs = rootGroup.attrs as Record<string, unknown>;

  // Try root attrs first; fall back to bioformats2raw sub-group "0"
  let ms = extractMultiscales(attrs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let group: any = rootGroup;
  if (!ms) {
    try {
      const subGroup = await open(rootGroup.resolve('0'), { kind: 'group' });
      ms = extractMultiscales(subGroup.attrs as Record<string, unknown>);
      if (ms) group = subGroup;
    } catch {
      // sub-group doesn't exist
    }
  }

  if (!ms) {
    return ['No OME-NGFF multiscales metadata found'];
  }

  const firstPath = ms.datasets[0]?.path;
  if (!firstPath) return ['Dataset has no array entries'];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arr = await open(group.resolve(firstPath), { kind: 'array' }) as any;
  return validateZarrSupport(ms, arr.shape, String(arr.dtype));
}

/**
 * Pre-validate a local zarr directory handle.
 * Same logic as preValidateRemoteZarr but reads from the local filesystem.
 */
export async function preValidateLocalZarr(handle: FileSystemDirectoryHandle): Promise<string[]> {
  const store = new FileSystemStore(handle);
  const rootGroup = await open(root(store), { kind: 'group' });
  const attrs = rootGroup.attrs as Record<string, unknown>;

  // Try root attrs first; fall back to bioformats2raw sub-group "0"
  let ms = extractMultiscales(attrs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let group: any = rootGroup;
  if (!ms) {
    try {
      const subGroup = await open(rootGroup.resolve('0'), { kind: 'group' });
      ms = extractMultiscales(subGroup.attrs as Record<string, unknown>);
      if (ms) group = subGroup;
    } catch {
      // sub-group doesn't exist
    }
  }

  if (!ms) {
    return ['No OME-NGFF multiscales metadata found'];
  }

  const firstPath = ms.datasets[0]?.path;
  if (!firstPath) return ['Dataset has no array entries'];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arr = await open(group.resolve(firstPath), { kind: 'array' }) as any;
  return validateZarrSupport(ms, arr.shape, String(arr.dtype));
}
