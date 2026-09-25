/** Load milestones as performance.now() timestamps (ms since navigation start); null until reached. */
export interface LoadMilestones {
  /** KilnEngine.create() entered — separates a dataset open from page startup. */
  datasetOpenStart: number;
  /** GPU device available (reported by the host that requested it). */
  deviceReady: number | null;
  metadataReady: number | null;
  /** Renderer, atlas and pipelines constructed. */
  gpuReady: number | null;
  firstBrickDecoded: number | null;
  firstAtlasCommit: number | null;
  baseCoverage10: number | null;
  baseCoverage50: number | null;
  baseCoverage90: number | null;
  /** Every base brick has its channel 0 resolved — a complete one-channel image (channel-major loads). */
  baseChannel0Complete: number | null;
  baseComplete: number | null;
  /** First frame submitted after resident data was committed; not proof of presentation. */
  firstContentSubmit: number | null;
  /** Presentation proxy: first animation-frame callback after firstContentSubmit. */
  firstContentFrame: number | null;
}

export type BrickMilestones = Pick<LoadMilestones,
  'firstBrickDecoded' | 'firstAtlasCommit' | 'baseCoverage10' | 'baseCoverage50' | 'baseCoverage90' | 'baseChannel0Complete' | 'baseComplete'>;

export function createBrickMilestones(): BrickMilestones {
  return {
    firstBrickDecoded: null,
    firstAtlasCommit: null,
    baseCoverage10: null,
    baseCoverage50: null,
    baseCoverage90: null,
    baseChannel0Complete: null,
    baseComplete: null,
  };
}

/** Stamp the coverage milestones that `resolved / total` base bricks have just crossed. */
export function stampBaseCoverage(m: BrickMilestones, resolved: number, total: number, now: number): void {
  const fraction = total > 0 ? resolved / total : 1;
  if (m.baseCoverage10 === null && fraction >= 0.1) m.baseCoverage10 = now;
  if (m.baseCoverage50 === null && fraction >= 0.5) m.baseCoverage50 = now;
  if (m.baseCoverage90 === null && fraction >= 0.9) m.baseCoverage90 = now;
}
