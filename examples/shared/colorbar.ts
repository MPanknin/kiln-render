/** Colour legend: the transfer function's colour ramp labelled with raw window bounds. */

export interface Colorbar {
  update(colorAt: (t: number) => [number, number, number], lo: string, hi: string): void;
  setVisible(visible: boolean): void;
}

export function mountColorbar(): Colorbar {
  const el = document.createElement('div');
  el.className = 'colorbar';
  el.innerHTML = `
    <span class="colorbar-label colorbar-lo"></span>
    <canvas class="colorbar-ramp" width="160" height="1"></canvas>
    <span class="colorbar-label colorbar-hi"></span>
  `;
  document.body.appendChild(el);

  const canvas = el.querySelector('canvas')!;
  const ctx = canvas.getContext('2d')!;
  const loEl = el.querySelector<HTMLElement>('.colorbar-lo')!;
  const hiEl = el.querySelector<HTMLElement>('.colorbar-hi')!;
  const pixels = ctx.createImageData(canvas.width, 1);

  return {
    update(colorAt, lo, hi) {
      for (let x = 0; x < canvas.width; x++) {
        const [r, g, b] = colorAt(x / (canvas.width - 1));
        pixels.data.set([r, g, b, 255], x * 4);
      }
      ctx.putImageData(pixels, 0, 0);
      loEl.textContent = lo;
      hiEl.textContent = hi;
      el.title = `Window ${lo} – ${hi}`;
    },
    setVisible(visible) {
      el.style.display = visible ? '' : 'none';
    },
  };
}
