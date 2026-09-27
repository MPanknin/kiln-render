/**
 * Level-model fallback for dataset open: prefer the native pyramid (per-axis factors
 * from the metadata) and fall back to the legacy uniform 2:1 model when the stored
 * levels are slightly off — e.g. a coarse level a few voxels short of half its parent.
 */

import type { PyramidPolicy } from '../core/pyramid.js';
import type { DataProvider, VolumeMetadata } from './data-provider.js';
import { UnsupportedDatasetError } from './data-provider.js';
import { BaseZarrProvider, LEGACY_HINT } from './base-zarr-provider.js';

/** True when the only problem was the native level geometry (the provider appends LEGACY_HINT). */
export function isNativePyramidRejection(e: unknown): e is UnsupportedDatasetError {
  return e instanceof UnsupportedDatasetError && e.reasons.includes(LEGACY_HINT);
}

/**
 * Initialise `provider` with the `requested` level model (default native). When nothing was
 * requested and native is rejected only for its level geometry, retry once with legacy.
 * Only Kiln's Zarr providers are retried: their initialize() stores nothing before the
 * pyramid check throws, so a second call starts clean. An explicit request is never overridden.
 */
export async function initializeWithPyramidFallback(
  provider: DataProvider,
  requested?: PyramidPolicy,
): Promise<{ metadata: VolumeMetadata; pyramid: PyramidPolicy }> {
  const pyramid: PyramidPolicy = requested ?? 'native';
  provider.setPyramidPolicy?.(pyramid);
  try {
    return { metadata: await provider.initialize(), pyramid };
  } catch (e) {
    if (requested !== undefined || !(provider instanceof BaseZarrProvider) || !isNativePyramidRejection(e)) throw e;
    const issues = e.reasons.filter(r => r !== LEGACY_HINT).join('; ');
    console.warn(`[Kiln] native pyramid unsupported (${issues}) — falling back to the legacy 2:1 model`);
    provider.setPyramidPolicy('legacy');
    return { metadata: await provider.initialize(), pyramid: 'legacy' };
  }
}
