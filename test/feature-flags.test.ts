import { afterEach, describe, expect, it, vi } from 'vitest';

// The module reads the page URL once at import, so each case stubs window and re-imports it.
async function flagsFor(search: string) {
  vi.resetModules();
  vi.stubGlobal('window', { location: { search } });
  return import('../src/core/feature-flags.js');
}

describe('feature flags', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('isFlagDisabled is true only for an explicit off value', async () => {
    for (const off of ['0', 'false', 'OFF']) {
      expect((await flagsFor(`?rayguide=${off}`)).isFlagDisabled('rayguide')).toBe(true);
    }
    for (const search of ['', '?rayguide=1', '?rayguide=', '?other=0']) {
      expect((await flagsFor(search)).isFlagDisabled('rayguide')).toBe(false);
    }
  });

  it('isFlagEnabled and isFlagDisabled never agree', async () => {
    const flags = await flagsFor('?a=1&b=0');
    expect([flags.isFlagEnabled('a'), flags.isFlagDisabled('a')]).toEqual([true, false]);
    expect([flags.isFlagEnabled('b'), flags.isFlagDisabled('b')]).toEqual([false, true]);
  });
});
