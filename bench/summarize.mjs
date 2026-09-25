// Rebuild summary.md for a results directory from its per-run JSON files.
//   node bench/summarize.mjs bench/results/<label> [--baseline control]
// One row per (workload, variant, phase): phase "load" is the initial load,
// then one row per camera scenario. With --baseline, medians are shown relative
// to that variant (negative = faster / fewer) and the converged image is
// compared against it: "img" is the mean absolute luminance difference of the
// 64×40 thumbnails (0.0 = identical hash on every run).

import fsp from 'node:fs/promises';
import path from 'node:path';

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
  ['50%', s => s.desired50Ms],
  ['90%', s => s.desired90Ms],
  ['reconverge', s => s.reconvergeMs],
  ['requests', s => s.requests],
  ['MB', s => s.bytesDownloaded / 1e6],
  ['cancelled', s => s.cancelled],
  ['peak pending', s => s.peakPending],
];

// Flatten: { workload, variant, phase, sample, image }
const rows = [];
for (const r of runs) {
  if (r.failed) { rows.push({ workload: r.workload, variant: r.variant, phase: 'load', failed: true }); continue; }
  rows.push({ workload: r.workload, variant: r.variant, phase: 'load', sample: r, image: r.image, timedOut: r.timedOut, misses: r.proxy?.misses });
  for (const sc of r.scenarios ?? []) rows.push({ workload: r.workload, variant: r.variant, phase: sc.name, sample: sc, image: sc.image, timedOut: sc.timedOut });
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

const out = [`# Bench ${path.basename(dir)}`, '', 'median (min–max), ms unless noted' + (baseline ? `; Δ vs ${baseline} median; img = thumbnail MAD vs ${baseline} (0 = identical)` : ''), ''];
let lastPhaseKind = null;
for (const k of keys) {
  const g = groups.get(k);
  const [w, p, v] = k.split('|');
  const kind = p === 'load' ? 'load' : 'scenario';
  const cols = kind === 'load' ? LOAD_COLS : SCEN_COLS;
  if (kind !== lastPhaseKind) {
    out.push('', `| workload | phase | variant | n | ${cols.map(c => c[0]).join(' | ')} | img | notes |`);
    out.push(`|---|---|---|---|${cols.map(() => '---').join('|')}|---|---|`);
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
  const img = imageDiff(ok, base ?? (baseline ? null : ok));
  const notes = [];
  if (g.some(r => r.failed)) notes.push(`${g.filter(r => r.failed).length} failed`);
  if (g.some(r => r.timedOut)) notes.push(`${g.filter(r => r.timedOut).length} timed out`);
  if (g.some(r => r.misses)) notes.push('cache misses');
  out.push(`| ${w} | ${p} | ${v} | ${ok.length} | ${cells.join(' | ')} | ${img} | ${notes.join(', ')} |`);
}
const md = out.join('\n') + '\n';
await fsp.writeFile(path.join(dir, 'summary.md'), md);
console.log(md);

/** Mean absolute thumbnail difference between this group's images and the reference group's. */
function imageDiff(g, ref) {
  const imgs = g.map(r => r.image).filter(Boolean);
  if (!ref || imgs.length === 0) return '';
  const refImgs = ref.map(r => r.image).filter(Boolean);
  if (refImgs.length === 0) return '';
  const refHashes = new Set(refImgs.map(i => i.hash));
  if (imgs.every(i => refHashes.has(i.hash))) return '0.0';
  let sum = 0, n = 0;
  for (const a of imgs) for (const b of refImgs) {
    if (a.thumb.length !== b.thumb.length) continue;
    let d = 0;
    for (let i = 0; i < a.thumb.length; i++) d += Math.abs(a.thumb[i] - b.thumb[i]);
    sum += d / a.thumb.length; n++;
  }
  return n ? (sum / n).toFixed(1) : '';
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
