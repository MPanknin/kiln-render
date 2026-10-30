// Serves the visual tests' data on :5199, with CORS and real 404s: the committed datasets in
// test/visual/fixtures, and synthetic ones written on first use (test/visual/.data), deterministic
// so every run renders the same scene. All synthetic data is OME-Zarr v0.4, uncompressed, two levels,
// built from distance-field shapes with soft edges:
// - synth.zarr: 128³ uint8, eight shapes in the octants and a cube across the brick seams at the
//   centre, each with its own intensity; the label image `labels/shapes` has one segment per shape
// - synth-u16.zarr, synth-f32.zarr: the same image as uint16 and float32 (0–1), without labels
// - synth-tc.zarr: 3 timepoints × 5 channels of 90×120×100 (zyx) uint8, z spacing 2
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.data/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('fixtures/', import.meta.url));
const CHUNK = 64;

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function zarray(dir, shape, dtype) {
  json(`${dir}/.zarray`, {
    zarr_format: 2, shape, chunks: [...shape.slice(0, -3).map(() => 1), CHUNK, CHUNK, CHUNK], dtype,
    compressor: null, fill_value: 0, order: 'C', filters: null, dimension_separator: '/',
  });
}

/** One zyx volume as chunk files under dir/<lead…>/cz/cy/cx, edge chunks zero-padded */
function writeChunks(dir, data, [nz, ny, nx], lead = []) {
  for (let cz = 0; cz < Math.ceil(nz / CHUNK); cz++) for (let cy = 0; cy < Math.ceil(ny / CHUNK); cy++) for (let cx = 0; cx < Math.ceil(nx / CHUNK); cx++) {
    const block = new data.constructor(CHUNK ** 3);
    for (let z = 0; z < CHUNK; z++) for (let y = 0; y < CHUNK; y++) for (let x = 0; x < CHUNK; x++) {
      const [gz, gy, gx] = [cz * CHUNK + z, cy * CHUNK + y, cx * CHUNK + x];
      if (gz < nz && gy < ny && gx < nx) block[(z * CHUNK + y) * CHUNK + x] = data[(gz * ny + gy) * nx + gx];
    }
    const file = [dir, ...lead, cz, cy, cx].join('/');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(block.buffer));
  }
}

/** Every second voxel: the next level down */
function half(data, [nz, ny, nx]) {
  const dims = [Math.ceil(nz / 2), Math.ceil(ny / 2), Math.ceil(nx / 2)];
  const res = new data.constructor(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[0]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[2]; x++) {
    res[(z * dims[1] + y) * dims[2] + x] = data[((2 * z) * ny + 2 * y) * nx + 2 * x];
  }
  return [res, dims];
}

/** A zyx volume as a two-level array: levels 0 and 1 under dir */
function writeLevels(dir, data, dims, dtype) {
  zarray(`${dir}/0`, dims, dtype);
  writeChunks(`${dir}/0`, data, dims);
  const [low, lowDims] = half(data, dims);
  zarray(`${dir}/1`, lowDims, dtype);
  writeChunks(`${dir}/1`, low, lowDims);
}

function multiscales(name, axes, scale) {
  return [{
    version: '0.4', name, axes,
    datasets: [0, 1].map(i => ({
      path: String(i),
      coordinateTransformations: [{ type: 'scale', scale: scale.map((s, a) => a < axes.length - 3 ? s : s * 2 ** i) }],
    })),
  }];
}

const SPACE = ['z', 'y', 'x'].map(a => ({ name: a, type: 'space', unit: 'micrometer' }));

// Signed distances (negative inside) to shapes centred on the origin
const length = (x, y, z) => Math.hypot(x, y, z);
const SHAPES = {
  sphere: (x, y, z, r) => length(x, y, z) - r,
  shell: (x, y, z, r, t) => Math.abs(length(x, y, z) - r) - t,
  box: (x, y, z, h) => {
    const [qx, qy, qz] = [Math.abs(x) - h, Math.abs(y) - h, Math.abs(z) - h];
    return length(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
  },
  torus: (x, y, z, R, r) => Math.hypot(Math.hypot(x, y) - R, z) - r, // around z
  octahedron: (x, y, z, s) => (Math.abs(x) + Math.abs(y) + Math.abs(z) - s) * 0.57735,
  tetrahedron: (x, y, z, s) => (Math.max(Math.abs(x + y) - z, Math.abs(x - y) + z) - s) * 0.57735,
  cylinder: (x, y, z, r, h) => Math.max(Math.hypot(x, z) - r, Math.abs(y) - h), // along y
  gyroidBall: (x, y, z, r) => {
    const f = 0.35;
    const g = Math.sin(f * x) * Math.cos(f * y) + Math.sin(f * y) * Math.cos(f * z) + Math.sin(f * z) * Math.cos(f * x);
    return Math.max(Math.abs(g) / f - 1.5, length(x, y, z) - r);
  },
};

/** Rotation about the z axis */
const turn = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

/** 0 outside, 1 inside, a two-unit ramp across the surface */
const soft = d => Math.min(1, Math.max(0, 0.5 - d / 2));

// synth.zarr: [distance, intensity] per shape at voxel (x, y, z); label = index + 1
const OCTANT_SHAPES = [
  (x, y, z) => { const d = SHAPES.sphere(x - 40, y - 40, z - 40, 20); return [d, 0.4 + 0.6 * Math.max(0, -d / 20)]; },
  (x, y, z) => [SHAPES.torus(x - 88, y - 40, z - 40, 14, 6), 0.9],
  (x, y, z) => [SHAPES.octahedron(x - 40, y - 88, z - 40, 24), 0.6],
  (x, y, z) => [SHAPES.tetrahedron(x - 88, y - 88, z - 40, 12), 0.75],
  (x, y, z) => [SHAPES.gyroidBall(x - 40, y - 40, z - 88, 20), 0.5],
  (x, y, z) => [SHAPES.shell(x - 88, y - 40, z - 88, 18, 2), 1],
  (x, y, z) => [SHAPES.cylinder(x - 40, y - 88, z - 88, 10, 18), 0.45],
  (x, y, z) => { const [u, v] = turn(x - 88, y - 88, Math.PI / 4); return [SHAPES.box(u, v, z - 88, 13), 0.8]; },
  (x, y, z) => [SHAPES.box(x - 64, y - 64, z - 64, 12), 0.3],
];

const DTYPES = {
  '|u1': [Uint8Array, v => Math.round(255 * v)],
  '<u2': [Uint16Array, v => Math.round(255 * v) * 257],
  '<f4': [Float32Array, v => Math.round(255 * v) / 255],
};

function writeSynthetic(out, dtype) {
  const N = 128;
  const [Type, convert] = DTYPES[dtype];
  const img = new Type(N ** 3);
  const lab = new Uint32Array(N ** 3);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (z * N + y) * N + x;
    let v = 0;
    OCTANT_SHAPES.forEach((shape, s) => {
      const [d, intensity] = shape(x, y, z);
      v = Math.max(v, intensity * soft(d));
      if (d < 0) lab[i] = s + 1;
    });
    img[i] = convert(v);
  }
  const dims = [N, N, N];
  json(`${out}/.zgroup`, { zarr_format: 2 });
  writeLevels(out, img, dims, dtype);
  if (dtype === '|u1') {
    json(`${out}/labels/.zgroup`, { zarr_format: 2 });
    json(`${out}/labels/.zattrs`, { labels: ['shapes'] });
    json(`${out}/labels/shapes/.zgroup`, { zarr_format: 2 });
    json(`${out}/labels/shapes/.zattrs`, { multiscales: multiscales('shapes', SPACE, [1, 1, 1]), 'image-label': { version: '0.4', source: { image: '../../' } } });
    writeLevels(`${out}/labels/shapes`, lab, dims, '<u4');
  }
  // Written last: its presence marks a complete dataset
  json(`${out}/.zattrs`, { multiscales: multiscales('synthetic', SPACE, [1, 1, 1]) });
}

/**
 * Channels in physical units (z spacing 2, centre 50, 60, 90): a torus tilting over time, a sphere
 * moving in x, a gyroid ball, a box with a z gradient, an octahedron moving in y
 */
function writeTimeChannels(out) {
  const [T, C] = [3, 5];
  const dims = [90, 120, 100];
  const [nz, ny, nx] = dims;
  const value = (t, c, x, y, pz) => {
    if (c === 0) {
      const [v, w] = turn(y - 60, pz - 90, t * Math.PI / 6);
      return soft(SHAPES.torus(x - 50, v, w, 30, 7)) * 0.8;
    }
    if (c === 1) {
      const d = SHAPES.sphere(x - 25 - 25 * t, y - 60, pz - 90, 18);
      return soft(d) * (0.4 + 0.6 * Math.max(0, -d / 18));
    }
    if (c === 2) return soft(SHAPES.gyroidBall(x - 50, y - 60, pz - 90, 40)) * 0.6;
    if (c === 3) return soft(SHAPES.box(x - 50, y - 60, (pz - 90) / 3, 18)) * (0.3 + 0.7 * pz / 178);
    return soft(SHAPES.octahedron(x - 50, y - 30 - 30 * t, pz - 150, 22));
  };
  zarray(`${out}/0`, [T, C, ...dims], '|u1');
  zarray(`${out}/1`, [T, C, ...dims.map(n => Math.ceil(n / 2))], '|u1');
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) {
    const vol = new Uint8Array(nz * ny * nx);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      vol[(z * ny + y) * nx + x] = Math.round(255 * value(t, c, x, y, 2 * z));
    }
    writeChunks(`${out}/0`, vol, dims, [t, c]);
    const [low, lowDims] = half(vol, dims);
    writeChunks(`${out}/1`, low, lowDims, [t, c]);
  }
  json(`${out}/.zgroup`, { zarr_format: 2 });
  const axes = [{ name: 't', type: 'time' }, { name: 'c', type: 'channel' }, ...SPACE];
  json(`${out}/.zattrs`, { multiscales: multiscales('synthetic-tc', axes, [1, 1, 2, 1, 1]) });
}

const DATASETS = {
  'synth.zarr': out => writeSynthetic(out, '|u1'),
  'synth-u16.zarr': out => writeSynthetic(out, '<u2'),
  'synth-f32.zarr': out => writeSynthetic(out, '<f4'),
  'synth-tc.zarr': writeTimeChannels,
};
for (const [name, write] of Object.entries(DATASETS)) {
  if (!fs.existsSync(path.join(ROOT, name, '.zattrs'))) write(path.join(ROOT, name));
}

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = [ROOT, FIXTURES].map(root => path.join(root, pathname))
    .find(f => (f.startsWith(ROOT) || f.startsWith(FIXTURES)) && fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) { res.writeHead(404); return res.end(); }
  // Sharded Zarr v3 reads the shard index with HEAD (for the size) and then byte ranges
  const data = fs.readFileSync(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let body = data;
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    body = data.subarray(start, end + 1);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
  }
  res.writeHead(range ? 206 : 200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
  res.end(req.method === 'HEAD' ? undefined : body);
}).listen(5199, '127.0.0.1', () => console.log('visual test data on http://127.0.0.1:5199'));
