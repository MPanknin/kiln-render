/**
 * Sharded binary path: dtype-aware conversion, Range-response validation,
 * and uncompressed bricks going through the same conversion as compressed ones.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { convertBrickBytes, brickElementView } from '../src/data/brick-convert.js';
import { ShardedDataProvider } from '../src/data/sharded-provider.js';
import { getUint16ToFloat16Lut } from '../src/utils/float16.js';

describe('convertBrickBytes', () => {
  const u16 = (...v: number[]) => new Uint8Array(new Uint16Array(v).buffer);

  it('uint8 source passes through for any target', () => {
    const raw = new Uint8Array([1, 2, 3, 4]);
    expect(convertBrickBytes(raw, 'uint8', 'r8unorm')).toBe(raw);
    expect(convertBrickBytes(raw, 'uint8', 'r16float')).toBe(raw);
  });

  it('uint16 → r8unorm keeps the high byte', () => {
    expect(Array.from(convertBrickBytes(u16(0x1234, 0xff00), 'uint16', 'r8unorm'))).toEqual([0x12, 0xff]);
  });

  it('uint16 → r16float encodes value / 65535 as float16 bits', () => {
    const lut = getUint16ToFloat16Lut();
    const out = convertBrickBytes(u16(0, 1000, 65535), 'uint16', 'r16float');
    expect(out).toBeInstanceOf(Uint16Array);
    expect(Array.from(out)).toEqual([lut[0], lut[1000], lut[65535]]);
  });

  it('uint16 → r16unorm is a plain 16-bit view', () => {
    expect(Array.from(convertBrickBytes(u16(7, 9), 'uint16', 'r16unorm'))).toEqual([7, 9]);
  });

  it('brickElementView matches the element size the conversion produced', () => {
    const bytes = new Uint8Array([1, 0, 2, 0]);
    expect(brickElementView(bytes, 'uint16', 'r16float')).toBeInstanceOf(Uint16Array);
    expect(brickElementView(bytes, 'uint16', 'r8unorm')).toBe(bytes);
    expect(brickElementView(bytes, 'uint8', 'r8unorm')).toBe(bytes);
  });
});

describe('ShardedDataProvider.loadBrick — Range validation and conversion', () => {
  afterEach(() => vi.unstubAllGlobals());

  const entry = { offset: 100, size: 4, min: 0, max: 9, avg: 1 };

  function makeProvider(format: 'uint8' | 'uint16', target: 'r8unorm' | 'r16float' | 'r16unorm') {
    const p: any = new ShardedDataProvider('https://fixture.invalid');
    p.rawMetadata = { format, compressed: false, levels: [{ lod: 0, bricks: [1, 1, 1], binFile: 'lod0.bin', indexFile: 'i.json' }] };
    p.lodIndices.set(0, { entries: { '0/0/0': entry } });
    p.setTargetFormat(target);
    return p;
  }

  function response(status: number, headers: Record<string, string>, body: Uint8Array) {
    const cancel = vi.fn();
    return {
      status, ok: status < 300, body: { cancel },
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      cancel,
    };
  }

  it('accepts a 206 covering exactly the requested range', async () => {
    const p = makeProvider('uint8', 'r8unorm');
    vi.stubGlobal('fetch', vi.fn(async () => response(206, { 'content-range': 'bytes 100-103/5000' }, new Uint8Array([1, 2, 3, 4]))));
    const brick = await p.loadBrick(0, 0, 0, 0);
    expect(Array.from(brick.data)).toEqual([1, 2, 3, 4]);
  });

  it('accepts a 206 without a readable Content-Range (CORS hides it) when the body length matches', async () => {
    const p = makeProvider('uint8', 'r8unorm');
    vi.stubGlobal('fetch', vi.fn(async () => response(206, {}, new Uint8Array([1, 2, 3, 4]))));
    expect(Array.from((await p.loadBrick(0, 0, 0, 0)).data)).toEqual([1, 2, 3, 4]);
  });

  it('rejects a 206 whose Content-Range does not match', async () => {
    const p = makeProvider('uint8', 'r8unorm');
    vi.stubGlobal('fetch', vi.fn(async () => response(206, { 'content-range': 'bytes 0-3/5000' }, new Uint8Array(4))));
    expect(await p.loadBrick(0, 0, 0, 0)).toBeNull();
  });

  it('rejects a 200 whole-file response without reading its body', async () => {
    const p = makeProvider('uint8', 'r8unorm');
    const res = response(200, { 'content-length': '5000' }, new Uint8Array(5000));
    vi.stubGlobal('fetch', vi.fn(async () => res));
    expect(await p.loadBrick(0, 0, 0, 0)).toBeNull();
    expect(res.cancel).toHaveBeenCalled();
  });

  it('accepts a 200 whose body is exactly the brick', async () => {
    const p = makeProvider('uint8', 'r8unorm');
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { 'content-length': '4' }, new Uint8Array([5, 6, 7, 8]))));
    expect(Array.from((await p.loadBrick(0, 0, 0, 0)).data)).toEqual([5, 6, 7, 8]);
  });

  it('rejects a short body even with a valid Content-Range', async () => {
    const p = makeProvider('uint8', 'r8unorm');
    vi.stubGlobal('fetch', vi.fn(async () => response(206, { 'content-range': 'bytes 100-103/5000' }, new Uint8Array(2))));
    expect(await p.loadBrick(0, 0, 0, 0)).toBeNull();
  });

  it('converts uncompressed uint16 to float16 bits for an r16float target', async () => {
    const p = makeProvider('uint16', 'r16float');
    const body = new Uint8Array(new Uint16Array([1000, 65535]).buffer);
    vi.stubGlobal('fetch', vi.fn(async () => response(206, { 'content-range': 'bytes 100-103/5000' }, body)));
    const brick = await p.loadBrick(0, 0, 0, 0);
    const lut = getUint16ToFloat16Lut();
    expect(brick.data).toBeInstanceOf(Uint16Array);
    expect(Array.from(brick.data)).toEqual([lut[1000], lut[65535]]);
  });

  it('counts metadata and index requests in the network stats', async () => {
    const p: any = new ShardedDataProvider('https://fixture.invalid');
    const volume = JSON.stringify({ format: 'uint8', levels: [{ lod: 0, indexFile: 'i.json', dimensions: [1, 1, 1], bricks: [1, 1, 1], brickCount: 1, binFile: 'b' }], originalDimensions: [1, 1, 1], voxelSpacing: [1, 1, 1], brickSize: 64, physicalSize: 66, maxLod: 0 });
    const index = JSON.stringify({ entries: {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, text: async () => (url.endsWith('volume.json') ? volume : index) })));
    await p.initialize();
    await p.getBrickStats(0, 0, 0, 0);
    expect(p.getNetworkStats().requestCount).toBe(2);
  });
});

describe('ShardedDataProvider — pyramid policy', () => {
  const raw = (dims: number[][]) => ({
    name: 'p', originalDimensions: dims[0], voxelSpacing: [1, 1, 2], brickSize: 64, physicalSize: 66, maxLod: dims.length - 1,
    format: 'uint8', packed: true, createdAt: '',
    levels: dims.map((d, lod) => ({ lod, dimensions: d, bricks: [1, 1, 1], brickCount: 1, binFile: 'b', indexFile: 'i' })),
  });

  it('builds a validated pyramid from the pre-baked level dims and spacing', () => {
    const p: any = new ShardedDataProvider('https://fixture.invalid');
    const meta = p.convertMetadata(raw([[1024, 1024, 1080], [512, 512, 540], [256, 256, 270]]));
    expect(meta.pyramidIssues).toEqual([]);
    expect(meta.pyramid.map((l: any) => l.exponent)).toEqual([[0, 0, 0], [1, 1, 1], [2, 2, 2]]);
    expect(meta.pyramid[2].spacing).toEqual([4, 4, 8]);
    expect(meta.pyramidPolicy).toBe('native');
  });

  it('native mode rejects unsupported level steps', () => {
    const p: any = new ShardedDataProvider('https://fixture.invalid');
    p.setPyramidPolicy('native');
    expect(() => p.convertMetadata(raw([[900, 900, 900], [300, 300, 300]]))).toThrow(/downsampling factor 3/);
  });
});
