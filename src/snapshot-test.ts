/**
 * Snapshot Testing Utility
 *
 * Run in browser console to capture/compare render output.
 * Usage:
 *   1. Set up scene how you want
 *   2. Call captureSnapshot('test-name') to save reference
 *   3. Later, call compareSnapshot('test-name') to check for differences
 */

export async function captureSnapshot(name: string): Promise<void> {
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Canvas not found');

  const dataUrl = canvas.toDataURL('image/png');

  // Store in localStorage (simple approach)
  localStorage.setItem(`snapshot:${name}`, dataUrl);
  console.log(`Snapshot '${name}' captured`);
}

export async function compareSnapshot(name: string, threshold = 0.01): Promise<boolean> {
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Canvas not found');

  const reference = localStorage.getItem(`snapshot:${name}`);
  if (!reference) {
    console.warn(`No reference snapshot '${name}' found. Capturing now.`);
    await captureSnapshot(name);
    return true;
  }

  const currentDataUrl = canvas.toDataURL('image/png');

  // Compare images
  const diff = await compareImages(reference, currentDataUrl);

  if (diff > threshold) {
    console.error(`Snapshot '${name}' differs by ${(diff * 100).toFixed(2)}%`);
    return false;
  }

  console.log(`Snapshot '${name}' matches (diff: ${(diff * 100).toFixed(4)}%)`);
  return true;
}

async function compareImages(dataUrl1: string, dataUrl2: string): Promise<number> {
  const [img1, img2] = await Promise.all([
    loadImage(dataUrl1),
    loadImage(dataUrl2),
  ]);

  const canvas1 = imageToCanvas(img1);
  const canvas2 = imageToCanvas(img2);

  const ctx1 = canvas1.getContext('2d')!;
  const ctx2 = canvas2.getContext('2d')!;

  const data1 = ctx1.getImageData(0, 0, canvas1.width, canvas1.height).data;
  const data2 = ctx2.getImageData(0, 0, canvas2.width, canvas2.height).data;

  if (data1.length !== data2.length) {
    return 1; // Different sizes = 100% different
  }

  let diffPixels = 0;
  for (let i = 0; i < data1.length; i += 4) {
    const r = Math.abs(data1[i] - data2[i]);
    const g = Math.abs(data1[i + 1] - data2[i + 1]);
    const b = Math.abs(data1[i + 2] - data2[i + 2]);
    if (r > 2 || g > 2 || b > 2) {
      diffPixels++;
    }
  }

  return diffPixels / (data1.length / 4);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function imageToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return canvas;
}

// Expose globally for console use
if (typeof window !== 'undefined') {
  (window as any).captureSnapshot = captureSnapshot;
  (window as any).compareSnapshot = compareSnapshot;
}
