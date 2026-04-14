/**
 * Zarr dataset validation for Kiln Render.
 *
 * Supported: OME-NGFF v0.5, single channel, single timepoint, uint8 or uint16.
 * All checks are centralised here so the dialog pre-validation and the
 * provider-level safety-net use exactly the same rules.
 */

import { open, root } from 'zarrita';
import { TolerantFetchStore } from './tolerant-fetch-store.js';
import { FileSystemStore } from './filesystem-store.js';

interface MultiscalesEntry {
  axes?: { name: string; type?: string }[];
  datasets: { path: string }[];
  version?: string;
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
  const axes = ms.axes ?? [];

  // v0.5 requires typed axes; their absence strongly indicates pre-v0.5
  if (axes.length === 0 || axes.every(a => !a.type)) {
    reasons.push('Dataset does not declare typed axes — only OME-NGFF v0.5 is supported');
    return reasons;
  }

  if (ms.version && ms.version !== '0.5') {
    reasons.push(`OME-NGFF version "${ms.version}" is not supported (only v0.5)`);
  }

  if (axes.some(a => a.type === 'time')) {
    reasons.push('Time series are not supported');
  }

  const channelIdx = axes.findIndex(a => a.type === 'channel');
  if (channelIdx >= 0 && (firstArrayShape[channelIdx] ?? 1) > 1) {
    reasons.push(`Multi-channel datasets are not supported (${firstArrayShape[channelIdx]} channels)`);
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
  const group = await open(root(store), { kind: 'group' });
  const attrs = group.attrs as Record<string, unknown>;

  const ms = extractMultiscales(attrs);
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
  const group = await open(root(store), { kind: 'group' });
  const attrs = group.attrs as Record<string, unknown>;

  const ms = extractMultiscales(attrs);
  if (!ms) {
    return ['No OME-NGFF multiscales metadata found'];
  }

  const firstPath = ms.datasets[0]?.path;
  if (!firstPath) return ['Dataset has no array entries'];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arr = await open(group.resolve(firstPath), { kind: 'array' }) as any;
  return validateZarrSupport(ms, arr.shape, String(arr.dtype));
}
