/** Screenshot button: waits for streaming + accumulation to settle, then saves a PNG. */

import type { KilnViewer } from 'kiln-render';
import type { Toast } from './toast.js';

const SETTLE_TIMEOUT_MS = 20_000;
// Consecutive idle frames required, so a brief gap between loads doesn't count
const SETTLE_FRAMES = 10;

function waitUntilSettled(viewer: KilnViewer): Promise<boolean> {
  const start = performance.now();
  let idleFrames = 0;
  return new Promise((resolve) => {
    const tick = () => {
      const idle = viewer.streamingManager.getStats().pendingCount === 0 && viewer.renderer.isConverged;
      idleFrames = idle ? idleFrames + 1 : 0;
      if (idleFrames >= SETTLE_FRAMES) return resolve(true);
      if (performance.now() - start > SETTLE_TIMEOUT_MS) return resolve(false);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function fileName(datasetName: string): string {
  const base = datasetName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'kiln';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `${base}-${stamp}.png`;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Wires #screenshot-btn and returns the trigger (for keyboard shortcuts). */
export function setupScreenshotButton(viewer: KilnViewer, toast: Toast): () => void {
  const button = document.getElementById('screenshot-btn');
  let busy = false;

  const take = async () => {
    if (busy) return;
    busy = true;
    button?.classList.add('busy');
    // Full resolution for the capture; the user's scale is restored afterwards
    const userScale = viewer.renderScale;
    viewer.renderScale = 1;
    try {
      const settled = await waitUntilSettled(viewer);
      download(await viewer.captureImage(), fileName(viewer.metadata.name));
      if (!settled) toast.show('Saved before loading finished', 2500);
    } catch (e) {
      console.error(e);
      toast.show('Screenshot failed', 2500);
    } finally {
      viewer.renderScale = userScale;
      button?.classList.remove('busy');
      busy = false;
    }
  };

  button?.addEventListener('click', () => void take());
  return () => void take();
}
