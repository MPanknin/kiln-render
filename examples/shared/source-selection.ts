import type { KilnViewer, SourceSelection } from 'kiln-render';

/** Separate from `channels`, which stores display colours/windows in existing links. */
export function parseSourceSelection(params: URLSearchParams): SourceSelection {
  const integer = (s: string): number => /^\d+$/.test(s) ? Number(s) : NaN;
  return {
    sourceChannels: params.has('sourceChannels') ? params.get('sourceChannels')!.split(',').map(integer) : undefined,
    timepoint: params.has('timepoint') ? integer(params.get('timepoint')!) : undefined,
  };
}

export function writeSourceSelection(params: URLSearchParams, selection: SourceSelection): void {
  if (selection.sourceChannels) params.set('sourceChannels', selection.sourceChannels.join(','));
  if (selection.timepoint !== undefined) params.set('timepoint', String(selection.timepoint));
}

/** Share URL for a selection; switches viewer app when the channel count crosses 1 ↔ many. */
export function selectionUrl(
  currentViewUrl: string, selection: Required<SourceSelection>, previousChannels: readonly number[],
  dataset: string, local: boolean,
): string {
  const url = new URL(currentViewUrl);
  if (local) { url.searchParams.set('local', 'true'); url.searchParams.delete('dataset'); }
  else url.searchParams.set('dataset', dataset);
  writeSourceSelection(url.searchParams, selection);
  if (selection.sourceChannels.join(',') !== previousChannels.join(',')) {
    // Display settings refer to slots, and must not be applied to unrelated source channels.
    for (const key of ['channels', 'wc', 'ww']) url.searchParams.delete(key);
  }
  const isMulti = /\/multichannel\/(?:index\.html)?$/.test(url.pathname);
  if (selection.sourceChannels.length > 1 && !isMulti) {
    url.pathname = new URL('multichannel/', url).pathname;
    if (url.searchParams.get('mode') === 'iso') url.searchParams.set('mode', 'dvr');
  } else if (selection.sourceChannels.length === 1 && isMulti) {
    // The single-channel shader uses transfer functions, so show its matching controls.
    url.pathname = url.pathname.replace(/multichannel\/(?:index\.html)?$/, '');
    url.searchParams.delete('channels');
  }
  return url.toString();
}

/** Explicit selection links may enter through either viewer URL. Match the controls to the shader. */
export function routeSourceSelection(dataset: string): boolean {
  const params = new URLSearchParams(window.location.search);
  const selection = parseSourceSelection(params);
  if (!selection.sourceChannels?.length) return false;
  const target = selectionUrl(window.location.href, {
    sourceChannels: selection.sourceChannels, timepoint: selection.timepoint ?? 0,
  }, selection.sourceChannels, dataset, params.get('local') === 'true');
  if (new URL(target).pathname === window.location.pathname) return false;
  window.location.replace(target);
  return true;
}

/**
 * Apply a selection from the UI: in place (same workers, camera and GPU resources) with the
 * address bar updated, or by opening the other viewer app when the channel count crosses
 * 1 ↔ many. Returns false in that second case; the page is unloading.
 */
export function applySourceSelection(
  viewer: Pick<KilnViewer, 'metadata' | 'setSourceSelection'>, selection: Required<SourceSelection>,
  dataset: string, local: boolean, buildShareUrl: () => string,
): boolean {
  const target = selectionUrl(buildShareUrl(), selection, viewer.metadata.sourceChannels ?? [], dataset, local);
  if (new URL(target).pathname !== window.location.pathname) {
    window.location.assign(target);
    return false;
  }
  viewer.setSourceSelection(selection);
  history.replaceState(null, '', buildShareUrl());
  return true;
}
