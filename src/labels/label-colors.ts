/**
 * Segment colours, resolved on the CPU into the per-brick palettes the shaders read, so a
 * shader never hashes IDs or looks up styles: hiding, isolating, selecting or recolouring a
 * segment only rewrites palette entries.
 */

export type Rgb = [number, number, number];

/** 0–255 RGBA packed as WGSL's unpack4x8unorm reads it (r in the low byte). */
export function packRgba(r: number, g: number, b: number, a: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(r) | (c(g) << 8) | (c(b) << 16) | (c(a) << 24)) >>> 0;
}

export function unpackRgba(packed: number): [number, number, number, number] {
  return [packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff, packed >>> 24];
}

function hsv(h: number, s: number, v: number): Rgb {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  const rgb = ([[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]] as const)[i]!;
  return [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255];
}

/**
 * A colour for an ID without one: hues step by the golden ratio, so consecutive IDs (usually
 * neighbours in instance segmentations) differ clearly; saturation and value vary a little more.
 * `seed` shifts the hues per layer, so ID 1 of two binary masks differs.
 */
export function segmentColor(id: number, seed = 0): Rgb {
  const n = id % 1_000_003;
  const hue = (n * 0.6180339887 + seed * 0.3819660113) % 1;
  let h = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return hsv(hue, 0.6 + ((h & 3) / 3) * 0.3, 0.8 + (((h >>> 2) & 3) / 3) * 0.2);
}

/** Distinct colours for layers shown in one colour, in the order layers are added. */
export const LAYER_COLORS: Rgb[] = [
  [255, 196, 0], [0, 200, 255], [255, 64, 129], [118, 255, 3],
  [170, 0, 255], [255, 109, 0], [0, 230, 118], [41, 121, 255],
];

/** What decides a segment's colour; a layer's style. */
export interface SegmentStyle {
  /** One colour for every segment; null: per-segment colours */
  color: Rgb | null;
  /** Per-layer hue shift for generated colours */
  seed: number;
  /** Colours from metadata (`image-label.colors`), RGBA 0–255 */
  metadata: ReadonlyMap<number, readonly [number, number, number, number]>;
  /** Colours set by the user */
  overrides: ReadonlyMap<number, Rgb>;
  hidden: ReadonlySet<number>;
  selected: ReadonlySet<number>;
  /** Show only selected segments */
  isolate: boolean;
}

/** How much of a segment shows when others are selected and it isn't. */
const UNSELECTED_ALPHA = 0.3;

/** Packed RGBA of segment `id` (0: not drawn). */
export function resolveColor(id: number, style: SegmentStyle): number {
  if (id === 0 || style.hidden.has(id)) return 0;
  const selected = style.selected.has(id);
  if (style.isolate && style.selected.size > 0 && !selected) return 0;
  const meta = style.metadata.get(id);
  let rgb: Rgb = style.overrides.get(id) ?? style.color ?? (meta ? [meta[0], meta[1], meta[2]] : segmentColor(id, style.seed));
  let alpha = style.overrides.has(id) || style.color ? 255 : meta?.[3] ?? 255;
  if (alpha === 0) return 0;
  if (selected) {
    // Lighter and fully opaque, so it stands out at any opacity
    rgb = rgb.map(v => v + (255 - v) * 0.35) as Rgb;
    alpha = 255;
  } else if (style.selected.size > 0) {
    alpha *= UNSELECTED_ALPHA;
  }
  return packRgba(rgb[0], rgb[1], rgb[2], Math.max(1, alpha));
}
