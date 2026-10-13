/** Small synthetic TCZYX dataset for exercising source selection in branch previews.
 * Six coloured objects move between four timepoints. Packed T/C chunks test offsets.
 */
import type { Plugin } from 'vite';

export function selectionDemoFiles(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const putJson = (name: string, data: unknown) => files.set(name, new TextEncoder().encode(JSON.stringify(data)));
  putJson('.zgroup', { zarr_format: 2 });
  putJson('.zattrs', {
    multiscales: [{ version: '0.4', name: 'Channel and time selection demo',
      axes: [{ name: 't', type: 'time', unit: 'second' }, { name: 'c', type: 'channel' },
        ...['z', 'y', 'x'].map(name => ({ name, type: 'space', unit: 'micrometer' }))],
      datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1, 1, 1] }] }],
    }],
    omero: { channels: ['FF5555', '55FF55', '5599FF', 'FFFF55', 'FF55FF', '55FFFF'].map((color, i) => ({
      label: `Object ${i + 1}`, color, active: true, window: { start: 0, end: 255, min: 0, max: 255 },
    })) },
  });
  const size = 32;
  putJson('0/.zarray', { zarr_format: 2, shape: [4, 6, size, size, size], chunks: [2, 3, size, size, size],
    dtype: '|u1', compressor: null, fill_value: 0, order: 'C', filters: null });
  putJson('0/.zattrs', {});
  for (let tc = 0; tc < 2; tc++) for (let cc = 0; cc < 2; cc++) {
    const data = new Uint8Array(2 * 3 * size ** 3);
    for (let t = 0; t < 2; t++) for (let c = 0; c < 3; c++) {
      const sourceC = cc * 3 + c, sourceT = tc * 2 + t;
      const angle = sourceC * Math.PI / 3;
      const center = [16 + 9 * Math.cos(angle), 16 + 9 * Math.sin(angle), 7 + sourceT * 6];
      for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const distance = Math.hypot(x - center[0]!, y - center[1]!, z - center[2]!);
        data[((((t * 3 + c) * size + z) * size + y) * size + x)] = Math.round(255 * Math.max(0, Math.min(1, 4.5 - distance)));
      }
    }
    files.set(`0/${tc}.${cc}.0.0.0`, data);
  }
  return files;
}

export function selectionDemo(): Plugin {
  const files = selectionDemoFiles();
  let base = '/';
  return {
    name: 'selection-demo',
    configResolved(config) { base = config.base; },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const prefix = `${base}selection-demo.zarr/`;
        if (!req.url?.startsWith(prefix)) return next();
        const data = files.get(req.url.slice(prefix.length).split('?')[0]!);
        if (!data) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(data);
      });
    },
    generateBundle() {
      for (const [path, source] of files) this.emitFile({ type: 'asset', fileName: `selection-demo.zarr/${path}`, source });
    },
  };
}
