/** Inline source controls: time slider, keyboard stepping and source-channel pickers. */
import type { SourceSelection, VolumeMetadata } from 'kiln-render';
import { channelDisplayName } from './channel-names.js';
import type { Shortcut } from './shortcuts.js';

/** Applies a selection in place; false when the page navigated to the other viewer instead. */
export type ApplySelection = (selection: Required<SourceSelection>) => boolean;

/** While scrubbing, switch at most this often; the release always applies the final value. */
const SCRUB_INTERVAL_MS = 200;

export interface TimeSlider {
  el: HTMLElement;
  /** Re-read the timepoint from the metadata (after keyboard steps or external changes). */
  sync(): void;
  /** Move by `delta` timepoints, clamped to the dataset. */
  step(delta: number): void;
}

const STEP_CHEVRON_SVG = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1 2.3 2.2 5.1 5 2.3 7.8 3.5 9l4-4z"/></svg>';

/**
 * Time card in the channel-strip style: "Time … 4 / 18" header, then ‹ [────●────] ›.
 * Dragging switches timepoints live (throttled), the final value lands on release;
 * the buttons step one at a time. Returns null for datasets without a time axis.
 */
export function createTimeSlider(meta: VolumeMetadata, onTimepoint: (timepoint: number) => void): TimeSlider | null {
  const count = meta.timepointCount ?? 1;
  if (count <= 1) return null;
  const current = () => meta.timepoint ?? 0;

  let pending: number | null = null;
  let lastApplied = 0;
  let timer = 0;
  const flush = () => {
    timer = 0;
    if (pending === null) return;
    const t = pending;
    pending = null;
    lastApplied = performance.now();
    if (t !== meta.timepoint) onTimepoint(t);
  };
  const request = (t: number, immediate = false) => {
    pending = t;
    const wait = SCRUB_INTERVAL_MS - (performance.now() - lastApplied);
    if (immediate || wait <= 0) { clearTimeout(timer); flush(); return; }
    if (!timer) timer = window.setTimeout(flush, wait);
  };

  const el = document.createElement('div');
  el.className = 'ctl-time-row';
  const head = document.createElement('div');
  head.className = 'ctl-time-head';
  const label = document.createElement('span');
  label.className = 'ctl-row-label';
  label.textContent = 'Time';
  const value = document.createElement('span');
  value.className = 'ctl-row-value ctl-mono ctl-slider-value';
  head.append(label, value);

  // Same track markup as createSlider so the thumb and fill match every other slider.
  const track = document.createElement('div');
  track.className = 'ctl-slider-track';
  const fill = document.createElement('div');
  fill.className = 'ctl-slider-fill';
  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'ctl-slider-input';
  input.min = '1'; input.max = String(count); input.step = '1';
  input.setAttribute('aria-label', 'Timepoint');
  track.append(fill, input);

  const button = (dir: -1 | 1) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctl-time-step' + (dir < 0 ? ' prev' : '');
    b.title = dir < 0 ? 'Previous timepoint (,)' : 'Next timepoint (.)';
    b.setAttribute('aria-label', b.title);
    b.innerHTML = STEP_CHEVRON_SVG;
    b.addEventListener('click', () => step(dir));
    return b;
  };
  const prev = button(-1);
  const next = button(1);
  const scrub = document.createElement('div');
  scrub.className = 'ctl-time-scrub';
  scrub.append(prev, track, next);
  el.append(head, scrub);

  // Display state for a one-based timepoint; 12px matches the thumb inset in controls.css.
  const show = (t1: number) => {
    input.value = String(t1);
    value.textContent = `${t1} / ${count}`;
    fill.style.width = `calc((100% - 12px) * ${(t1 - 1) / Math.max(1, count - 1)})`;
    prev.disabled = t1 <= 1;
    next.disabled = t1 >= count;
  };
  show(current() + 1);
  input.addEventListener('input', () => { show(Number(input.value)); request(Number(input.value) - 1); });
  input.addEventListener('change', () => request(Number(input.value) - 1, true));

  const step = (delta: number) => {
    const t = Math.max(0, Math.min(count - 1, current() + delta));
    show(t + 1);
    request(t, true);
  };
  return { el, sync: () => show(current() + 1), step };
}

/** `,` / `.` step through time; Shift jumps ten. Register only for datasets with a time axis. */
export function timeShortcuts(step: (delta: number) => void): Shortcut[] {
  return [{
    keys: [',', '.', '<', '>'], display: ', .', label: 'Previous / next timepoint (Shift: ±10)',
    run: e => step((e.key === ',' || e.key === '<' ? -1 : 1) * (e.shiftKey ? 10 : 1)),
  }];
}

/** One option per source channel, named from OMERO labels when present. */
export function sourceChannelOptions(meta: VolumeMetadata): Array<{ label: string; value: string }> {
  return Array.from({ length: meta.sourceChannelCount ?? 1 }, (_, i) => ({
    label: channelDisplayName(meta.sourceChannelMetadata?.[i]?.label, i), value: String(i),
  }));
}

/**
 * Picker that stands in for a channel's name in the rack: looks like text, opens as a select.
 * `onPick(null)` removes the slot (offered when more than one channel is shown).
 */
export function createChannelPicker(meta: VolumeMetadata, slot: number, onPick: (source: number | null) => void): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'ctl-channel-select';
  for (const o of sourceChannelOptions(meta)) select.add(new Option(o.label, o.value));
  if ((meta.sourceChannels?.length ?? 1) > 1) select.add(new Option('Remove from view', ''));
  const current = String(meta.sourceChannels?.[slot] ?? slot);
  select.value = current;
  select.title = select.selectedOptions[0]?.textContent ?? '';
  select.setAttribute('aria-label', `Source for display channel ${slot + 1}`);
  select.addEventListener('change', () => onPick(select.value === '' ? null : Number(select.value)));
  return select;
}

/** Next selection after assigning `source` to `slot`; a channel already shown elsewhere swaps places. */
export function withSlotSource(current: readonly number[], slot: number, source: number | null): number[] {
  const next = [...current];
  if (source === null) { next.splice(slot, 1); return next; }
  const other = next.indexOf(source);
  if (other >= 0) next[other] = next[slot]!;
  next[slot] = source;
  return next;
}

/** First source channel not on display, or null when every one is shown. */
export function firstUnusedSource(meta: VolumeMetadata): number | null {
  const shown = new Set(meta.sourceChannels ?? []);
  for (let i = 0; i < (meta.sourceChannelCount ?? 1); i++) if (!shown.has(i)) return i;
  return null;
}
