/** Share-link helpers for source selection (examples/shared). */
import { describe, it, expect } from 'vitest';
import { resolveSourceSelection } from '../src/data/source-selection.js';
import { parseSourceSelection, writeSourceSelection, selectionUrl } from '../examples/shared/source-selection.js';
describe('selection links', () => {
  it('roundtrips source selection independently from display settings', () => {
    const p = new URLSearchParams('channels=255,0,0,1,1');
    writeSourceSelection(p, { sourceChannels: [5, 1], timepoint: 3 });
    expect(parseSourceSelection(p)).toEqual({ sourceChannels: [5, 1], timepoint: 3 });
    expect(p.get('channels')).toBe('255,0,0,1,1');
  });
  it.each(['', '-1', '1.2', 'x', 'Infinity'])('rejects malformed URL index %s rather than silently opening index zero', value => {
    expect(() => resolveSourceSelection(parseSourceSelection(new URLSearchParams({ timepoint: value })), 6, 4)).toThrow();
  });
  it('preserves camera and source, resets slot styles and redirects multi-selection within preview prefix', () => {
    const url = new URL(selectionUrl('https://example.org/private/preview/test/app/?cam=1,2,3&channels=old&wc=0.3',
      { sourceChannels: [5, 1], timepoint: 2 }, [0], 'https://data.org/image.zarr', false));
    expect(url.pathname).toBe('/private/preview/test/app/multichannel/');
    expect(url.searchParams.get('cam')).toBe('1,2,3');
    expect(url.searchParams.get('dataset')).toBe('https://data.org/image.zarr');
    expect(url.searchParams.has('channels')).toBe(false);
    expect(url.searchParams.has('wc')).toBe(false);
  });
  it('preserves channel display settings for time-only switches and retains local mode', () => {
    const url = new URL(selectionUrl('https://example.org/app/multichannel/?channels=keep',
      { sourceChannels: [5, 1], timepoint: 1 }, [5, 1], 'unused', true));
    expect(url.searchParams.get('channels')).toBe('keep');
    expect(url.searchParams.get('local')).toBe('true');
    expect(url.searchParams.has('dataset')).toBe(false);
  });
});

  it('routes a single selected channel back to the basic viewer controls', () => {
    const url = new URL(selectionUrl('https://example.org/private/preview/test/app/multichannel/?cam=1,2,3&channels=old',
      { sourceChannels: [5], timepoint: 2 }, [5, 1], 'https://data.org/image.zarr', false));
    expect(url.pathname).toBe('/private/preview/test/app/');
    expect(url.searchParams.get('sourceChannels')).toBe('5');
    expect(url.searchParams.get('cam')).toBe('1,2,3');
    expect(url.searchParams.has('channels')).toBe(false);
  });
