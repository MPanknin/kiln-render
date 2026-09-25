// Rebuild summary.md for a results directory from its per-run JSON files.
//   node bench/summarize.mjs bench/results/<label> [--baseline control]
// With --baseline, each variant's medians are also shown relative to the
// named variant (negative = faster / fewer).

import fsp from 'node:fs/promises';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node bench/summarize.mjs <results-dir> [--baseline name]'); process.exit(1); }
const bi = process.argv.indexOf('--baseline');
const baseline = bi > 0 ? process.argv[bi + 1] : null;

const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json') && f !== 'all.json');
const runs = [];
for (const f of files) runs.push(JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')));

const cols = [
  ['first content', r => r.firstContentFrameMs],
  ['base 50%', r => r.milestones?.baseCoverage50],
  ['ch0 done', r => r.milestones?.baseChannel0Complete],
  ['base done', r => r.baseCompleteMs],
  ['converge', r => r.convergeMs],
  ['requests', r => r.requestCount],
  ['MB', r => r.bytesDownloaded / 1e6],
  ['wire MB', r => (r.proxy?.bytes ?? NaN) / 1e6],
];

const groups = new Map();
for (const r of runs) {
  const k = `${r.workload}|${r.profile}|${r.variant}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const keys = [...groups.keys()].sort((a, b) => {
  const [wa, pa, va] = a.split('|'), [wb, pb, vb] = b.split('|');
  return wa.localeCompare(wb) || pa.localeCompare(pb) || (va === baseline ? -1 : vb === baseline ? 1 : va.localeCompare(vb));
});

const out = [`# Bench ${path.basename(dir)}`, '', 'median (min–max), ms unless noted' + (baseline ? `; Δ vs ${baseline} median` : ''), ''];
out.push(`| workload | profile | variant | n | ${cols.map(c => c[0]).join(' | ')} | notes |`);
out.push(`|---|---|---|---|${cols.map(() => '---').join('|')}|---|`);
for (const k of keys) {
  const g = groups.get(k);
  const [w, p, v] = k.split('|');
  const ok = g.filter(r => !r.failed);
  const base = baseline && v !== baseline ? groups.get(`${w}|${p}|${baseline}`)?.filter(r => !r.failed) : null;
  const cells = cols.map(([, f]) => {
    const s = stat(ok.map(f));
    if (!base) return s;
    const m = median(ok.map(f)), mb = median(base.map(f));
    if (m === null || mb === null || mb === 0) return s;
    const d = (m - mb) / mb * 100;
    return `${s} ${d <= -1 ? '**' : ''}(${d > 0 ? '+' : ''}${d.toFixed(0)}%)${d <= -1 ? '**' : ''}`;
  });
  const notes = [];
  if (g.some(r => r.failed)) notes.push(`${g.filter(r => r.failed).length} failed`);
  if (g.some(r => r.timedOut)) notes.push(`${g.filter(r => r.timedOut).length} timed out`);
  if (g.some(r => r.proxy?.misses)) notes.push('cache misses');
  out.push(`| ${w} | ${p} | ${v} | ${ok.length} | ${cells.join(' | ')} | ${notes.join(', ')} |`);
}
const md = out.join('\n') + '\n';
await fsp.writeFile(path.join(dir, 'summary.md'), md);
console.log(md);

function nums(vals) { return vals.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b); }
function median(vals) { const xs = nums(vals); return xs.length ? xs[Math.floor(xs.length / 2)] : null; }
function stat(vals) {
  const xs = nums(vals);
  if (!xs.length) return 'n/a';
  const f = x => (x >= 100 ? Math.round(x).toString() : x.toFixed(1));
  const med = xs[Math.floor(xs.length / 2)];
  return xs.length > 1 ? `${f(med)} (${f(xs[0])}–${f(xs[xs.length - 1])})` : f(med);
}
