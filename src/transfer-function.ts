/**
 * Transfer function - maps density to RGBA color
 */

export function createTransferFunction(device: GPUDevice): GPUTexture {
  const size = 256;
  const data = new Uint8Array(size * 4);

  // Cool-warm colormap with opacity ramp
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);

    // Color: blue -> white -> red
    let r, g, b;
    if (t < 0.5) {
      const s = t * 2;
      r = Math.floor(s * 255);
      g = Math.floor(s * 255);
      b = 255;
    } else {
      const s = (t - 0.5) * 2;
      r = 255;
      g = Math.floor((1 - s) * 255);
      b = Math.floor((1 - s) * 255);
    }

    // Opacity: ramp up, with low values nearly transparent
    const a = Math.floor(Math.pow(t, 1.5) * 255);

    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }

  const texture = device.createTexture({
    size: [size],
    format: 'rgba8unorm',
    dimension: '1d',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: size * 4 },
    [size]
  );

  return texture;
}
