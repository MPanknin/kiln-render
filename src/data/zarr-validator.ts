/**
 * Zarr dataset validation for Kiln Render.
 *
 * Supported: OME-NGFF v0.4 and v0.5, single channel, single timepoint,
 * uint8 or uint16. All checks are centralised here so the dialog
 * pre-validation and the provider-level safety-net use exactly the same rules.
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

/**
 * Normalise the axes field from any OME-NGFF version into a consistent shape.
 *
 * - v0.5:      typed objects  { name, type, unit? }
 * - v0.4:      string array   ["z", "y", "x"]  or typed objects
 * - absent:    assumed [z, y, x] spatial
 */
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

  if (!['uint8', 'uint16'].includes(dtype)) {
    reasons.push(`Data type "${dtype}" is not supported (only uint8 or uint16)`);
  }

  return reasons;
}

/**
 * Pre-validate a remote zarr URL.
 * Reads only group attrs and first array metadata — no volume data fetched.
 * Throws on network / parse errors; returns validation reasons otherwise.
 */
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
