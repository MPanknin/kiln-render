import { describe, it, expect } from 'vitest';
import { channelDisplayName } from '../examples/shared/channel-names.js';

describe('channelDisplayName', () => {
  it('uses the OMERO label when present', () => {
    expect(channelDisplayName('DAPI', 0)).toBe('DAPI');
  });

  it('trims surrounding whitespace from labels', () => {
    expect(channelDisplayName('  GFP  ', 1)).toBe('GFP');
  });

  it('falls back to the channel index for missing or blank labels', () => {
    expect(channelDisplayName(undefined, 2)).toBe('Channel 2');
    expect(channelDisplayName('', 3)).toBe('Channel 3');
    expect(channelDisplayName('   ', 0)).toBe('Channel 0');
  });
});

