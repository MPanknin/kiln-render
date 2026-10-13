import { describe, it, expect } from 'vitest';
import { open, root } from 'zarrita';
import { LocalZarrDataProvider } from '../src/data/local-zarr-provider.js';
import { resolveSourceSelection } from '../src/data/source-selection.js';
import { chunkCoords, chunkLayout } from '../src/data/chunk-math.js';

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const attrs = { multiscales: [{ axes: ['t', 'c', 'z', 'y', 'x'], datasets: [{ path: '0' }] }],
  omero: { channels: Array.from({ length: 6 }, (_, c) => ({ label: `marker ${c}`, color: c === 5 ? 'FF0000' : '00FF00',
    active: c !== 3, window: { start: c, end: c + 10, min: 0, max: 255 } })) } };

function metadataProvider(selection = {}) {
  const p: any = new LocalZarrDataProvider({ name: 'fixture' } as any);
  p.setSourceSelection(selection);
  const parsed = p.parseOmeMetadata(attrs, [{ shape: [4, 6, 2, 3, 4], chunks: [2, 3, 2, 3, 4], dtype: 'uint8' }], 'fixture');
  Object.assign(p, parsed);
  return p;
}

describe('source selection contract', () => {
  it('defaults to first four channels and timepoint zero while keeping all source metadata', () => {
    const m = metadataProvider().getMetadata();
    expect(m).toMatchObject({ numChannels: 4, sourceChannelCount: 6, sourceChannels: [0, 1, 2, 3], timepointCount: 4, timepoint: 0 });
    expect(m.sourceChannelMetadata).toHaveLength(6);
  });
  it('maps labels, colours, visibility and windows into selected slot order', () => {
    const p = metadataProvider({ sourceChannels: [5, 3], timepoint: 3 });
    expect(p.getMetadata()).toMatchObject({ numChannels: 2, sourceChannels: [5, 3], timepoint: 3,
      channels: [{ label: 'marker 5', color: [1, 0, 0], active: true }, { label: 'marker 3', active: false }],
      window: { start: 5 }, channelWindows: [{ start: 5 }, { start: 3 }] });
    expect(p.lodParams[0]).toMatchObject({ timeAxisIdx: 0, timeChunkSize: 2, timepoint: 3 });
  });
  it('switches the live metadata in place after initialize', () => {
    const p = metadataProvider({ sourceChannels: [5, 3], timepoint: 3 });
    p.brickStatsCache.set('0:0/0/0', { min: 0, max: 9, avg: 1 });
    p.setSourceSelection({ sourceChannels: [0, 2], timepoint: 1 });
    expect(p.getMetadata()).toMatchObject({ numChannels: 2, sourceChannels: [0, 2], timepoint: 1,
      channels: [{ label: 'marker 0' }, { label: 'marker 2' }], window: { start: 0 }, channelWindows: [{ start: 0 }, { start: 2 }] });
    expect(p.lodParams[0].timepoint).toBe(1);
    expect(p.brickStatsCache.size).toBe(0); // emptiness belonged to the old selection
    // A rejected selection changes nothing
    expect(() => p.setSourceSelection({ sourceChannels: [9] })).toThrow();
    expect(p.getMetadata()).toMatchObject({ sourceChannels: [0, 2], timepoint: 1 });
  });
  it.each([[], [0, 0], [6], [-1], [0.5], [NaN], [0, 1, 2, 3, 4]])('rejects invalid source channel selection %j', (...indices) => {
    // Vitest spreads array cases into arguments.
    expect(() => resolveSourceSelection({ sourceChannels: indices as number[] }, 6, 4)).toThrow();
  });
  it.each([-1, 4, 0.5, NaN, Infinity])('rejects invalid timepoint %s', timepoint => {
    expect(() => resolveSourceSelection({ timepoint }, 6, 4)).toThrow(/Timepoint/);
  });
  it('rejects mismatched non-spatial axes across LODs', () => {
    const p: any = new LocalZarrDataProvider({ name: 'fixture' } as any);
    const arrays = [4, 3].map(t => ({ shape: [t, 6, 4, 4, 4], chunks: [1, 1, 4, 4, 4], dtype: 'uint8' }));
    expect(() => p.parseOmeMetadata(attrs, arrays, 'fixture')).toThrow(/must match/);
  });
  it('handles no channel or time axis as single-channel/timepoint', () => {
    const p: any = new LocalZarrDataProvider({ name: 'fixture' } as any);
    const { metadata } = p.parseOmeMetadata({ multiscales: [{ axes: ['z', 'y', 'x'], datasets: [{ path: '0' }] }] },
      [{ shape: [2, 3, 4], chunks: [2, 3, 4], dtype: 'uint8' }], 'fixture');
    expect(metadata).toMatchObject({ sourceChannels: [0], timepoint: 0, timepointCount: 1 });
  });
});

describe('packed time/channel addressing', () => {
  it('addresses time chunks and in-chunk offsets independently of spatial ordering', () => {
    expect(chunkCoords(2, 1, 3, 5, 7, 8, 9, [0, 1, 2], 0, 2, 3)).toEqual([1, 1, 9, 8, 7]);
    const layout = chunkLayout({ shape: [2, 3, 4, 3, 2], stride: [1, 2, 6, 24, 72] }, 1, 3, 5, [0, 1, 2], 0, 2, 3);
    expect(layout).toEqual({ base: 5, strideX: 6, strideY: 24, strideZ: 72 });
  });
  it.each([['C', 2], ['F', 2], ['C', 3], ['F', 3]])('reads every source voxel at t=3, channels [5,1], order=%s, Zarr v%s through real decoding', async (order, version) => {
    const shape = [4, 6, 2, 3, 4], chunks = [2, 3, 2, 3, 4];
    const store = new Map<string, Uint8Array>();
    if (version === 2) {
      store.set('/.zarray', encode({ zarr_format: 2, shape, chunks, dtype: '|u1', compressor: null, fill_value: 0, order, filters: null }));
    } else {
      store.set('/zarr.json', encode({ zarr_format: 3, node_type: 'array', shape, data_type: 'uint8',
        chunk_grid: { name: 'regular', configuration: { chunk_shape: chunks } },
        chunk_key_encoding: { name: 'v2', configuration: { separator: '.' } }, fill_value: 0, attributes: {},
        dimension_names: ['t', 'c', 'z', 'y', 'x'], codecs: [
          ...(order === 'F' ? [{ name: 'transpose', configuration: { order: [4, 3, 2, 1, 0] } }] : []),
          { name: 'bytes', configuration: { endian: 'little' } },
        ],
      }));
    }
    const value = (t: number, c: number, z: number, y: number, x: number) => t * 50 + c * 10 + z * 5 + y + x;
    for (let tc = 0; tc < 2; tc++) for (let cc = 0; cc < 2; cc++) {
      const data = new Uint8Array(144);
      for (let t = 0; t < 2; t++) for (let c = 0; c < 3; c++) for (let z = 0; z < 2; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
        const index = order === 'C' ? ((((t * 3 + c) * 2 + z) * 3 + y) * 4 + x) : t + 2 * (c + 3 * (z + 2 * (y + 3 * x)));
        data[index] = value(tc * 2 + t, cc * 3 + c, z, y, x);
      }
      store.set(`/${tc}.${cc}.0.0.0`, data);
    }
    const array = await open(root(store), { kind: 'array' });
    const p = metadataProvider({ sourceChannels: [5, 1], timepoint: 3 });
    p.arrays = [array];
    for (let slot = 0; slot < 2; slot++) {
      const { data } = await p.loadBrick(0, 0, 0, 0, slot);
      for (let z = 0; z < 2; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
        expect(data[(z + 1) * 66 * 66 + (y + 1) * 66 + x + 1]).toBe(value(3, [5, 1][slot]!, z, y, x));
      }
      expect(data[0]).toBe(value(3, [5, 1][slot]!, 0, 0, 0));
    }
  });
});
