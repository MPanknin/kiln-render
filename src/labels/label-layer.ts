/**
 * One label image shown over the volume: its style, segment state (hidden, selected) and,
 * internally, which label brick labels each image atlas slot. Setters only
 * record the change; the LabelManager applies it on the next frame.
 */

import type { LabelImageInfo, LabelLevelParams } from '../data/label-image.js';
import { segmentName } from '../data/label-image.js';
import type { LabelReader } from '../data/label-reader.js';
import { LAYER_COLORS, resolveColor, segmentColor, unpackRgba } from './label-colors.js';
import type { Rgb, SegmentStyle } from './label-colors.js';

/** How a layer shows in 3D: shaded surfaces, a tint of the image, or not at all. */
export type Label3dStyle = 'surface' | 'tint' | 'off';
/** How a layer shows on slices: filled, outlined, both, or not at all. */
export type LabelSliceStyle = 'fill' | 'outline' | 'both' | 'off';

export interface LabelLayerOptions {
  /** Shown (default true; at most MAX_LABEL_LAYERS layers are shown at once) */
  visible?: boolean;
  /** 0–1 (default 0.8): surfaces and outlines at this opacity, slice fills at half of it */
  opacity?: number;
  /** Default 'surface' */
  style3d?: Label3dStyle;
  /** Default 'both' */
  slice?: LabelSliceStyle;
  /** One colour (0–255 RGB) for every segment; null or absent: per-segment colours */
  color?: Rgb | null;
  /** Segments not drawn */
  hidden?: readonly number[];
  /** Highlighted segments; with `isolate`, the only ones drawn */
  selected?: readonly number[];
  isolate?: boolean;
}

/** Serialisable state of a layer, e.g. for share URLs. */
export interface LabelLayerState extends Required<Omit<LabelLayerOptions, 'hidden' | 'selected'>> {
  source: string;
  hidden: number[];
  selected: number[];
}

/** A segment the metadata knows about. */
export interface LabelSegment {
  id: number;
  /** Name from `image-label.properties` (name, class, label or type), if any */
  name?: string;
  properties?: Record<string, unknown>;
}

/** What labels an image atlas slot: a uniform ID, a brick in the pool, or nothing. */
export type LabelBound = null | { kind: 'uniform'; id: number } | { kind: 'mixed'; brick: ResidentLabelBrick };

/** @internal A mixed label brick in the pool. */
export interface ResidentLabelBrick {
  key: string;
  layer: LabelLayer;
  /** Image level the brick belongs to (the shader maps positions with it) */
  lod: number;
  palette: Float64Array;
  /** Pool slot of the palette indices */
  slot: number;
  paletteOffset: number;
  /** Image atlas slots labelled by this brick (directly or while a finer brick loads) */
  refs: number;
}

/** @internal How one image atlas slot is labelled for this layer. */
export interface LabelBinding {
  lod: number;
  bx: number;
  by: number;
  bz: number;
  /** Key of the label brick at the slot's own address */
  key: string;
  bound: LabelBound;
  /** `bound` is that brick (false: an ancestor or nothing while it loads) */
  exact: boolean;
}

/** @internal The manager's side of a layer. */
export interface LabelLayerHost {
  layerChanged(layer: LabelLayer, what: 'visible' | 'style' | 'colors'): void;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

export class LabelLayer {
  /** As passed to add(): a name from the dataset's labels group or a URL */
  readonly source: string;
  readonly name: string;
  readonly info: LabelImageInfo;
  /** Things to know about this layer (e.g. levels without labels) */
  readonly notes: readonly string[];

  /** @internal */ readonly uid: number;
  /** @internal */ readonly levels: ReadonlyArray<LabelLevelParams | null>;
  /** @internal */ readonly reader: LabelReader;
  /** @internal Entry row while shown, else -1 */ row = -1;
  /** @internal Per image atlas slot */ bindings: Array<LabelBinding | undefined> = [];
  /** @internal Brick contents by key: 0 background, -1 mixed, else the one ID */ readonly summaries = new Map<string, number>();
  /** @internal Keys whose last load failed, with the time */ readonly failed = new Map<string, number>();
  /** @internal */ disposed = false;

  private _visible: boolean;
  private _opacity: number;
  private _style3d: Label3dStyle;
  private _slice: LabelSliceStyle;
  private _color: Rgb | null;
  private _isolate: boolean;
  private readonly hidden: Set<number>;
  private readonly selected: Set<number>;
  private readonly metadataColors: Map<number, readonly [number, number, number, number]>;
  private readonly seed: number;
  private style: SegmentStyle | null = null;

  /** @internal Created by LabelManager.add() */
  constructor(
    private readonly host: LabelLayerHost,
    uid: number,
    source: string,
    opened: { info: LabelImageInfo; levels: Array<LabelLevelParams | null>; notes: string[]; reader: LabelReader },
    options: LabelLayerOptions,
  ) {
    this.uid = uid;
    this.source = source;
    this.name = opened.info.name;
    this.info = opened.info;
    this.levels = opened.levels;
    this.notes = opened.notes;
    this.reader = opened.reader;
    this.seed = uid - 1;
    this.metadataColors = new Map(opened.info.colors.map(c => [c.value, c.rgba]));
    this._visible = options.visible ?? true;
    this._opacity = clamp01(options.opacity ?? 0.8);
    this._style3d = options.style3d ?? 'surface';
    this._slice = options.slice ?? 'both';
    this._color = options.color ?? null;
    this._isolate = options.isolate ?? false;
    this.hidden = new Set(options.hidden ?? []);
    this.selected = new Set(options.selected ?? []);
  }

  get visible(): boolean { return this._visible; }
  set visible(value: boolean) {
    if (value === this._visible) return;
    this._visible = value;
    this.host.layerChanged(this, 'visible');
  }

  get opacity(): number { return this._opacity; }
  set opacity(value: number) {
    const v = clamp01(value);
    if (v === this._opacity) return;
    this._opacity = v;
    this.host.layerChanged(this, 'style');
  }

  get style3d(): Label3dStyle { return this._style3d; }
  set style3d(value: Label3dStyle) {
    if (value === this._style3d) return;
    this._style3d = value;
    this.host.layerChanged(this, 'style');
  }

  get slice(): LabelSliceStyle { return this._slice; }
  set slice(value: LabelSliceStyle) {
    if (value === this._slice) return;
    this._slice = value;
    this.host.layerChanged(this, 'style');
  }

  /** One colour for every segment (0–255 RGB), or null for per-segment colours. */
  get color(): Rgb | null { return this._color && [...this._color] as Rgb; }
  set color(value: Rgb | null) {
    this._color = value && [...value] as Rgb;
    this.colorsChanged();
  }

  /** A colour for this layer when it is shown in one colour (distinct per layer). */
  get layerColor(): Rgb { return [...LAYER_COLORS[(this.uid - 1) % LAYER_COLORS.length]!] as Rgb; }

  segment(id: number): LabelSegment {
    const properties = this.info.properties.get(id);
    return { id, name: segmentName(properties), properties };
  }

  /** Colour segment `id` is drawn with, 0–255 RGBA (alpha 0: not drawn). */
  colorOf(id: number): [number, number, number, number] {
    return unpackRgba(resolveColor(id, this.segmentStyle()));
  }

  /** Colour of segment `id` ignoring hiding and selection, 0–255 RGB. */
  baseColorOf(id: number): Rgb {
    const meta = this.metadataColors.get(id);
    return this._color ?? (meta ? [meta[0], meta[1], meta[2]] : segmentColor(id, this.seed));
  }

  isHidden(id: number): boolean { return this.hidden.has(id); }
  get hiddenSegments(): ReadonlySet<number> { return this.hidden; }

  setHidden(ids: number | readonly number[], hidden: boolean): void {
    for (const id of typeof ids === 'number' ? [ids] : ids) {
      if (hidden) this.hidden.add(id);
      else this.hidden.delete(id);
    }
    this.colorsChanged();
  }

  /** Show every hidden segment again. */
  showAll(): void {
    this.hidden.clear();
    this.colorsChanged();
  }

  get selection(): ReadonlySet<number> { return this.selected; }

  /** Change the selection: replace it, add to it, or toggle the given segments. */
  select(ids: number | readonly number[], mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    const list = typeof ids === 'number' ? [ids] : ids;
    if (mode === 'replace') this.selected.clear();
    for (const id of list) {
      if (mode === 'toggle' && this.selected.has(id)) this.selected.delete(id);
      else if (id > 0) this.selected.add(id);
    }
    this.colorsChanged();
  }

  clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.colorsChanged();
  }

  /** Draw only the selected segments (while there are any). */
  get isolate(): boolean { return this._isolate; }
  set isolate(value: boolean) {
    if (value === this._isolate) return;
    this._isolate = value;
    this.colorsChanged();
  }

  /** @internal Inputs of resolveColor() for this layer, cached until something changes. */
  segmentStyle(): SegmentStyle {
    return this.style ??= {
      color: this._color, seed: this.seed, metadata: this.metadataColors,
      hidden: this.hidden, selected: this.selected, isolate: this._isolate,
    };
  }

  state(): LabelLayerState {
    return {
      source: this.source, visible: this._visible, opacity: this._opacity, style3d: this._style3d, slice: this._slice,
      color: this.color, isolate: this._isolate, hidden: [...this.hidden], selected: [...this.selected],
    };
  }

  private colorsChanged(): void {
    this.style = null;
    this.host.layerChanged(this, 'colors');
  }
}
