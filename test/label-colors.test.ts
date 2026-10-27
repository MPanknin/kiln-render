import { describe, expect, it } from 'vitest';
import { packRgba, resolveColor, segmentColor, unpackRgba, type SegmentStyle } from '../src/labels/label-colors.js';

const style = (over: Partial<SegmentStyle> = {}): SegmentStyle => ({
  color: null, seed: 0, metadata: new Map(),
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

  it('prefers the layer colour, then metadata', () => {
    const metadata = new Map([[5, [255, 0, 0, 128] as const]]);
    expect(unpackRgba(resolveColor(5, style({ metadata })))).toEqual([255, 0, 0, 128]);
    expect(unpackRgba(resolveColor(5, style({ metadata, color: [0, 255, 0] })))).toEqual([0, 255, 0, 255]);
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
