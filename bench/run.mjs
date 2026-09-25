// Bench runner: headless Chromium (real Metal WebGPU) against bench/server.mjs.
//
//   node bench/run.mjs [--workloads zebrafish,yeast] [--profiles cdn,fast]
//                      [--variants control=,p3=p3%3D1] [--runs 3] [--label name]
//                      [--dist dist] [--timeout 120000] [--headed]
//
// A variant is `name=extraQuery[@distDir]`. Variants with different dists get
// their own server on a separate port. Runs are interleaved across variants so
// slow drift affects them equally. Each run uses a fresh browser context (cold
// HTTP cache) — only the proxy's disk cache is warm, which is the point.
//
// Output: bench/results/<label>/<workload>.<profile>.<variant>.<n>.{json,png,log}
//         bench/results/<label>/summary.md

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { X509Certificate, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES, WORKLOADS, workloadUrl } from './workloads.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed bench cert
const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

const workloads = (args.workloads ?? Object.keys(WORKLOADS).join(',')).split(',').filter(Boolean);
const profiles = (args.profiles ?? 'cdn').split(',').filter(Boolean);
const runs = Number(args.runs ?? 3);
const timeoutMs = Number(args.timeout ?? 120000);
const label = args.label ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(here, 'results', label);
const defaultDist = path.resolve(args.dist ?? path.join(here, '..', 'dist'));
const variants = parseVariants(args.variants ?? 'control=');

for (const w of workloads) if (!WORKLOADS[w]) die(`unknown workload ${w}`);
for (const p of profiles) if (!PROFILES[p]) die(`unknown profile ${p}`);

await fsp.mkdir(outDir, { recursive: true });

// --- servers: one per distinct dist -----------------------------------------
const servers = new Map();
let nextPort = Number(args.port ?? 4800);
for (const v of variants) {
  const dist = v.dist ?? defaultDist;
  if (!servers.has(dist)) servers.set(dist, await startServer(dist, nextPort++));
  v.origin = servers.get(dist).origin;
}

// Trust the bench cert by SPKI hash rather than ignoring cert errors: Chrome
// refuses to HTTP-cache responses from connections with certificate errors,
// which would charge the network for repeat chunk fetches that the real CDN
// serves from the browser's disk cache.
const spki = createHash('sha256')
  .update(new X509Certificate(fs.readFileSync(path.join(here, 'certs', 'cert.pem'))).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
const browser = await chromium.launch({
  headless: !args.headed,
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal', `--ignore-certificate-errors-spki-list=${spki}`],
});

const results = [];
try {
  // --- warm the proxy cache: one unthrottled run per workload × dist -------
  for (const s of servers.values()) await control(s.origin, 'config', PROFILES.off);
  for (const w of workloads) {
    for (const s of servers.values()) {
      await control(s.origin, 'reset');
      const url = workloadUrl(s.origin, WORKLOADS[w], `bench=1&benchLabel=warm&benchTimeout=${timeoutMs * 3}`);
      log(`warm  ${w}  ${path.basename(s.dist)}`);
      const r = await runOnce(url, timeoutMs * 3, null);
      const st = await control(s.origin, 'stats');
      log(`      converge ${fmt(r?.convergeMs)}  misses ${st.misses}  served ${(st.bytes / 1e6).toFixed(1)} MB${r?.timedOut ? '  ⚠ timed out' : ''}`);
    }
  }

  // --- measured runs ---------------------------------------------------------
  for (const p of profiles) {
    for (const s of servers.values()) await control(s.origin, 'config', PROFILES[p]);
    for (const w of workloads) {
      for (let i = 1; i <= runs; i++) {
        for (const v of variants) {
          const name = `${w}.${p}.${v.name}.${i}`;
          await control(v.origin, 'reset');
          const url = workloadUrl(v.origin, WORKLOADS[w], `bench=1&benchLabel=${encodeURIComponent(v.name)}&benchTimeout=${timeoutMs}${v.query ? '&' + v.query : ''}`);
          const r = await runOnce(url, timeoutMs, path.join(outDir, name));
          if (r && v.query) {
            // Guard against the flags silently not reaching the page.
            for (const [k, val] of new URLSearchParams(v.query)) {
              if (new URLSearchParams(r.query).get(k) !== val) die(`variant ${v.name}: page query lacks ${k}=${val} — got ${r.query}`);
            }
          }
          const st = await control(v.origin, 'stats');
          const rec = { workload: w, profile: p, variant: v.name, run: i, url, proxy: st, ...(r ?? { failed: true }) };
          results.push(rec);
          await fsp.writeFile(path.join(outDir, name + '.json'), JSON.stringify(rec, null, 2));
          log(`${name.padEnd(34)} first ${fmt(r?.firstContentFrameMs)}  base50 ${fmt(r?.milestones?.baseCoverage50)}  base ${fmt(r?.baseCompleteMs)}  conv ${fmt(r?.convergeMs)}  req ${r?.requestCount ?? '-'}  ${r ? (r.bytesDownloaded / 1e6).toFixed(1) : '-'} MB${st.misses ? `  ⚠ ${st.misses} cache misses` : ''}${r?.timedOut ? '  ⚠ timed out' : ''}`);
        }
      }
    }
  }
} finally {
  await browser.close();
  for (const s of servers.values()) s.proc.kill();
}

const summary = summarize(results);
await fsp.writeFile(path.join(outDir, 'summary.md'), summary);
await fsp.writeFile(path.join(outDir, 'all.json'), JSON.stringify(results, null, 2));
console.log('\n' + summary);
console.log(`results: ${outDir}`);

// ---------------------------------------------------------------------------
async function runOnce(url, timeout, outBase) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const lines = [];
  page.on('console', m => lines.push(`${(performance.now() - t0).toFixed(0).padStart(7)} ${m.type()} ${m.text()}`));
  page.on('pageerror', e => lines.push(`PAGEERROR ${e.message}`));
  const t0 = performance.now();
  let report = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__KILN_BENCH_RESULT !== undefined, null, { timeout: timeout + 30000, polling: 200 });
    report = await page.evaluate(() => window.__KILN_BENCH_RESULT);
    if (outBase) await page.screenshot({ path: outBase + '.png' });
  } catch (e) {
    lines.push(`RUNNER ${e.message}`);
    if (outBase) await page.screenshot({ path: outBase + '.png' }).catch(() => {});
  } finally {
    if (outBase) await fsp.writeFile(outBase + '.log', lines.join('\n'));
    await ctx.close();
  }
  return report;
}

async function startServer(dist, port) {
  const proc = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(port), '--dist', dist], { stdio: ['ignore', 'pipe', 'inherit'] });
  const origin = `https://localhost:${port}`;
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { if (String(d).includes('[bench-server]')) resolve(); });
    proc.on('exit', c => reject(new Error(`server exited ${c}`)));
    setTimeout(() => reject(new Error('server start timeout')), 10000);
  });
  return { proc, origin, dist };
}

async function control(origin, op, body) {
  const r = await fetch(`${origin}/__bench/${op}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  return r.json();
}

function summarize(rs) {
  const key = r => `${r.workload}|${r.profile}|${r.variant}`;
  const groups = new Map();
  for (const r of rs) { if (!groups.has(key(r))) groups.set(key(r), []); groups.get(key(r)).push(r); }
  const out = [`# Bench ${label}`, '', `runs per cell: ${runs} · values are median (min–max), ms unless noted`, ''];
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
  out.push(`| workload | profile | variant | ${cols.map(c => c[0]).join(' | ')} | notes |`);
  out.push(`|---|---|---|${cols.map(() => '---').join('|')}|---|`);
  for (const [k, g] of groups) {
    const [w, p, v] = k.split('|');
    const ok = g.filter(r => !r.failed);
    const cells = cols.map(([, f]) => stat(ok.map(f)));
    const notes = [];
    if (g.some(r => r.failed)) notes.push(`${g.filter(r => r.failed).length} failed`);
    if (g.some(r => r.timedOut)) notes.push(`${g.filter(r => r.timedOut).length} timed out`);
    if (g.some(r => r.proxy?.misses)) notes.push('cache misses');
    out.push(`| ${w} | ${p} | ${v} | ${cells.join(' | ')} | ${notes.join(', ')} |`);
  }
  return out.join('\n') + '\n';
}

function stat(vals) {
  const xs = vals.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return 'n/a';
  const med = xs[Math.floor(xs.length / 2)];
  const f = x => (x >= 100 ? Math.round(x).toString() : x.toFixed(1));
  return xs.length > 1 ? `${f(med)} (${f(xs[0])}–${f(xs[xs.length - 1])})` : f(med);
}

function fmt(v) { return typeof v === 'number' ? Math.round(v).toString().padStart(6) + 'ms' : '     n/a'; }
function log(s) { console.log(s); }
function die(s) { console.error(s); process.exit(1); }
function parseVariants(spec) {
  return spec.split(',').filter(Boolean).map(s => {
    const eq = s.indexOf('=');
    const name = eq < 0 ? s : s.slice(0, eq);
    let rest = eq < 0 ? '' : s.slice(eq + 1);
    let dist;
    const at = rest.lastIndexOf('@');
    if (at >= 0) { dist = path.resolve(rest.slice(at + 1)); rest = rest.slice(0, at); }
    // Accept both `p20=1&p21=1` and a URL-encoded form; the page must see real `k=v` pairs.
    return { name, query: decodeURIComponent(rest), dist };
  });
}
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i]; o[k] = v; }
  }
  return o;
}
