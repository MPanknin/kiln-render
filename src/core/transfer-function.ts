/**
 * Transfer function - maps density to RGBA color
 */

export type TFPreset = 'grayscale' | 'hot' | 'cool' | 'viridis' | 'plasma' | 'coolwarm';

export interface OpacityPoint {
  x: number;  // 0-1 density
  y: number;  // 0-1 opacity
}

export class TransferFunction {
  private device: GPUDevice;
  private size = 256;
  texture: GPUTexture;
  private colorData: Uint8Array;  // RGB only, no alpha
  private opacityPoints: OpacityPoint[];
  preset: TFPreset = 'grayscale';

  constructor(device: GPUDevice) {
    this.device = device;
    this.colorData = new Uint8Array(this.size * 3);
    this.opacityPoints = [
      { x: 0.0, y: 0.0 },
      { x: 0.25, y: 0.0 },
      { x: 1.0, y: 1.0 }
    ];

    this.texture = device.createTexture({
      size: [this.size],
      format: 'rgba8unorm',
      dimension: '1d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.setPreset('grayscale');
  }

  setPreset(preset: TFPreset): void {
    this.preset = preset;

    for (let i = 0; i < this.size; i++) {
      const t = i / (this.size - 1);
      const [r, g, b] = this.getPresetColor(preset, t);
      this.colorData[i * 3 + 0] = r;
      this.colorData[i * 3 + 1] = g;
      this.colorData[i * 3 + 2] = b;
    }

    this.updateTexture();
  }

  private getPresetColor(preset: TFPreset, t: number): [number, number, number] {
    switch (preset) {
      case 'grayscale':
        const v = Math.floor(t * 255);
        return [v, v, v];

      case 'hot':
        // Black -> Red -> Yellow -> White
        if (t < 0.33) {
          return [Math.floor(t * 3 * 255), 0, 0];
        } else if (t < 0.67) {
          return [255, Math.floor((t - 0.33) * 3 * 255), 0];
        } else {
          return [255, 255, Math.floor((t - 0.67) * 3 * 255)];
        }

      case 'cool':
        // Cyan -> Magenta
        return [
          Math.floor(t * 255),
          Math.floor((1 - t) * 255),
          255
        ];

      case 'viridis':
        // Approximate viridis colormap
        const viridis = [
          [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
          [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89],
          [180, 222, 44], [253, 231, 37]
        ];
        return this.interpolateColormap(viridis, t);

      case 'plasma':
        // Approximate plasma colormap
        const plasma = [
          [13, 8, 135], [75, 3, 161], [125, 3, 168], [168, 34, 150],
          [203, 70, 121], [229, 107, 93], [248, 148, 65], [253, 195, 40],
          [240, 249, 33]
        ];
        return this.interpolateColormap(plasma, t);

      case 'coolwarm':
      default:
        // Blue -> White -> Red
        if (t < 0.5) {
          const s = t * 2;
          return [
            Math.floor(s * 255),
            Math.floor(s * 255),
            255
          ];
        } else {
          const s = (t - 0.5) * 2;
          return [
            255,
            Math.floor((1 - s) * 255),
            Math.floor((1 - s) * 255)
          ];
        }
    }
  }

  private interpolateColormap(colors: number[][], t: number): [number, number, number] {
    const n = colors.length - 1;
    const idx = t * n;
    const i = Math.min(Math.floor(idx), n - 1);
    const f = idx - i;

    const c0 = colors[i]!;
    const c1 = colors[i + 1]!;

    return [
      Math.floor(c0[0]! + f * (c1[0]! - c0[0]!)),
      Math.floor(c0[1]! + f * (c1[1]! - c0[1]!)),
      Math.floor(c0[2]! + f * (c1[2]! - c0[2]!))
    ];
  }

  setOpacityPoints(points: OpacityPoint[]): void {
    // Sort by x and ensure endpoints
    this.opacityPoints = [...points].sort((a, b) => a.x - b.x);

    // Ensure we have start and end points
    if (this.opacityPoints.length === 0 || this.opacityPoints[0]!.x > 0) {
      this.opacityPoints.unshift({ x: 0, y: 0 });
    }
    if (this.opacityPoints[this.opacityPoints.length - 1]!.x < 1) {
      this.opacityPoints.push({ x: 1, y: 1 });
    }

    this.updateTexture();
  }

  getOpacityPoints(): OpacityPoint[] {
    return [...this.opacityPoints];
  }

  private sampleOpacity(t: number): number {
    // Find surrounding points
    let i = 0;
    while (i < this.opacityPoints.length - 1 && this.opacityPoints[i + 1]!.x < t) {
      i++;
    }

    const p0 = this.opacityPoints[i]!;
    const p1 = this.opacityPoints[Math.min(i + 1, this.opacityPoints.length - 1)]!;

    if (p0.x === p1.x) return p0.y;

    // Linear interpolation
    const f = (t - p0.x) / (p1.x - p0.x);
    return p0.y + f * (p1.y - p0.y);
  }

  private updateTexture(): void {
    const data = new Uint8Array(this.size * 4);

    for (let i = 0; i < this.size; i++) {
      const t = i / (this.size - 1);
      data[i * 4 + 0] = this.colorData[i * 3 + 0]!;
      data[i * 4 + 1] = this.colorData[i * 3 + 1]!;
      data[i * 4 + 2] = this.colorData[i * 3 + 2]!;
      data[i * 4 + 3] = Math.floor(this.sampleOpacity(t) * 255);
    }

    this.device.queue.writeTexture(
      { texture: this.texture },
      data,
      { bytesPerRow: this.size * 4 },
      [this.size]
    );
  }

  // Generate a canvas preview of the TF (for UI display)
  renderPreview(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // Clear
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    // Draw checkerboard pattern (for transparency visualization)
    const checkSize = 8;
    ctx.fillStyle = '#2a2a2a';
    for (let y = 0; y < h; y += checkSize) {
      for (let x = 0; x < w; x += checkSize) {
        if ((Math.floor(x / checkSize) + Math.floor(y / checkSize)) % 2 === 0) {
          ctx.fillRect(x, y, checkSize, checkSize);
        }
      }
    }

    // Draw color gradient with opacity
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);
      const i = Math.floor(t * (this.size - 1));
      const r = this.colorData[i * 3 + 0]!;
      const g = this.colorData[i * 3 + 1]!;
      const b = this.colorData[i * 3 + 2]!;
      const a = this.sampleOpacity(t);

      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      ctx.fillRect(x, 0, 1, h);
    }

    // Draw opacity curve
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);
      const opacity = this.sampleOpacity(t);
      const y = h - opacity * h;
      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Draw control points
    ctx.fillStyle = '#fff';
    for (const point of this.opacityPoints) {
      const x = point.x * w;
      const y = h - point.y * h;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

// Legacy function for backwards compatibility
export function createTransferFunction(device: GPUDevice): GPUTexture {
  const tf = new TransferFunction(device);
  return tf.texture;
}
