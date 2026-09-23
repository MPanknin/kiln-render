/** Orientation gizmo: click an axis end to view from that side; home restores the initial view. */

import type { Camera, UpAxis } from '@kiln/core/camera.js';

const SIZE = 72;
const AXIS_LEN = 24;
const AXES = [
  { dir: [1, 0, 0], label: 'X', color: '#e5534b' },
  { dir: [0, 1, 0], label: 'Y', color: '#57ab5a' },
  { dir: [0, 0, 1], label: 'Z', color: '#539bf5' },
] as const;

const HOME_ICON_SVG = '<svg viewBox="0 0 16 16"><path d="M8.707 1.5a1 1 0 0 0-1.414 0L.646 8.146a.5.5 0 0 0 .708.708L2 8.207V13.5A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V8.207l.646.647a.5.5 0 0 0 .708-.708L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293z"/></svg>';

interface Handle { x: number; y: number; depth: number; dir: [number, number, number]; label: string; color: string; positive: boolean }

export interface OrientationGizmo {
  /** View from world direction `dir` (e.g. [1, 0, 0] = from +X). */
  snap(dir: [number, number, number]): void;
  /** Back to the view the page loaded with. */
  reset(): void;
}

export function mountOrientationGizmo(camera: Camera): OrientationGizmo {
  const home = { upAxis: camera.getUpAxis() as UpAxis, orbit: camera.getOrbitState() };

  const el = document.createElement('div');
  el.className = 'orientation-gizmo';
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.height = SIZE * dpr;
  canvas.style.width = canvas.style.height = `${SIZE}px`;
  const homeBtn = document.createElement('button');
  homeBtn.type = 'button';
  homeBtn.className = 'toolbar-btn orientation-gizmo-home';
  homeBtn.title = 'Reset view (R)';
  homeBtn.innerHTML = HOME_ICON_SVG;
  el.append(canvas, homeBtn);
  document.body.appendChild(el);

  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  let handles: Handle[] = [];

  // Axis ends in gizmo pixels, sorted back to front
  const project = (): Handle[] => {
    const m = camera.getViewMatrix();
    const out: Handle[] = [];
    AXES.forEach((a, i) => {
      const vx = m[i * 4]!, vy = m[i * 4 + 1]!, vz = m[i * 4 + 2]!;
      for (const s of [1, -1]) {
        out.push({
          x: SIZE / 2 + s * vx * AXIS_LEN, y: SIZE / 2 - s * vy * AXIS_LEN, depth: s * vz,
          dir: [a.dir[0] * s, a.dir[1] * s, a.dir[2] * s], label: a.label, color: a.color, positive: s > 0,
        });
      }
    });
    return out.sort((p, q) => p.depth - q.depth);
  };

  const draw = () => {
    handles = project();
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const h of handles) {
      if (h.positive) {
        ctx.strokeStyle = h.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(SIZE / 2, SIZE / 2);
        ctx.lineTo(h.x, h.y);
        ctx.stroke();
      }
      ctx.globalAlpha = h.positive ? 1 : 0.4;
      ctx.fillStyle = h.color;
      ctx.beginPath();
      ctx.arc(h.x, h.y, h.positive ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (h.positive) {
        ctx.fillStyle = '#1a1a1c';
        ctx.fillText(h.label, h.x, h.y + 0.5);
      }
    }
  };

  // Front-most handle under the pointer
  const hit = (e: MouseEvent): Handle | undefined => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return [...handles].reverse().find((h) => Math.hypot(h.x - x, h.y - y) <= (h.positive ? 9 : 7));
  };

  const snap = (dir: [number, number, number]) => camera.lookFrom(dir);
  const reset = () => {
    // Orbit angles are up-axis specific; after an up-axis change fall back to its defaults
    if (camera.getUpAxis() === home.upAxis) camera.setOrbitState(home.orbit);
    else camera.setUpAxis(camera.getUpAxis());
  };

  canvas.addEventListener('pointermove', (e) => {
    const h = hit(e);
    canvas.style.cursor = h ? 'pointer' : '';
    canvas.title = h ? `View from ${h.positive ? '+' : '−'}${h.label}` : '';
  });
  canvas.addEventListener('click', (e) => {
    const h = hit(e);
    if (h) snap(h.dir);
  });
  homeBtn.addEventListener('click', reset);

  // Redraw only when the camera changed
  let drawnVersion = -1;
  const tick = () => {
    if (camera.version !== drawnVersion) {
      drawnVersion = camera.version;
      draw();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return { snap, reset };
}
