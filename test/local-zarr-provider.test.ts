import { describe, it, expect, vi } from 'vitest';
import { LocalZarrDataProvider } from '../src/data/local-zarr-provider.js';

describe('LocalZarrDataProvider', () => {
  it('fetches the rounded endpoint chunk on odd scales instead of clamping to the previous chunk', async () => {
    const provider = new LocalZarrDataProvider({ name: 'test.zarr' } as FileSystemDirectoryHandle);

    const getChunk = vi.fn(async ([_cz, _cy, cx]: number[]) => ({
      shape: [1, 1, 64],
      data: Uint8Array.from({ length: 64 }, (_, localX) => cx * 64 + localX),
    }));

    (provider as any).metadata = {
      name: 'test',
      dimensions: [1023, 1, 1],
      brickSize: 64,
      physicalBrickSize: 66,
      maxLod: 0,
      levels: [{ lod: 0, dimensions: [1023, 1, 1], brickGrid: [1, 1, 1], brickCount: 1 }],
      bitDepth: 8,
      numChannels: 1,
    };
    (provider as any).lodParams = [{
      scaleX: 1023 / 512,
      scaleY: 1,
      scaleZ: 1,
      actualDimX: 1023,
      actualDimY: 1,
      actualDimZ: 1,
      csx: 64,
      csy: 1,
      csz: 1,
      shapePrefixLength: 0,
      channelAxisIdx: -1,
    }];
    (provider as any).arrays = [{ getChunk }];

    const brick = await provider.loadBrick(0, 0, 0, 0);

    expect(brick).not.toBeNull();
    expect(getChunk).toHaveBeenCalledTimes(3);
    expect(getChunk).toHaveBeenCalledWith([0, 0, 0]);
    expect(getChunk).toHaveBeenCalledWith([0, 0, 1]);
    expect(getChunk).toHaveBeenCalledWith([0, 0, 2]);
    expect(brick!.data[65]).toBe(128);
  });
});
