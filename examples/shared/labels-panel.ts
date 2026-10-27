/**
 * Labels panel: the dataset's label images (segmentations) as layers, one card each with its
 * colour, name, visibility and opacity. Layers are added from the dataset's `labels` group or
 * from a URL.
 */
import type { KilnViewer, LabelLayer } from 'kiln-render';
import { MAX_LABEL_LAYERS } from 'kiln-render';
import { createColorSwatch, createPanel, createSlider, createToggle } from './controls/widgets.js';

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

export interface LabelsPanel {
  /** Rebuild from the layers (after changes made elsewhere, e.g. a URL). */
  refresh(): void;
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
  const { el: panelEl, body, setCollapsed } = createPanel('Labels', {
    defaultCollapsed: labels.available.length === 0 && labels.layers.length === 0 ? true : undefined,
  });
  panelEl.classList.add('lbl-panel');
  dock.appendChild(panelEl);

  const list = document.createElement('div');
  list.className = 'lbl-layers';
  const add = document.createElement('div');
  add.className = 'lbl-add';
  body.append(list, add);

  const changed = () => options.onChange?.();
  const fail = (what: string, e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    options.notify?.(`${what}: ${message}`);
    console.warn(`[Kiln] ${what}:`, e);
  };

  const render = () => {
    list.replaceChildren(...labels.layers.map(layerCard));
    renderAdd();
  };

  /** Colour, name, visibility and remove in one row; opacity below. */
  const layerCard = (layer: LabelLayer): HTMLElement => {
    const card = document.createElement('div');
    card.className = 'ctl-channel-group lbl-layer';
    card.classList.toggle('off', !layer.visible);

    const row = document.createElement('div');
    row.className = 'ctl-channel-row';

    const color = layer.color ?? layer.layerColor;
    const swatch = createColorSwatch({
      value: { r: color[0], g: color[1], b: color[2] },
      onChange: (c) => { layer.color = [c.r, c.g, c.b]; changed(); },
    }).el;
    swatch.setAttribute('aria-label', `${layer.name} colour`);

    const name = document.createElement('span');
    name.className = 'ctl-channel-name';
    name.textContent = layer.name;
    name.title = [layer.source, ...layer.notes].join('\n');

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
        changed();
      },
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lbl-icon-button';
    remove.textContent = '×';
    remove.title = `Remove ${layer.name}`;
    remove.setAttribute('aria-label', `Remove ${layer.name}`);
    remove.addEventListener('click', () => { labels.remove(layer); changed(); render(); });

    row.append(swatch, name, visible.el, remove);
    const opacity = createSlider({
      label: 'Opacity', min: 0, max: 1, step: 0.05, value: layer.opacity,
      onChange: (v) => { layer.opacity = v; changed(); },
    });
    card.append(row, opacity.el);
    if (layer.notes.length > 0) {
      const note = document.createElement('div');
      note.className = 'lbl-note';
      note.textContent = layer.notes.join(' · ');
      card.append(note);
    }
    return card;
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
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'ctl-button ctl-button-compact';
      submit.textContent = 'Add';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ctl-button ctl-button-compact';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => { urlMode = false; renderAdd(); });
      form.append(input, submit, cancel);
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
    const pending = document.createElement('div');
    pending.className = 'lbl-dim';
    pending.textContent = `Opening ${isUrl(source) ? source.split('/').filter(Boolean).pop() : source}…`;
    add.replaceChildren(pending);
    const shown = labels.shown.length;
    labels.add(source, { visible: shown < MAX_LABEL_LAYERS }).then(() => {
      urlMode = false;
      setCollapsed(false);
      changed();
      render();
    }, (e) => {
      fail(`Labels ${source} not shown`, e);
      renderAdd();
    });
  };

  labels.onChange = render;
  render();
  return { refresh: render };
}
