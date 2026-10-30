// Serves the visual tests' data on :5199, with CORS and real 404s: the committed datasets in
// test/visual/fixtures, and a synthetic one written on first use (test/visual/.data): a 128³ uint8
// OME-Zarr (v0.4, uncompressed, two levels) with a label image `labels/cells` of four spheres,
// deterministic so every run renders the same scene.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.data/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('fixtures/', import.meta.url));
const SYNTH = path.join(ROOT, 'synth.zarr');
const N = 128;

function writeSynthetic(out) {
  const c = (N - 1) / 2;
  const spheres = [[40, 40, 64, 18], [88, 44, 64, 16], [64, 90, 50, 20], [64, 64, 96, 12]];
  const img = new Uint8Array(N ** 3);
  const lab = new Uint32Array(N ** 3);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (z * N + y) * N + x;
    const r = Math.hypot(x - c, y - c, z - c);
    let v = 255 * Math.exp(-((r - 40) ** 2) / 60); // a shell
    if (Math.sin(x / 9) * Math.sin(y / 11) * Math.sin(z / 7) > 0.6) v += 180; // texture inside
    img[i] = Math.min(255, v) | 0;
    spheres.forEach(([cx, cy, cz, rad], s) => {
      if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 < rad ** 2) lab[i] = s + 1;
    });
  }
  const half = (data, n) => {
    const m = n / 2;
    const res = new data.constructor(m ** 3);
    for (let z = 0; z < m; z++) for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      res[(z * m + y) * m + x] = data[((2 * z) * n + 2 * y) * n + 2 * x];
    }
    return res;
  };
  const json = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const writeArray = (dir, data, n, dtype, chunk = 64) => {
    json(`${dir}/.zarray`, {
      zarr_format: 2, shape: [n, n, n], chunks: [chunk, chunk, chunk], dtype, compressor: null,
      fill_value: 0, order: 'C', filters: null, dimension_separator: '/',
    });
    const count = Math.ceil(n / chunk);
    for (let cz = 0; cz < count; cz++) for (let cy = 0; cy < count; cy++) for (let cx = 0; cx < count; cx++) {
      const block = new data.constructor(chunk ** 3);
      for (let z = 0; z < chunk; z++) for (let y = 0; y < chunk; y++) for (let x = 0; x < chunk; x++) {
        const [gz, gy, gx] = [cz * chunk + z, cy * chunk + y, cx * chunk + x];
        if (gz < n && gy < n && gx < n) block[(z * chunk + y) * chunk + x] = data[(gz * n + gy) * n + gx];
      }
      const file = `${dir}/${cz}/${cy}/${cx}`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(block.buffer));
    }
  };
  const multiscales = (name) => [{
    version: '0.4', name,
    axes: ['z', 'y', 'x'].map(a => ({ name: a, type: 'space', unit: 'micrometer' })),
    datasets: [0, 1].map(i => ({ path: String(i), coordinateTransformations: [{ type: 'scale', scale: [2 ** i, 2 ** i, 2 ** i] }] })),
  }];

  json(`${out}/.zgroup`, { zarr_format: 2 });
  writeArray(`${out}/0`, img, N, '|u1');
  writeArray(`${out}/1`, half(img, N), N / 2, '|u1');
  json(`${out}/labels/.zgroup`, { zarr_format: 2 });
  json(`${out}/labels/.zattrs`, { labels: ['cells'] });
  json(`${out}/labels/cells/.zgroup`, { zarr_format: 2 });
  json(`${out}/labels/cells/.zattrs`, { multiscales: multiscales('cells'), 'image-label': { version: '0.4', source: { image: '../../' } } });
  writeArray(`${out}/labels/cells/0`, lab, N, '<u4');
  writeArray(`${out}/labels/cells/1`, half(lab, N), N / 2, '<u4');
  // Written last: its presence marks a complete dataset
  json(`${out}/.zattrs`, { multiscales: multiscales('synthetic') });
}

if (!fs.existsSync(path.join(SYNTH, '.zattrs'))) writeSynthetic(SYNTH);

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = [ROOT, FIXTURES].map(root => path.join(root, pathname))
    .find(f => (f.startsWith(ROOT) || f.startsWith(FIXTURES)) && fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) { res.writeHead(404); return res.end(); }
  res.writeHead(200);
  res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
}).listen(5199, '127.0.0.1', () => console.log('visual test data on http://127.0.0.1:5199'));
