import type { SourceSelection } from './data-provider.js';

/** Resolve and validate once, before any data fetches or GPU allocation. */
export function resolveSourceSelection(selection: SourceSelection, channels: number, timepoints: number): {
  sourceChannels: number[]; timepoint: number;
} {
  const sourceChannels = selection.sourceChannels === undefined
    ? Array.from({ length: Math.min(4, channels) }, (_, i) => i)
    : [...selection.sourceChannels];
  if (sourceChannels.length < 1 || sourceChannels.length > 4 ||
      new Set(sourceChannels).size !== sourceChannels.length ||
      sourceChannels.some(i => !Number.isInteger(i) || i < 0 || i >= channels)) {
    throw new RangeError(`Select 1–4 distinct source channels between 0 and ${channels - 1}`);
  }
  const timepoint = selection.timepoint ?? 0;
  if (!Number.isInteger(timepoint) || timepoint < 0 || timepoint >= timepoints) {
    throw new RangeError(`Timepoint must be an integer between 0 and ${timepoints - 1}`);
  }
  return { sourceChannels, timepoint };
}
