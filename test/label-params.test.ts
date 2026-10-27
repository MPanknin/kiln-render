import { describe, expect, it } from 'vitest';
import { parseLabelParam, writeLabelParam } from '../examples/shared/label-params.js';
import type { LabelLayerState } from '../src/labels/label-layer.js';

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
