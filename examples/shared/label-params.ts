/**
 * `?labels=` share-URL parameter: label layers in drawing priority, comma-separated, each
 * `source[:opacity[:3d[:slices[:colour[:segments]]]]]`. The source is URI-encoded (it may be a
 * URL); a leading `-` marks a hidden layer. Colour is `auto` (per segment) or hex RGB. Segments
 * are dot-separated: `i` shows only the selected ones, `s12` selects 12, `h3` hides 3.
 * Trailing fields at their defaults are left out, so `?labels=cells,nuclei` is valid.
 */
import type { Label3dStyle, LabelLayerOptions, LabelLayerState, LabelSliceStyle } from 'kiln-render';

export type LabelParam = LabelLayerOptions & { source: string };

const STYLES_3D: Label3dStyle[] = ['surface', 'tint', 'off'];
const STYLES_SLICE: LabelSliceStyle[] = ['fill', 'outline', 'both', 'off'];
const DEFAULTS = { opacity: 0.8, style3d: 'surface', slice: 'both' } as const;

const hex = (rgb: readonly number[]) => rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

export function parseLabelParam(value: string | null): LabelParam[] {
  if (!value) return [];
  return value.split(',').filter(Boolean).flatMap((item): LabelParam[] => {
    const [rawSource = '', opacity, style3d, slice, color, segments] = item.split(':');
    const hidden = rawSource.startsWith('-');
    let source: string;
    try { source = decodeURIComponent(hidden ? rawSource.slice(1) : rawSource); } catch { return []; }
    if (!source) return [];
    const layer: LabelParam = { source };
    if (hidden) layer.visible = false;
    const o = Number(opacity);
    if (opacity && Number.isFinite(o)) layer.opacity = Math.max(0, Math.min(1, o));
    if (STYLES_3D.includes(style3d as Label3dStyle)) layer.style3d = style3d as Label3dStyle;
    if (STYLES_SLICE.includes(slice as LabelSliceStyle)) layer.slice = slice as LabelSliceStyle;
    if (color && /^[0-9a-f]{6}$/i.test(color)) {
      const n = parseInt(color, 16);
      layer.color = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    for (const token of segments?.split('.') ?? []) {
      const id = Number(token.slice(1));
      if (token === 'i') layer.isolate = true;
      else if (token[0] === 's' && id > 0) (layer.selected = [...layer.selected ?? [], id]);
      else if (token[0] === 'h' && id > 0) (layer.hidden = [...layer.hidden ?? [], id]);
    }
    return [layer];
  });
}

export function writeLabelParam(layers: readonly LabelLayerState[]): string {
  return layers.map((l) => {
    const segments = [
      ...(l.isolate ? ['i'] : []), ...l.selected.map(id => `s${id}`), ...l.hidden.map(id => `h${id}`),
    ].join('.');
    const fields = [
      l.opacity === DEFAULTS.opacity ? '' : String(+l.opacity.toFixed(2)),
      l.style3d === DEFAULTS.style3d ? '' : l.style3d,
      l.slice === DEFAULTS.slice ? '' : l.slice,
      l.color ? hex(l.color) : '',
      segments,
    ];
    while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
    const filled = fields.map((f, i) => f || [String(DEFAULTS.opacity), DEFAULTS.style3d, DEFAULTS.slice, 'auto', ''][i]);
    return [(l.visible ? '' : '-') + encodeURIComponent(l.source), ...filled].join(':');
  }).join(',');
}
