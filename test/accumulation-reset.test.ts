/**
 * Accumulation-reset scheduling in StreamingManager: content commits coalesce
 * for a quiet period but a redraw notification is never delayed past the max wait.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamingManager } from '../src/streaming/streaming-manager.js';

const QUIET_MS = 100;
const MAX_WAIT_MS = 250;

function makeManager() {
  const sm: any = Object.create(StreamingManager.prototype);
  sm.resetAccumulationTimer = null;
  sm.firstPendingResetAt = null;
  sm.contentVersionCounter = 0;
  const times: number[] = [];
  sm.onResetAccumulation = vi.fn(() => times.push(performance.now()));
  return { sm, times };
}

describe('StreamingManager accumulation reset scheduling', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  it('a single commit resets after the quiet period', () => {
    const { sm, times } = makeManager();
    sm.notifyContentChanged();
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(times).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(times).toEqual([QUIET_MS]);
  });

  it('sparse commits each reset after the quiet period', () => {
    const { sm, times } = makeManager();
    sm.notifyContentChanged();
    vi.advanceTimersByTime(500);
    sm.notifyContentChanged();
    vi.advanceTimersByTime(500);
    expect(times).toEqual([QUIET_MS, 500 + QUIET_MS]);
  });

  it('a burst within the quiet period coalesces into one reset', () => {
    const { sm, times } = makeManager();
    for (let i = 0; i < 5; i++) { sm.notifyContentChanged(); vi.advanceTimersByTime(10); }
    vi.advanceTimersByTime(QUIET_MS);
    expect(times).toEqual([40 + QUIET_MS]);
    expect(sm.contentVersion).toBe(5);
  });

  it('continuous commits reset at the max wait, then a trailing reset after the last one', () => {
    const { sm, times } = makeManager();
    for (let i = 0; i < 12; i++) { sm.notifyContentChanged(); vi.advanceTimersByTime(50); }
    // commits at 0..550; max-wait resets at 250 and 500, trailing reset at 550 + quiet
    vi.advanceTimersByTime(QUIET_MS);
    expect(times).toEqual([MAX_WAIT_MS, 2 * MAX_WAIT_MS, 550 + QUIET_MS]);
  });

  it('flush fires immediately and drops the pending timer', () => {
    const { sm, times } = makeManager();
    sm.notifyContentChanged();
    vi.advanceTimersByTime(30);
    sm.flushAccumulationReset();
    expect(times).toEqual([30]);
    vi.advanceTimersByTime(1000);
    expect(times).toEqual([30]);
  });

  it('cancel drops the pending timer without firing', () => {
    const { sm, times } = makeManager();
    sm.notifyContentChanged();
    sm.cancelAccumulationReset();
    vi.advanceTimersByTime(1000);
    expect(times).toEqual([]);
  });

  it('a commit after cancel starts a fresh max-wait window', () => {
    const { sm, times } = makeManager();
    sm.notifyContentChanged();
    vi.advanceTimersByTime(80);
    sm.cancelAccumulationReset();
    sm.notifyContentChanged();
    vi.advanceTimersByTime(QUIET_MS);
    expect(times).toEqual([80 + QUIET_MS]);
  });
});
