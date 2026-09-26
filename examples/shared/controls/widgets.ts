/**
 * Dependency-free control panel primitives — replaces Tweakpane for all
 * user-facing UI (Phase 3 of the interface redesign). Plain DOM builders,
 * no framework: each returns the root element plus whatever accessors the
 * caller needs to keep it in sync with application state.
 */

const PANEL_CHEVRON_SVG =
  '<svg class="ctl-panel-arrow" viewBox="0 0 8 8" width="8" height="8"><path d="M2 0l4 4-4 4z" fill="currentColor"/></svg>';

/**
 * The panel shell — single surface, positioned by the caller via inline
 * style. The header toggles the body so the panel collapses to a title bar;
 * on small viewports it starts collapsed so it doesn't cover the canvas.
 */
export function createPanel(
  title: string,
  opts: { defaultCollapsed?: boolean } = {},
): {
  el: HTMLElement;
  body: HTMLElement;
  setCollapsed(collapsed: boolean): void;
} {
  const collapsed =
    opts.defaultCollapsed ?? window.matchMedia("(max-width: 700px)").matches;

  const el = document.createElement("div");
  el.className = "ctl-panel" + (collapsed ? " collapsed" : "");

  const header = document.createElement("button");
  header.type = "button";
  header.className = "ctl-panel-header";
  header.innerHTML = `<span>${title}</span>${PANEL_CHEVRON_SVG}`;
  header.setAttribute("aria-expanded", String(!collapsed));

  const body = document.createElement("div");
  body.className = "ctl-panel-body";

  const setCollapsed = (c: boolean) => {
    el.classList.toggle("collapsed", c);
    header.setAttribute("aria-expanded", String(!c));
  };

  header.addEventListener("click", () =>
    setCollapsed(!el.classList.contains("collapsed")),
  );

  el.appendChild(header);
  el.appendChild(body);
  return { el, body, setCollapsed };
}

/** A region whose contents are swapped wholesale (e.g. per render mode) without changing the panel's outer silhouette. */
export function createSwapRegion(): {
  el: HTMLElement;
  setContent(children: HTMLElement[]): void;
} {
  const el = document.createElement("div");
  el.className = "ctl-swap-region";
  return {
    el,
    setContent(children: HTMLElement[]) {
      el.replaceChildren(...children);
    },
  };
}

export function createSection(title: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "ctl-section";
  const eyebrow = document.createElement("div");
  eyebrow.className = "ctl-eyebrow";
  eyebrow.textContent = title;
  el.appendChild(eyebrow);
  return el;
}

// Chevron as inline SVG, not a text glyph — "▸"/"▾" fall back to a generic
// tofu/dot on some font stacks, which is why collapsible headers rendered
// inconsistently across sections.
const CHEVRON_SVG =
  '<svg class="ctl-collapsible-arrow" viewBox="0 0 8 8" width="8" height="8"><path d="M2 0l4 4-4 4z" fill="currentColor"/></svg>';

export function createCollapsible(
  title: string,
  defaultOpen = false,
): { el: HTMLElement; body: HTMLElement } {
  const el = document.createElement("div");
  el.className = "ctl-collapsible" + (defaultOpen ? " open" : "");

  const header = document.createElement("button");
  header.type = "button";
  header.className = "ctl-collapsible-header";
  header.innerHTML = `${CHEVRON_SVG}<span class="ctl-eyebrow">${title}</span>`;

  const body = document.createElement("div");
  body.className = "ctl-collapsible-body";

  header.addEventListener("click", () => el.classList.toggle("open"));

  el.appendChild(header);
  el.appendChild(body);
  return { el, body };
}

export function createRow(
  label: string,
  valueText = "",
): { el: HTMLElement; valueEl: HTMLElement } {
  const el = document.createElement("div");
  el.className = "ctl-row";
  const labelEl = document.createElement("span");
  labelEl.className = "ctl-row-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "ctl-row-value ctl-mono";
  valueEl.textContent = valueText;
  el.appendChild(labelEl);
  el.appendChild(valueEl);
  return { el, valueEl };
}

export function createToggle(opts: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  /** Accessible name when `label` is empty (e.g. a channel row's visibility toggle). */
  ariaLabel?: string;
}): { el: HTMLElement; setValue(v: boolean): void } {
  const row = document.createElement("label");
  row.className = "ctl-toggle-row";

  const text = document.createElement("span");
  text.className = "ctl-row-label ctl-toggle-label";
  text.textContent = opts.label;

  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "ctl-toggle-input";
  input.checked = opts.value;
  if (opts.ariaLabel) input.setAttribute("aria-label", opts.ariaLabel);

  const track = document.createElement("span");
  track.className = "ctl-toggle-track";

  input.addEventListener("change", () => opts.onChange(input.checked));

  row.appendChild(text);
  row.appendChild(input);
  row.appendChild(track);
  return {
    el: row,
    setValue(v: boolean) {
      input.checked = v;
    },
  };
}

export function createSlider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}): { el: HTMLElement; setValue(v: number): void } {
  const format = opts.format ?? ((v: number) => v.toFixed(2));
  const pct = (v: number) => ((v - opts.min) / (opts.max - opts.min)) * 100;

  const el = document.createElement("div");
  el.className = "ctl-slider-row";

  const label = document.createElement("span");
  label.className = "ctl-row-label ctl-slider-label";
  label.textContent = opts.label;

  const trackWrap = document.createElement("div");
  trackWrap.className = "ctl-slider-track";

  const fill = document.createElement("div");
  fill.className = "ctl-slider-fill";

  const input = document.createElement("input");
  input.type = "range";
  input.className = "ctl-slider-input";
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);

  // 6px/12px must match the track inset / thumb size in controls.css.
  const setFill = (v: number) => {
    fill.style.width = `calc((100% - 12px) * ${pct(v) / 100})`;
  };
  setFill(opts.value);

  const value = document.createElement("span");
  value.className = "ctl-row-value ctl-mono ctl-slider-value";
  value.textContent = format(opts.value);

  input.addEventListener("input", () => {
    const v = Number(input.value);
    value.textContent = format(v);
    setFill(v);
    opts.onChange(v);
  });

  trackWrap.appendChild(fill);
  trackWrap.appendChild(input);
  el.appendChild(label);
  el.appendChild(trackWrap);
  el.appendChild(value);
  return {
    el,
    setValue(v: number) {
      setFill(v);
      input.value = String(v);
      value.textContent = format(v);
    },
  };
}

/**
 * Dual-thumb range slider — two overlapping native <input type=range>
 * elements. Track pointer-events are disabled so only the (still directly
 * hit-testable) thumbs intercept drags; whichever thumb is visually on top
 * wins on overlap, which is the standard CSS-only dual-range trick.
 */
export function createRangeSlider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  valueMin: number;
  valueMax: number;
  format?: (v: number) => string;
  onChange: (min: number, max: number) => void;
}): { el: HTMLElement; setValue(min: number, max: number): void } {
  const format = opts.format ?? ((v: number) => v.toFixed(2));
  const pct = (v: number) => ((v - opts.min) / (opts.max - opts.min)) * 100;

  const el = document.createElement("div");
  el.className = "ctl-slider-row";

  const label = document.createElement("span");
  label.className = "ctl-row-label ctl-slider-label";
  label.textContent = opts.label;

  const track = document.createElement("div");
  track.className = "ctl-range-track";

  const fill = document.createElement("div");
  fill.className = "ctl-slider-fill";

  const value = document.createElement("span");
  value.className = "ctl-row-value ctl-mono ctl-slider-value";
  value.textContent = `${format(opts.valueMin)}–${format(opts.valueMax)}`;

  const makeInput = (val: number) => {
    const input = document.createElement("input");
    input.type = "range";
    input.className = "ctl-range-input";
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);
    input.value = String(val);
    return input;
  };

  const minInput = makeInput(opts.valueMin);
  const maxInput = makeInput(opts.valueMax);

  // 6px/12px must match the track inset / thumb size in controls.css.
  const setFill = (lo: number, hi: number) => {
    const loPct = pct(lo) / 100;
    const hiPct = pct(hi) / 100;
    fill.style.left = `calc(6px + (100% - 12px) * ${loPct})`;
    fill.style.width = `calc((100% - 12px) * ${hiPct - loPct})`;
  };
  setFill(opts.valueMin, opts.valueMax);

  const emit = () => {
    let lo = Number(minInput.value);
    let hi = Number(maxInput.value);
    if (lo > hi) {
      [lo, hi] = [hi, lo];
      minInput.value = String(lo);
      maxInput.value = String(hi);
    }
    value.textContent = `${format(lo)}–${format(hi)}`;
    setFill(lo, hi);
    opts.onChange(lo, hi);
  };

  minInput.addEventListener("input", emit);
  maxInput.addEventListener("input", emit);

  track.appendChild(fill);
  track.appendChild(minInput);
  track.appendChild(maxInput);

  el.appendChild(label);
  el.appendChild(track);
  el.appendChild(value);
  return {
    el,
    setValue(min: number, max: number) {
      minInput.value = String(min);
      maxInput.value = String(max);
      value.textContent = `${format(min)}–${format(max)}`;
      setFill(min, max);
    },
  };
}

export function createSelect(opts: {
  label: string;
  options: Array<{ label: string; value: string }>;
  value: string;
  onChange: (v: string) => void;
}): { el: HTMLElement; setValue(v: string): void } {
  const el = document.createElement("label");
  el.className = "ctl-select-row";

  const text = document.createElement("span");
  text.className = "ctl-row-label ctl-select-label";
  text.textContent = opts.label;

  const select = document.createElement("select");
  select.className = "ctl-select-input";
  for (const o of opts.options) {
    const optionEl = document.createElement("option");
    optionEl.value = o.value;
    optionEl.textContent = o.label;
    select.appendChild(optionEl);
  }
  select.value = opts.value;
  select.addEventListener("change", () => opts.onChange(select.value));

  el.appendChild(text);
  el.appendChild(select);
  return {
    el,
    setValue(v: string) {
      select.value = v;
    },
  };
}

export function createSegmentedControl(opts: {
  options: Array<{ label: string; value: string }>;
  value: string;
  onChange: (v: string) => void;
}): { el: HTMLElement; setValue(v: string): void } {
  const el = document.createElement("div");
  el.className = "ctl-segmented";

  const buttons: HTMLButtonElement[] = [];
  for (const o of opts.options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctl-segment" + (o.value === opts.value ? " active" : "");
    btn.textContent = o.label;
    btn.addEventListener("click", () => {
      for (const b of buttons) b.classList.remove("active");
      btn.classList.add("active");
      opts.onChange(o.value);
    });
    buttons.push(btn);
    el.appendChild(btn);
  }

  return {
    el,
    setValue(v: string) {
      for (const [i, o] of opts.options.entries()) {
        buttons[i]!.classList.toggle("active", o.value === v);
      }
    },
  };
}

/** A compact position-slider + visibility-toggle row (slice planes, one per axis). */
export function createSliderToggleRow(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  checked: boolean;
  onValueChange: (v: number) => void;
  onCheckedChange: (v: boolean) => void;
}): {
  el: HTMLElement;
  setValue(v: number): void;
  setChecked(v: boolean): void;
} {
  const pct = (v: number) => ((v - opts.min) / (opts.max - opts.min)) * 100;

  const el = document.createElement("div");
  el.className = "ctl-slider-toggle-row";

  const label = document.createElement("span");
  label.className = "ctl-row-label ctl-slider-toggle-label";
  label.textContent = opts.label;

  // The input must live inside a track wrapper — it is positioned absolutely
  // and would otherwise escape the row and render at the panel corner.
  const trackWrap = document.createElement("div");
  trackWrap.className = "ctl-slider-track";

  const fill = document.createElement("div");
  fill.className = "ctl-slider-fill";

  const input = document.createElement("input");
  input.type = "range";
  input.className = "ctl-slider-input ctl-slider-toggle-input";
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);

  // 6px/12px must match the track inset / thumb size in controls.css.
  const setFill = (v: number) => {
    fill.style.width = `calc((100% - 12px) * ${pct(v) / 100})`;
  };
  setFill(opts.value);

  input.addEventListener("input", () => {
    setFill(Number(input.value));
    opts.onValueChange(Number(input.value));
  });

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "ctl-toggle-input";
  toggle.checked = opts.checked;
  toggle.addEventListener("change", () => opts.onCheckedChange(toggle.checked));
  const track = document.createElement("span");
  track.className = "ctl-toggle-track";
  const toggleLabel = document.createElement("label");
  toggleLabel.className = "ctl-slider-toggle-switch";
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(track);

  trackWrap.appendChild(fill);
  trackWrap.appendChild(input);
  el.appendChild(label);
  el.appendChild(trackWrap);
  el.appendChild(toggleLabel);
  return {
    el,
    setValue(v: number) {
      input.value = String(v);
      setFill(v);
    },
    setChecked(v: boolean) {
      toggle.checked = v;
    },
  };
}

/** Native <input type=color> restyled to a small square swatch (no hex/rgba text). */
export function createColorSwatch(opts: {
  value: { r: number; g: number; b: number };
  onChange: (rgb: { r: number; g: number; b: number }) => void;
}): {
  el: HTMLElement;
  setValue(rgb: { r: number; g: number; b: number }): void;
} {
  const toHex = (v: number) => v.toString(16).padStart(2, "0");
  const input = document.createElement("input");
  input.type = "color";
  input.className = "ctl-color-swatch";
  input.value = `#${toHex(opts.value.r)}${toHex(opts.value.g)}${toHex(opts.value.b)}`;
  input.addEventListener("input", () => {
    const hex = input.value;
    opts.onChange({
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    });
  });
  return {
    el: input,
    setValue(rgb) {
      input.value = `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
    },
  };
}

/** A labelled row with a compact action button on the right. */
export function createButtonRow(opts: {
  label: string;
  text: string;
  title?: string;
  onClick: () => void;
}): { el: HTMLElement; setDisabled(disabled: boolean): void } {
  const el = document.createElement("div");
  el.className = "ctl-button-row";

  const label = document.createElement("span");
  label.className = "ctl-row-label";
  label.textContent = opts.label;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ctl-button";
  button.textContent = opts.text;
  if (opts.title) button.title = opts.title;
  button.addEventListener("click", () => opts.onClick());

  el.appendChild(label);
  el.appendChild(button);
  return {
    el,
    setDisabled(disabled: boolean) {
      button.disabled = disabled;
    },
  };
}
