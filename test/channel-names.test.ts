import { describe, it, expect } from 'vitest';
import { channelDisplayName, hiddenChannelsNote } from '../examples/shared/channel-names.js';

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

describe('hiddenChannelsNote', () => {
  it('is null when every channel is shown', () => {
    expect(hiddenChannelsNote(2, 2)).toBeNull();
    expect(hiddenChannelsNote(4, 4)).toBeNull();
  });

  it('names the shown and total counts when channels are dropped', () => {
    expect(hiddenChannelsNote(4, 6)).toBe('Showing the first 4 of 6 channels');
  });
});
