/**
 * Labels section for datasets with label images (OME-Zarr `labels` group, or `?labels=<url>`):
 * which label image to show, if any, and how strongly its colours cover the image.
 */
import type { KilnViewer } from 'kiln-render';
import { createCollapsible, createSelect, createSlider } from './controls/widgets.js';

/** Appends the section to `parent`; nothing when the dataset has no labels. */
export function mountLabelControls(viewer: KilnViewer, parent: HTMLElement): void {
  const { engine } = viewer;
  const sources = [...engine.labelNames];
  if (engine.labels && !sources.includes(engine.labels)) sources.push(engine.labels);
  if (sources.length === 0) return;

  const { el, body } = createCollapsible('Labels', true);
  parent.appendChild(el);

  const select = createSelect({
    label: 'Show',
    // A URL source is listed by its last path segment
    options: [{ label: 'None', value: '' }, ...sources.map(s => ({ label: s.split('/').filter(Boolean).pop() ?? s, value: s }))],
    value: engine.labels ?? '',
    onChange: (value) => {
      engine.setLabels(value || null).catch((e) => {
        console.warn(`[Kiln] labels "${value}" not shown:`, e);
        select.setValue(engine.labels ?? '');
      });
    },
  });
  const opacity = createSlider({
    label: 'Opacity', min: 0, max: 1, step: 0.05, value: viewer.renderer.labelOpacity,
    onChange: (v) => {
      viewer.renderer.labelOpacity = v;
      viewer.renderer.resetAccumulation();
    },
  });
  body.append(select.el, opacity.el);
}
