import { describe, expect, it } from 'vitest';
import { packRgba, resolveColor, segmentColor, unpackRgba, type SegmentStyle } from '../src/labels/label-colors.js';
import { RangeAllocator, SlotAllocator, paletteClassSize } from '../src/labels/allocators.js';
import { parseLabelParam, writeLabelParam } from '../examples/shared/label-params.js';
import type { LabelLayerState } from '../src/labels/label-layer.js';

const style = (over: Partial<SegmentStyle> = {}): SegmentStyle => ({
  color: null, seed: 0, metadata: new Map(), overrides: new Map(),
  hidden: new Set(), selected: new Set(), isolate: false, ...over,
});

describe('label colours', () => {
  it('packs RGBA as unpack4x8unorm reads it', () => {
    expect(packRgba(1, 2, 3, 255)).toBe(0xff030201);
    expect(unpackRgba(packRgba(10, 200, 30, 128))).toEqual([10, 200, 30, 128]);
    expect(unpackRgba(packRgba(-5, 300, 1.6, 0))).toEqual([0, 255, 2, 0]);
  });

  it('gives consecutive IDs and layers different generated colours', () => {
    const a = segmentColor(1), b = segmentColor(2), other = segmentColor(1, 1);
    const dist = (x: number[], y: number[]) => Math.hypot(...x.map((v, i) => v - y[i]!));
    expect(dist(a, b)).toBeGreaterThan(60);
    expect(dist(a, other)).toBeGreaterThan(60);
    expect(segmentColor(1)).toEqual(a); // deterministic
  });

  it('draws nothing for background, hidden IDs and transparent metadata colours', () => {
    expect(resolveColor(0, style())).toBe(0);
    expect(resolveColor(5, style({ hidden: new Set([5]) }))).toBe(0);
    expect(resolveColor(5, style({ metadata: new Map([[5, [255, 0, 0, 0]]]) }))).toBe(0);
    expect(resolveColor(5, style())).not.toBe(0);
  });

  it('prefers overrides, then the layer colour, then metadata', () => {
    const metadata = new Map([[5, [255, 0, 0, 128] as const]]);
    expect(unpackRgba(resolveColor(5, style({ metadata })))).toEqual([255, 0, 0, 128]);
    expect(unpackRgba(resolveColor(5, style({ metadata, color: [0, 255, 0] })))).toEqual([0, 255, 0, 255]);
    const overrides = new Map([[5, [0, 0, 255] as [number, number, number]]]);
    expect(unpackRgba(resolveColor(5, style({ metadata, color: [0, 255, 0], overrides })))).toEqual([0, 0, 255, 255]);
  });

  it('lightens the selection and dims or hides the rest', () => {
    const s = style({ color: [100, 0, 0], selected: new Set([1]) });
    const [r, g, , a] = unpackRgba(resolveColor(1, s));
    expect(r).toBeGreaterThan(100);
    expect(g).toBeGreaterThan(0);
    expect(a).toBe(255);
    expect(unpackRgba(resolveColor(2, s))[3]).toBe(Math.round(255 * 0.3));
    expect(resolveColor(2, { ...s, isolate: true })).toBe(0);
    expect(resolveColor(2, style({ isolate: true }))).not.toBe(0); // isolate without a selection shows all
  });
});

describe('label pool allocators', () => {
  it('hands out low slots first and reuses released ones', () => {
    const slots = new SlotAllocator();
    slots.grow(4);
    expect(slots.alloc(2)).toEqual([0, 1]);
    expect(slots.alloc(3)).toBeNull();
    expect(slots.usedCount).toBe(2);
    slots.release([0]);
    slots.grow(2);
    expect(slots.alloc(1)).toEqual([0]);
    expect(slots.alloc(4)).toEqual([2, 3, 4, 5]);
    expect(slots.freeCount).toBe(0);
    expect(slots.capacity).toBe(6);
  });

  it('rounds palettes up to powers of four', () => {
    expect([1, 4, 5, 16, 17, 287497].map(paletteClassSize)).toEqual([4, 4, 16, 16, 64, 1048576]);
  });

  it('reuses freed ranges of the same class and grows by doubling', () => {
    const ranges = new RangeAllocator(32);
    expect(ranges.alloc(3)).toBe(0);
    expect(ranges.alloc(10)).toBe(4);
    expect(ranges.alloc(16)).toBeNull(); // 20 + 16 > 32
    expect(ranges.growFor(16)).toBe(64);
    expect(ranges.alloc(16)).toBe(20);
    ranges.release(4, 10);
    expect(ranges.usedCount).toBe(20);
    expect(ranges.alloc(12)).toBe(4);
    ranges.reset(8);
    expect(ranges.alloc(4)).toBe(0);
    expect(ranges.capacity).toBe(8);
  });
});

describe('labels URL parameter', () => {
  const state = (over: Partial<LabelLayerState>): LabelLayerState => ({
    source: 'cells', visible: true, opacity: 0.8, style3d: 'surface', slice: 'both',
    color: null, isolate: false, hidden: [], selected: [], ...over,
  });

  it('leaves defaults out', () => {
    expect(writeLabelParam([state({}), state({ source: 'nuclei', style3d: 'tint' })])).toBe('cells,nuclei:0.8:tint');
  });

  it('round-trips every setting', () => {
    const layers = [
      state({ source: 'https://example.com/a.zarr/labels/x:y', visible: false, opacity: 0.35, slice: 'outline', color: [255, 8, 0], isolate: true, selected: [12, 3000000007], hidden: [4] }),
      state({ source: 'nuclei', style3d: 'off', slice: 'off' }),
    ];
    const param = writeLabelParam(layers);
    expect(param.split(',')).toHaveLength(2);
    const parsed = parseLabelParam(param);
    expect(parsed[0]).toEqual({
      source: layers[0]!.source, visible: false, opacity: 0.35, style3d: 'surface', slice: 'outline',
      color: [255, 8, 0], isolate: true, selected: [12, 3000000007], hidden: [4],
    });
    expect(parsed[1]).toEqual({ source: 'nuclei', opacity: 0.8, style3d: 'off', slice: 'off' });
  });

  it('ignores what it does not understand', () => {
    expect(parseLabelParam(null)).toEqual([]);
    expect(parseLabelParam(',,-,%E0%A4%A')).toEqual([]);
    expect(parseLabelParam('cells:2:glow:none:zzz:s-1.hx.q')).toEqual([{ source: 'cells', opacity: 1 }]);
  });
});
