/**
 * Voxel identity through real Zarrita decoding: with the native level model a
 * coarse brick reads the stored level plane-for-plane; the legacy model resamples
 * an XY-only pyramid's Z axis and drops planes.
 */
import { describe, it, expect } from 'vitest';
import { open, root } from 'zarrita';
import { LocalZarrDataProvider } from '../src/data/local-zarr-provider.js';

// Level 1 of an XY-only pyramid: z=3 planes kept, y=2, x=2. Value = z*100 + y*10 + x.
const Z = 3, Y = 2, X = 2;
const value = (z: number, y: number, x: number) => z * 100 + y * 10 + x;

async function openLevel1() {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  store.set('/.zarray', enc.encode(JSON.stringify({
    zarr_format: 2, shape: [Z, Y, X], chunks: [Z, Y, X], dtype: '|u1', compressor: null, fill_value: 0, order: 'C', filters: null,
  })));
  const data = new Uint8Array(Z * Y * X);
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) data[z * Y * X + y * X + x] = value(z, y, x);
  store.set('/0.0.0', data);
  return open(root(store), { kind: 'array' });
}

/** Provider stub with only level 1 populated; `virtualZ` is what the level model says the level's Z is. */
async function providerFor(virtualZ: number) {
  const p: any = new LocalZarrDataProvider({ name: 'xy-only.zarr' } as any);
  p.metadata = {
    name: 'xy-only', dimensions: [4, 4, Z], brickSize: 64, physicalBrickSize: 66, maxLod: 1,
    levels: [
      { lod: 0, dimensions: [4, 4, Z], brickGrid: [1, 1, 1], brickCount: 1 },
      { lod: 1, dimensions: [X, Y, virtualZ], brickGrid: [1, 1, 1], brickCount: 1 },
    ],
    bitDepth: 8, numChannels: 1,
  };
  const level1 = {
    scaleX: 1, scaleY: 1, scaleZ: Z / virtualZ,
    actualDimX: X, actualDimY: Y, actualDimZ: Z,
    csx: X, csy: Y, csz: Z, shapePrefixLength: 0, channelAxisIdx: -1, channelChunkSize: 1,
  };
  p.lodParams = [level1, level1];
  const arr = await openLevel1();
  p.arrays = [arr, arr];
  return p;
}

/** Core voxel (x, y, z) of the assembled 66³ brick (1-voxel ghost border). */
const core = (brick: Uint8Array, x: number, y: number, z: number) => brick[(z + 1) * 66 * 66 + (y + 1) * 66 + (x + 1)];

describe('brick assembly against the level model', () => {
  it('native: every stored Z plane of level 1 appears in the brick unchanged', async () => {
    const p = await providerFor(Z); // virtual Z == native Z
    const brick = (await p.loadBrick(1, 0, 0, 0)).data as Uint8Array;
    for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
      expect(core(brick, x, y, z)).toBe(value(z, y, x));
    }
  });

  it('legacy: virtual Z = ceil(3 / 2) = 2 resamples the axis and drops the middle plane', async () => {
    const p = await providerFor(2);
    const brick = (await p.loadBrick(1, 0, 0, 0)).data as Uint8Array;
    const planes = [0, 1].map(vz => core(brick, 0, 0, vz));
    expect(planes).toEqual([value(0, 0, 0), value(2, 0, 0)]); // plane z=1 is never sampled
  });

  it('native: the ghost border clamps to the volume edge instead of reading a neighbour level', async () => {
    const p = await providerFor(Z);
    const brick = (await p.loadBrick(1, 0, 0, 0)).data as Uint8Array;
    expect(brick[0]).toBe(value(0, 0, 0));                       // (-1,-1,-1) clamps to (0,0,0)
    expect(brick[(Z + 1) * 66 * 66 + (Y + 1) * 66 + (X + 1)]).toBe(value(Z - 1, Y - 1, X - 1));
  });
});

/** Level 1 store where only plane z=1 carries signal; everything else is zero. */
async function openOnePlaneLevel(channels = 1) {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const shape = channels > 1 ? [channels, Z, Y, X] : [Z, Y, X];
  const chunks = channels > 1 ? [1, Z, Y, X] : [Z, Y, X];
  store.set('/.zarray', enc.encode(JSON.stringify({
    zarr_format: 2, shape, chunks, dtype: '|u1', compressor: null, fill_value: 0, order: 'C', filters: null,
  })));
  for (let c = 0; c < channels; c++) {
    const data = new Uint8Array(Z * Y * X);
    for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) data[1 * Y * X + y * X + x] = 50 + c; // plane z=1 only
    store.set(channels > 1 ? `/${c}.0.0.0` : '/0.0.0', data);
  }
  return open(root(store), { kind: 'array' });
}

async function onePlaneProvider(virtualZ: number, channels = 1) {
  const p = await providerFor(virtualZ);
  const arr = await openOnePlaneLevel(channels);
  p.arrays = [arr, arr];
  p.metadata.numChannels = channels;
  const prefix = channels > 1 ? { shapePrefixLength: 1, channelAxisIdx: 0 } : { shapePrefixLength: 0, channelAxisIdx: -1 };
  p.lodParams = p.lodParams.map((l: object) => ({ ...l, ...prefix }));
  return p;
}

describe('synthetic one-plane signal (skipped-Z regression probe)', () => {
  it('native keeps the plane: the coarse brick is non-empty and the signal sits at z=1', async () => {
    const p = await onePlaneProvider(Z);
    const result = await p.loadBrick(1, 0, 0, 0);
    expect(result.max).toBe(50);
    expect(core(result.data, 0, 0, 1)).toBe(50);
  });

  it('legacy resampling drops the plane: the same brick is reported empty', async () => {
    const p = await onePlaneProvider(2);
    const result = await p.loadBrick(1, 0, 0, 0);
    expect(result.max).toBe(0);
  });

  it('native multichannel: each channel reads its own stored plane', async () => {
    const p = await onePlaneProvider(Z, 2);
    expect(core((await p.loadBrick(1, 0, 0, 0, 0)).data, 1, 1, 1)).toBe(50);
    expect(core((await p.loadBrick(1, 0, 0, 0, 1)).data, 1, 1, 1)).toBe(51);
  });
});
