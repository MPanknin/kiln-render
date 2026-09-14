/**
 * Load milestones: base coverage stamping and the engine's first-content stamps.
 */
import { describe, it, expect, vi } from 'vitest';
import { createBrickMilestones, stampBaseCoverage } from '../src/core/milestones.js';
import { KilnEngine } from '../src/engine.js';

describe('stampBaseCoverage', () => {
  it('stamps each threshold once, at the first crossing', () => {
    const m = createBrickMilestones();
    stampBaseCoverage(m, 1, 20, 10);   // 5%
    expect(m.baseCoverage10).toBeNull();
    stampBaseCoverage(m, 2, 20, 20);   // 10%
    stampBaseCoverage(m, 10, 20, 30);  // 50%
    stampBaseCoverage(m, 11, 20, 40);  // 55%
    stampBaseCoverage(m, 20, 20, 50);  // 100%
    expect(m).toMatchObject({ baseCoverage10: 20, baseCoverage50: 30, baseCoverage90: 50 });
  });

  it('a single resolved brick can cross several thresholds at once', () => {
    const m = createBrickMilestones();
    stampBaseCoverage(m, 1, 1, 7);
    expect(m).toMatchObject({ baseCoverage10: 7, baseCoverage50: 7, baseCoverage90: 7 });
  });

  it('an empty base level counts as fully covered', () => {
    const m = createBrickMilestones();
    stampBaseCoverage(m, 0, 0, 3);
    expect(m.baseCoverage90).toBe(3);
  });
});

function makeEngine() {
  const engine: any = Object.create(KilnEngine.prototype);
  engine.disposed = false;
  engine.renderer = { render: vi.fn() };
  engine.streamingManager = { milestones: createBrickMilestones() };
  engine.setupMilestones = { datasetOpenStart: 1, deviceReady: null, metadataReady: 2, gpuReady: 3 };
  engine.firstContentSubmit = null;
  engine.firstContentFrame = null;
  return engine;
}

describe('KilnEngine first-content milestones', () => {
  it('frames before any atlas commit never count as content', () => {
    const engine = makeEngine();
    engine.render({}, {});
    engine.noteAnimationFrame(99);
    expect(engine.milestones.firstContentSubmit).toBeNull();
    expect(engine.milestones.firstContentFrame).toBeNull();
  });

  it('stamps submit on the first frame after a commit, then the next animation frame as proxy', () => {
    const engine = makeEngine();
    engine.streamingManager.milestones.firstAtlasCommit = 50;
    engine.render({}, {});
    const submit = engine.milestones.firstContentSubmit;
    expect(submit).not.toBeNull();
    engine.noteAnimationFrame(submit + 16);
    engine.render({}, {});
    engine.noteAnimationFrame(submit + 32);
    expect(engine.milestones.firstContentSubmit).toBe(submit);
    expect(engine.milestones.firstContentFrame).toBe(submit + 16);
  });

  it('merges setup, brick and content milestones into one view', () => {
    const engine = makeEngine();
    engine.streamingManager.milestones.baseComplete = 80;
    expect(engine.milestones).toMatchObject({ datasetOpenStart: 1, metadataReady: 2, gpuReady: 3, baseComplete: 80 });
  });
});
