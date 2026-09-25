// Rebuild summary.md for a results directory from its per-run JSON files.
//   node bench/summarize.mjs bench/results/<label> [--baseline control]
// One row per (workload, variant, phase): phase "load" is the initial load,
// then one row per camera scenario. With --baseline, medians are shown relative
// to that variant (negative = faster / fewer) and converged full-resolution
// frames are compared against it:
//   PSNR   luminance PSNR vs the baseline's frames (dB; baseline row = its own
//          run-to-run noise floor; "∞" = identical)
//   detail mean |Laplacian| relative to the baseline (1.00 = equally sharp,
//          < 1 = detail lost)

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const dir = process.argv[2];
if (!dir) { console.error('usage: node bench/summarize.mjs <results-dir> [--baseline name]'); process.exit(1); }
const bi = process.argv.indexOf('--baseline');
const baseline = bi > 0 ? process.argv[bi + 1] : null;

const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json') && f !== 'all.json');
const runs = [];
for (const f of files) runs.push(JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')));

const LOAD_COLS = [
  ['first content', r => r.firstContentFrameMs],
  ['ch0 done', r => r.milestones?.baseChannel0Complete],
  ['base done', r => r.baseCompleteMs],
  ['converge', r => r.convergeMs],
  ['requests', r => r.requestCount],
  ['MB', r => r.bytesDownloaded / 1e6],
  ['wire MB', r => (r.proxy?.bytes ?? NaN) / 1e6],
];
const SCEN_COLS = [
  ['first brick', s => s.firstCommitMs],
  ['90%', s => s.desired90Ms],
  ['reconverge', s => s.reconvergeMs],
  ['after stop', s => s.afterStopMs],
  ['wire MB', s => s.wireBytes / 1e6],
  ['store MB', s => s.bytesDownloaded / 1e6],
  ['cancelled', s => s.cancelled],
  ['discarded', s => s.discarded],
];

// Flatten: { workload, variant, phase, sample, image }
const rows = [];
for (const r of runs) {
  if (r.failed) { rows.push({ workload: r.workload, variant: r.variant, phase: 'load', failed: true }); continue; }
  const frame = phase => path.join(dir, `${r.workload}.${r.profile}.${r.variant}.${r.run}.${phase}.gray.gz`);
  rows.push({ workload: r.workload, variant: r.variant, phase: 'load', sample: r, image: r.image, frame: frame('load'), timedOut: r.timedOut, misses: r.proxy?.misses });
  for (const sc of r.scenarios ?? []) rows.push({ workload: r.workload, variant: r.variant, phase: sc.name, sample: sc, image: sc.image, frame: frame(sc.name), timedOut: sc.timedOut });
}
const groups = new Map();
for (const row of rows) {
  const k = `${row.workload}|${row.phase}|${row.variant}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(row);
}
const phaseOrder = p => (p === 'load' ? 0 : 1);
const keys = [...groups.keys()].sort((a, b) => {
  const [wa, pa, va] = a.split('|'), [wb, pb, vb] = b.split('|');
  return wa.localeCompare(wb) || (phaseOrder(pa) - phaseOrder(pb)) || pa.localeCompare(pb)
    || (va === baseline ? -1 : vb === baseline ? 1 : va.localeCompare(vb));
});

const out = [`# Bench ${path.basename(dir)}`, '', 'median (min–max), ms unless noted' + (baseline ? `; Δ vs ${baseline} median; PSNR/detail vs ${baseline} converged frames (baseline row = own noise floor)` : ''), ''];
let lastPhaseKind = null;
for (const k of keys) {
  const g = groups.get(k);
  const [w, p, v] = k.split('|');
  const kind = p === 'load' ? 'load' : 'scenario';
  const cols = kind === 'load' ? LOAD_COLS : SCEN_COLS;
  if (kind !== lastPhaseKind) {
    out.push('', `| workload | phase | variant | n | ${cols.map(c => c[0]).join(' | ')} | PSNR | detail | notes |`);
    out.push(`|---|---|---|---|${cols.map(() => '---').join('|')}|---|---|---|`);
    lastPhaseKind = kind;
  }
  const ok = g.filter(r => !r.failed && r.sample);
  const base = baseline && v !== baseline ? (groups.get(`${w}|${p}|${baseline}`) ?? []).filter(r => !r.failed && r.sample) : null;
  const cells = cols.map(([, f]) => {
    const vals = ok.map(r => f(r.sample));
    const s = stat(vals);
    if (!base) return s;
    const m = median(vals), mb = median(base.map(r => f(r.sample)));
    if (m === null || mb === null || mb === 0) return s;
    const d = (m - mb) / mb * 100;
    return `${s} ${d <= -1 ? '**' : ''}(${d > 0 ? '+' : ''}${d.toFixed(0)}%)${d <= -1 ? '**' : ''}`;
  });
  const { psnr, detail } = frameMetrics(ok, base ?? ok);
  const notes = [];
  if (g.some(r => r.failed)) notes.push(`${g.filter(r => r.failed).length} failed`);
  if (g.some(r => r.timedOut)) notes.push(`${g.filter(r => r.timedOut).length} timed out`);
  if (g.some(r => r.misses)) notes.push('cache misses');
  out.push(`| ${w} | ${p} | ${v} | ${ok.length} | ${cells.join(' | ')} | ${psnr} | ${detail} | ${notes.join(', ')} |`);
}
const md = out.join('\n') + '\n';
await fsp.writeFile(path.join(dir, 'summary.md'), md);
console.log(md);

// ---- full-resolution frame metrics -------------------------------------------------------------
const frameCache = new Map();
function loadFrame(file) {
  if (!file || !fs.existsSync(file)) return null;
  if (!frameCache.has(file)) {
    const buf = gunzipSync(fs.readFileSync(file));
    frameCache.set(file, { w: buf.readUInt32LE(0), h: buf.readUInt32LE(4), px: buf.subarray(8) });
  }
  return frameCache.get(file);
}
function psnrOf(a, b) {
  if (a.w !== b.w || a.h !== b.h) return null;
  let se = 0;
  for (let i = 0; i < a.px.length; i++) { const d = a.px[i] - b.px[i]; se += d * d; }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / a.px.length));
}
const detailCache = new Map();
function detailOf(f) {
  if (detailCache.has(f)) return detailCache.get(f);
  let sum = 0;
  const { w, h, px } = f;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    sum += Math.abs(4 * px[i] - px[i - 1] - px[i + 1] - px[i - w] - px[i + w]);
  }
  const d = sum / ((w - 2) * (h - 2));
  detailCache.set(f, d);
  return d;
}
/** Median pairwise PSNR against the reference group (own runs when g === ref) and detail ratio. */
function frameMetrics(g, ref) {
  const A = g.map(r => loadFrame(r.frame)).filter(Boolean);
  const B = ref.map(r => loadFrame(r.frame)).filter(Boolean);
  if (!A.length || !B.length) return { psnr: '', detail: '' };
  const vals = [];
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
    if (g === ref && j <= i) continue;
    const p = psnrOf(A[i], B[j]);
    if (p !== null) vals.push(p);
  }
  vals.sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  const psnr = med === null ? '' : med === Infinity ? '∞' : med.toFixed(1);
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const detail = (mean(A.map(detailOf)) / mean(B.map(detailOf))).toFixed(2);
  return { psnr, detail };
}
function nums(vals) { return vals.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b); }
function median(vals) { const xs = nums(vals); return xs.length ? xs[Math.floor(xs.length / 2)] : null; }
function stat(vals) {
  const xs = nums(vals);
  if (!xs.length) return 'n/a';
  const f = x => (x >= 100 ? Math.round(x).toString() : x.toFixed(1));
  const med = xs[Math.floor(xs.length / 2)];
  return xs.length > 1 ? `${f(med)} (${f(xs[0])}–${f(xs[xs.length - 1])})` : f(med);
}
