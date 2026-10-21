/**
 * Quad layout — front, side and top panes next to the main 3D view (`?layout=quad`, the
 * top-bar button or Q). Each axis pane has its own camera (pan and zoom, no orbit) and render
 * mode; everything else (transfer function, window, clip box, …) follows the main view.
 * Leaving the layout removes the panes, so they stop rendering and streaming; their modes
 * and cameras come back when the layout is shown again.
 */
import type { KilnViewer, UpAxis, ViewerPane } from 'kiln-render';

export const PANE_MODES = ['dvr', 'mip', 'iso', 'slice'] as const;
export type PaneMode = (typeof PANE_MODES)[number];
const MODE_LABELS: Record<PaneMode, string> = { dvr: 'DVR', mip: 'MIP', iso: 'ISO', slice: 'Slice' };
const DEFAULT_MODE: PaneMode = 'slice';
const GRID_ICON_SVG = '<svg viewBox="0 0 16 16"><path d="M1.5 1.5h5.5v5.5H1.5zM9 1.5h5.5v5.5H9zM1.5 9h5.5v5.5H1.5zM9 9h5.5v5.5H9z"/></svg>';

type OrbitState = ReturnType<KilnViewer['camera']['getOrbitState']>;

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

export interface QuadLayout {
  readonly active: boolean;
  /** Show (true) or leave (false) the quad layout. */
  setActive(active: boolean): void;
  toggle(): void;
  /** Modes of the front, side and top panes. */
  modes(): PaneMode[];
  /** Called after every switch. */
  onChange?: (active: boolean) => void;
}

/** Quad layout around `canvas`, the main 3D view; starts in the quad layout when `active`. */
export function mountQuadLayout(
  viewer: KilnViewer,
  canvas: HTMLCanvasElement,
  { modes = [], active = false, embed = false }: { modes?: Array<PaneMode | undefined>; active?: boolean; embed?: boolean } = {},
): QuadLayout {
  const grid = document.createElement('div');
  grid.className = embed ? 'quad-layout quad-layout-embed' : 'quad-layout';

  // Pane state that outlives the panes, so a round trip through the single view keeps it
  const saved = axisViews(viewer.camera.getUpAxis()).map(({ name, dir }, i) => ({
    name, dir, mode: modes[i] ?? DEFAULT_MODE, orbit: null as OrbitState | null,
  }));
  let panes: ViewerPane[] = [];

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

  const show = () => {
    canvas.replaceWith(grid);
    panes = saved.map(s => {
      const paneCanvas = document.createElement('canvas');
      const bar = cell(paneCanvas, s.name);
      const pane = viewer.addPane(paneCanvas);
      if (s.orbit) pane.camera.setOrbitState(s.orbit);
      else pane.camera.lookFrom(s.dir);
      pane.camera.orbitEnabled = false;
      pane.mode = s.mode;

      const select = document.createElement('select');
      select.setAttribute('aria-label', `${s.name} render mode`);
      for (const mode of PANE_MODES) select.add(new Option(MODE_LABELS[mode], mode));
      select.value = s.mode;
      select.addEventListener('change', () => {
        s.mode = select.value as PaneMode;
        pane.mode = s.mode;
        select.blur(); // give the keyboard shortcuts back
      });
      bar.append(select);
      return pane;
    });
    cell(canvas, '3D');
    document.body.classList.add('quad-active');
    viewer.resize(); // the 3D view's new size, without a stretched frame
  };

  const hide = () => {
    panes.forEach((pane, i) => {
      saved[i]!.orbit = pane.camera.getOrbitState();
      viewer.removePane(pane);
    });
    panes = [];
    grid.parentNode?.insertBefore(canvas, grid); // the 3D view takes the whole viewport again
    grid.remove();
    grid.replaceChildren();
    document.body.classList.remove('quad-active');
    viewer.resize();
  };

  const layout: QuadLayout = {
    get active() { return panes.length > 0; },
    setActive(value) {
      if (value === layout.active) return;
      if (value) show();
      else hide();
      layout.onChange?.(value);
    },
    toggle() { layout.setActive(!layout.active); },
    modes: () => saved.map(s => s.mode),
  };
  if (active) show();
  return layout;
}

/** Top-bar toggle for the quad layout, left of the help button; pressed while the layout is shown. */
export function mountLayoutButton(layout: QuadLayout): void {
  const button = document.createElement('button');
  button.className = 'toolbar-btn layout-btn';
  button.innerHTML = GRID_ICON_SVG;
  const update = (active: boolean) => {
    button.setAttribute('aria-pressed', String(active));
    button.title = active ? 'Back to single view (Q)' : 'Front, side and top views (Q)';
  };
  button.addEventListener('click', () => layout.toggle());
  layout.onChange = update;
  update(layout.active);
  document.getElementById('help-btn')?.before(button);
}
