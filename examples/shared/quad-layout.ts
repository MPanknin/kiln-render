/**
 * ?layout=quad — front, side and top panes next to the main 3D view. Each axis pane has
 * its own camera (pan and zoom, no orbit) and render mode; everything else (transfer
 * function, window, clip box, …) follows the main view and its controls.
 */
import type { KilnViewer, UpAxis, ViewerPane } from 'kiln-render';

export const PANE_MODES = ['dvr', 'mip', 'iso', 'slice'] as const;
export type PaneMode = (typeof PANE_MODES)[number];
const MODE_LABELS: Record<PaneMode, string> = { dvr: 'DVR', mip: 'MIP', iso: 'ISO', slice: 'Slice' };

/** `?panes=mip,dvr,slice`: modes of the front, side and top panes; unknown entries are skipped. */
export function parsePaneModes(value: string | null): Array<PaneMode | undefined> {
  return (value ?? '').split(',').map(m => (PANE_MODES as readonly string[]).includes(m) ? m as PaneMode : undefined);
}

/** Front, side and top views for an up axis: top looks down the up axis, front and side along the other two. */
export function axisViews(up: UpAxis): Array<{ name: string; dir: [number, number, number] }> {
  const axis = 'xyz'.indexOf(up.replace('-', ''));
  const unit = (i: number, sign = 1): [number, number, number] => [0, 1, 2].map(j => (j === i ? sign : 0)) as [number, number, number];
  const front = (axis + 1) % 3;
  const side = (axis + 2) % 3;
  return [
    { name: `Front · +${'XYZ'[front]}`, dir: unit(front) },
    { name: `Side · +${'XYZ'[side]}`, dir: unit(side) },
    { name: `Top · ${up.startsWith('-') ? '−' : '+'}${'XYZ'[axis]}`, dir: unit(axis, up.startsWith('-') ? -1 : 1) },
  ];
}

/** Replace `canvas` with a 2 × 2 grid: front, side, top, and `canvas` itself as the 3D pane. */
export function mountQuadLayout(
  viewer: KilnViewer,
  canvas: HTMLCanvasElement,
  modes: Array<PaneMode | undefined> = [],
  { embed = false } = {},
): { panes: ViewerPane[]; modes: () => PaneMode[] } {
  const grid = document.createElement('div');
  grid.className = embed ? 'quad-layout quad-layout-embed' : 'quad-layout';
  canvas.replaceWith(grid);
  document.body.classList.add('quad-active');

  const cell = (paneCanvas: HTMLCanvasElement, name: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'quad-pane';
    const bar = document.createElement('div');
    bar.className = 'quad-pane-bar';
    bar.textContent = name;
    el.append(paneCanvas, bar);
    grid.append(el);
    return bar;
  };

  const panes = axisViews(viewer.camera.getUpAxis()).map(({ name, dir }, i) => {
    const paneCanvas = document.createElement('canvas');
    const bar = cell(paneCanvas, name);
    const pane = viewer.addPane(paneCanvas);
    pane.camera.lookFrom(dir);
    pane.camera.orbitEnabled = false;
    pane.mode = modes[i] ?? 'dvr';

    const select = document.createElement('select');
    select.setAttribute('aria-label', `${name} render mode`);
    for (const mode of PANE_MODES) select.add(new Option(MODE_LABELS[mode], mode));
    select.value = pane.mode;
    select.addEventListener('change', () => { pane.mode = select.value as PaneMode; });
    bar.append(select);
    return pane;
  });
  cell(canvas, '3D');

  const baseMode = (mode: string): PaneMode => (mode === 'slice-lod' ? 'slice' : mode === 'lod' ? 'dvr' : mode as PaneMode);
  return { panes, modes: () => panes.map(p => baseMode(p.mode)) };
}
