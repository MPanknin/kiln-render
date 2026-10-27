/**
 * Labels panel: the dataset's label images (segmentations) as layers. Each layer card has its
 * visibility, colour and name; its settings open below it: opacity, how it shows in 3D and on
 * slices, per-segment or single colour, and segment tools (selection, hiding, show only selected,
 * find by ID). Hovering a view shows the segments under the cursor; clicking selects one
 * (Shift: add / remove), Esc clears the selection.
 */
import type { KilnViewer, LabelHit, LabelLayer, LabelPick } from 'kiln-render';
import { MAX_LABEL_LAYERS } from 'kiln-render';
import { createColorSwatch, createPanel, createSegmentedControl, createSlider, createToggle } from './controls/widgets.js';
import type { Shortcut } from './shortcuts.js';

type Rgb = [number, number, number];

const MULTI_SWATCH_SVG = '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1" y="1" width="6" height="6" rx="1" fill="#ff6b6b"/><rect x="9" y="1" width="6" height="6" rx="1" fill="#ffd166"/><rect x="1" y="9" width="6" height="6" rx="1" fill="#06d6a0"/><rect x="9" y="9" width="6" height="6" rx="1" fill="#4cc9f0"/></svg>';
const MORE_SVG = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg>';

const css = (rgb: readonly number[], a = 1) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
const formatBytes = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} MB`;
const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

export interface LabelsPanel {
  /** Rebuild from the layers (after changes made elsewhere, e.g. a URL). */
  refresh(): void;
  /** Keyboard shortcuts for the help overlay and handling: L, H, I. */
  shortcuts: Shortcut[];
}

export interface LabelsPanelOptions {
  /** Called after any change worth keeping in a share URL */
  onChange?: () => void;
  /** Brief messages (errors when adding layers) */
  notify?: (message: string) => void;
}

/** Mount the panel into `dock` (the column of panels on the left). */
export function mountLabelsPanel(viewer: KilnViewer, dock: HTMLElement, options: LabelsPanelOptions = {}): LabelsPanel {
  const labels = viewer.labels;
  const expanded = new Set<LabelLayer>();
  const { el: panelEl, body, setCollapsed } = createPanel('Labels', {
    defaultCollapsed: labels.available.length === 0 && labels.layers.length === 0 ? true : undefined,
  });
  panelEl.classList.add('lbl-panel');
  dock.appendChild(panelEl);

  const list = document.createElement('div');
  list.className = 'lbl-layers';
  const add = document.createElement('div');
  add.className = 'lbl-add';
  const hint = document.createElement('div');
  hint.className = 'lbl-hint';
  hint.textContent = 'Hover a segment to identify it. Click selects, Shift-click adds, Esc clears.';
  const footer = document.createElement('div');
  footer.className = 'lbl-footer ctl-mono';
  body.append(list, add, hint, footer);

  const changed = () => options.onChange?.();
  const fail = (what: string, e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    options.notify?.(`${what}: ${message}`);
    console.warn(`[Kiln] ${what}:`, e);
  };

  // ---------------------------------------------------------------------------------------------
  // Layer cards

  const render = () => {
    list.replaceChildren(...labels.layers.map(layerCard));
    renderAdd();
    hint.hidden = labels.layers.every(l => !l.visible);
    updateFooter();
  };

  const layerCard = (layer: LabelLayer): HTMLElement => {
    const card = document.createElement('div');
    card.className = 'ctl-channel-group lbl-layer';
    card.classList.toggle('off', !layer.visible);

    const row = document.createElement('div');
    row.className = 'ctl-channel-row';

    const swatch = layer.color
      ? createColorSwatch({ value: rgbObject(layer.color), onChange: (c) => { layer.color = [c.r, c.g, c.b]; changed(); } }).el
      : multiSwatch(() => toggleExpanded(layer));
    swatch.setAttribute('aria-label', `${layer.name} colour`);

    const name = document.createElement('span');
    name.className = 'ctl-channel-name';
    name.textContent = layer.name;
    name.title = [layer.source, `${layer.info.dtype}, ${layer.info.arrays.length} level${layer.info.arrays.length === 1 ? '' : 's'}`, ...layer.notes].join('\n');

    const visible = createToggle({
      label: '', ariaLabel: `Show ${layer.name}`, value: layer.visible,
      onChange: (v) => {
        try {
          layer.visible = v;
        } catch (e) {
          fail(`Can't show ${layer.name}`, e);
          visible.setValue(false);
          return;
        }
        card.classList.toggle('off', !v);
        hint.hidden = labels.layers.every(l => !l.visible);
        changed();
      },
    });

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'lbl-icon-button';
    more.innerHTML = MORE_SVG;
    more.title = `${layer.name} settings`;
    more.setAttribute('aria-expanded', String(expanded.has(layer)));
    more.addEventListener('click', () => toggleExpanded(layer));

    row.append(swatch, name, more, visible.el);
    card.append(row);
    if (layer.notes.length > 0) {
      const note = document.createElement('div');
      note.className = 'lbl-note';
      note.textContent = layer.notes.join(' · ');
      card.append(note);
    }
    if (expanded.has(layer)) card.append(layerSettings(layer));
    card.append(selectionStrip(layer));
    return card;
  };

  const toggleExpanded = (layer: LabelLayer) => {
    if (expanded.has(layer)) expanded.delete(layer);
    else expanded.add(layer);
    render();
  };

  const layerSettings = (layer: LabelLayer): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'lbl-settings';

    const opacity = createSlider({
      label: 'Opacity', min: 0, max: 1, step: 0.05, value: layer.opacity,
      onChange: (v) => { layer.opacity = v; changed(); },
    });

    const mode3d = labelled('3D', createSegmentedControl({
      options: [{ label: 'Surface', value: 'surface' }, { label: 'Tint', value: 'tint' }, { label: 'Off', value: 'off' }],
      value: layer.style3d,
      onChange: (v) => { layer.style3d = v as LabelLayer['style3d']; changed(); },
    }).el);

    const slice = labelled('Slices', createSegmentedControl({
      options: [
        { label: 'Fill', value: 'fill' }, { label: 'Outline', value: 'outline' },
        { label: 'Both', value: 'both' }, { label: 'Off', value: 'off' },
      ],
      value: layer.slice,
      onChange: (v) => { layer.slice = v as LabelLayer['slice']; changed(); },
    }).el);

    const colours = labelled('Colours', createSegmentedControl({
      options: [{ label: 'Per segment', value: 'segments' }, { label: 'One colour', value: 'single' }],
      value: layer.color ? 'single' : 'segments',
      onChange: (v) => {
        layer.color = v === 'single' ? layer.layerColor : null;
        changed();
        render();
      },
    }).el);

    box.append(opacity.el, mode3d, slice, colours, layerActions(layer));
    return box;
  };

  /** Selected segments as chips with Hide / Only these / Clear, shown whenever there is a selection. */
  const selectionStrip = (layer: LabelLayer): HTMLElement => {
    const strip = document.createElement('div');
    strip.className = 'lbl-selection';
    const selected = [...layer.selection];
    if (selected.length === 0 && layer.hiddenSegments.size === 0) return strip;

    if (selected.length > 0) {
      const chips = document.createElement('div');
      chips.className = 'lbl-chips';
      for (const id of selected.slice(0, 12)) chips.append(segmentChip(layer, id));
      if (selected.length > 12) chips.append(text('lbl-more', `+${selected.length - 12}`));
      strip.append(chips);
      const actions = document.createElement('div');
      actions.className = 'lbl-actions';
      actions.append(
        button('Hide', 'Hide the selected segments (H)', () => { layer.setHidden(selected, true); layer.clearSelection(); afterSegments(); }),
        button(layer.isolate ? 'Show all' : 'Only these', 'Show only the selected segments (I)', () => { layer.isolate = !layer.isolate; afterSegments(); }),
        button('Clear', 'Clear the selection (Esc)', () => { layer.clearSelection(); layer.isolate = false; afterSegments(); }),
      );
      strip.append(actions);
    }
    if (layer.hiddenSegments.size > 0) {
      const hidden = document.createElement('div');
      hidden.className = 'lbl-actions';
      hidden.append(
        text('lbl-dim', `${layer.hiddenSegments.size} hidden`),
        button('Show hidden', 'Show every hidden segment again', () => { layer.showAll(); afterSegments(); }),
      );
      strip.append(hidden);
    }
    return strip;
  };

  const layerActions = (layer: LabelLayer): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'lbl-actions lbl-layer-actions';
    const index = labels.layers.indexOf(layer);
    const up = button('↑', 'Draw above the layer before', () => { labels.move(layer, index - 1); changed(); render(); });
    const down = button('↓', 'Draw below the layer after', () => { labels.move(layer, index + 1); changed(); render(); });
    up.disabled = index === 0;
    down.disabled = index === labels.layers.length - 1;
    const remove = button('Remove', `Remove ${layer.name}`, () => { labels.remove(layer); expanded.delete(layer); changed(); render(); });
    row.append(up, down, text('lbl-spacer', ''), remove);
    return row;
  };

  /** A selected segment: colour dot and ID (and name); click removes it from the selection, Alt-click hides it. */
  const segmentChip = (layer: LabelLayer, id: number): HTMLElement => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'lbl-chip';
    chip.classList.toggle('selected', layer.selection.has(id));
    chip.classList.toggle('hidden', layer.isHidden(id));
    const dot = document.createElement('span');
    dot.className = 'lbl-dot';
    dot.style.background = css(layer.baseColorOf(id));
    const name = layer.segment(id).name;
    chip.append(dot, document.createTextNode(name ? `${name} · ${id}` : String(id)));
    chip.title = `${name ? `${name}, ` : ''}ID ${id}\nClick: deselect · Alt: hide`;
    chip.addEventListener('click', (e) => {
      if (e.altKey) layer.setHidden(id, true);
      else layer.select(id, 'toggle');
      afterSegments();
    });
    return chip;
  };

  const afterSegments = () => {
    changed();
    render();
  };

  // ---------------------------------------------------------------------------------------------
  // Adding layers

  let urlMode = false;
  const renderAdd = () => {
    add.replaceChildren();
    const sources = labels.layers.map(l => l.source);
    const names = labels.available.filter(n => !sources.includes(n));
    if (urlMode) {
      const form = document.createElement('form');
      form.className = 'lbl-find';
      const input = document.createElement('input');
      input.type = 'url';
      input.required = true;
      input.placeholder = 'https://…/labels/cells';
      input.className = 'lbl-input';
      input.setAttribute('aria-label', 'URL of an OME-Zarr label image');
      form.append(input, button('Add', 'Add this label image', () => {}, 'submit'), button('Cancel', '', () => { urlMode = false; renderAdd(); }));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (input.value) addLayer(input.value.trim());
      });
      add.append(form);
      queueMicrotask(() => input.focus());
      return;
    }
    const select = document.createElement('select');
    select.className = 'ctl-select-input lbl-add-select';
    select.setAttribute('aria-label', 'Add a label image');
    select.add(new Option(names.length > 0 ? `Add labels (${names.length} available)…` : 'Add labels…', ''));
    for (const name of names) select.add(new Option(name, name));
    select.add(new Option('From URL…', '\u0000url'));
    select.addEventListener('change', () => {
      const value = select.value;
      select.value = '';
      if (value === '\u0000url') {
        urlMode = true;
        renderAdd();
      } else if (value) {
        addLayer(value);
      }
    });
    add.append(select);
  };

  const addLayer = (source: string) => {
    const pending = text('lbl-dim', `Opening ${isUrl(source) ? source.split('/').filter(Boolean).pop() : source}…`);
    add.replaceChildren(pending);
    const shown = labels.shown.length;
    labels.add(source, { visible: shown < MAX_LABEL_LAYERS }).then((layer) => {
      urlMode = false;
      expanded.add(layer);
      setCollapsed(false);
      changed();
      render();
    }, (e) => {
      fail(`Labels ${source} not shown`, e);
      renderAdd();
    });
  };

  // ---------------------------------------------------------------------------------------------
  // Footer: memory and loading

  const updateFooter = () => {
    const s = labels.stats;
    footer.hidden = s.layers === 0;
    footer.textContent = `GPU ${formatBytes(s.poolBytes)} of ${formatBytes(s.maxPoolBytes)}` +
      (s.loading > 0 ? ` · loading ${s.loading}` : '');
    footer.title = `Label pool: ${s.bricksInUse} bricks shown, ${s.bricksCached} kept for later; palettes ${formatBytes(s.paletteBytes)}; ${formatBytes(s.bytesFetched)} read`;
  };
  setInterval(() => { if (!panelEl.classList.contains('collapsed')) updateFooter(); }, 1000);

  // ---------------------------------------------------------------------------------------------
  // Hover and click in the views

  const tooltip = document.createElement('div');
  tooltip.className = 'lbl-tooltip';
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  // One pick at a time; a click waits for the hover pick in flight and is never replaced by one
  type PickRequest = { canvas: HTMLCanvasElement; x: number; y: number; click: boolean; shift: boolean };
  let picking = false;
  let queued: PickRequest | null = null;
  const requestPick = (request: PickRequest) => {
    if (!request.click && queued?.click) return;
    queued = request;
    if (!picking) void nextPick();
  };
  const nextPick = async () => {
    const request = queued;
    queued = null;
    if (!request) return;
    picking = true;
    const pick = await viewer.pickLabels(request.canvas, request.x, request.y).catch(() => null);
    picking = false;
    if (request.click) clicked(pick, request.shift);
    else if (!queued) showHits(pick, request.x, request.y);
    void nextPick();
  };

  const showHits = (pick: LabelPick | null, x: number, y: number) => {
    const hits = pick?.hits ?? [];
    if (hits.length === 0 || !hoverOn) {
      tooltip.hidden = true;
      return;
    }
    tooltip.replaceChildren(...hits.map(hitRow));
    tooltip.hidden = false;
    const w = tooltip.offsetWidth;
    tooltip.style.left = `${Math.min(x + 14, window.innerWidth - w - 8)}px`;
    tooltip.style.top = `${y + 16}px`;
  };
  const hitRow = (hit: LabelHit) => {
    const row = document.createElement('div');
    const dot = document.createElement('span');
    dot.className = 'lbl-dot';
    dot.style.background = css(hit.color, 1);
    row.append(dot, text('lbl-tip-layer', hit.layer.name), text('ctl-mono', String(hit.id)));
    if (hit.name) row.append(text('lbl-tip-name', hit.name));
    return row;
  };

  /** Click: select the top segment (Shift: add or remove it); empty space clears the selection. */
  const clicked = (pick: LabelPick | null, shift: boolean) => {
    if (!pick) return; // replaced or unavailable: no answer
    const hit = pick.hits[0];
    if (!hit) {
      if (!shift && labels.layers.some(l => l.selection.size > 0)) clearSelection();
      return;
    }
    if (!shift) for (const l of labels.layers) if (l !== hit.layer) l.clearSelection();
    hit.layer.select(hit.id, shift ? 'toggle' : 'replace');
    setCollapsed(false);
    afterSegments();
  };

  let hoverOn = false;
  let down: { x: number; y: number; t: number } | null = null;
  window.addEventListener('pointermove', (e) => {
    hoverOn = e.buttons === 0 && viewer.ownsCanvas(e.target) && labels.shown.length > 0;
    if (!hoverOn) {
      tooltip.hidden = true;
      return;
    }
    requestPick({ canvas: e.target as HTMLCanvasElement, x: e.clientX, y: e.clientY, click: false, shift: false });
  });
  window.addEventListener('pointerleave', () => { hoverOn = false; tooltip.hidden = true; });
  window.addEventListener('pointerdown', (e) => {
    down = viewer.ownsCanvas(e.target) && e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  });
  window.addEventListener('pointerup', (e) => {
    const start = down;
    down = null;
    if (!start || !viewer.ownsCanvas(e.target) || labels.shown.length === 0) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4 || performance.now() - start.t > 500) return; // a drag
    requestPick({ canvas: e.target, x: e.clientX, y: e.clientY, click: true, shift: e.shiftKey });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || isTyping(e.target)) return;
    if (labels.layers.some(l => l.selection.size > 0)) clearSelection();
  });

  const clearSelection = () => {
    for (const l of labels.layers) {
      l.clearSelection();
      l.isolate = false;
    }
    afterSegments();
  };

  // ---------------------------------------------------------------------------------------------
  // Shortcuts

  let hiddenByShortcut: LabelLayer[] = [];
  const shortcuts: Shortcut[] = [
    {
      keys: ['l', 'L'], display: 'L', label: 'Show / hide labels',
      run: () => {
        const shown = labels.layers.filter(l => l.visible);
        if (shown.length > 0) {
          hiddenByShortcut = shown;
          for (const l of shown) l.visible = false;
        } else {
          for (const l of hiddenByShortcut.filter(l => labels.layers.includes(l))) {
            try { l.visible = true; } catch { /* over the limit */ }
          }
          hiddenByShortcut = [];
        }
        afterSegments();
      },
    },
    {
      keys: ['h', 'H'], display: 'H', label: 'Hide selected segments',
      run: () => {
        for (const l of labels.layers) if (l.selection.size > 0) { l.setHidden([...l.selection], true); l.clearSelection(); }
        afterSegments();
      },
    },
    {
      keys: ['i', 'I'], display: 'I', label: 'Show only selected segments',
      run: () => {
        for (const l of labels.layers) if (l.selection.size > 0) l.isolate = !l.isolate;
        afterSegments();
      },
    },
  ];

  labels.onChange = render;
  render();
  return { refresh: render, shortcuts };
}

function rgbObject(rgb: Rgb): { r: number; g: number; b: number } {
  return { r: rgb[0], g: rgb[1], b: rgb[2] };
}

function multiSwatch(onClick: () => void): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'lbl-multi-swatch';
  el.innerHTML = MULTI_SWATCH_SVG;
  el.title = 'Colours per segment (settings)';
  el.addEventListener('click', onClick);
  return el;
}

function labelled(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lbl-field';
  row.append(text('ctl-row-label', label), control);
  return row;
}

function button(label: string, title: string, onClick: () => void, type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = type;
  el.className = 'ctl-button ctl-button-compact';
  el.textContent = label;
  if (title) el.title = title;
  if (type === 'button') el.addEventListener('click', onClick);
  return el;
}

function text(className: string, content: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = content;
  return el;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
