// Bench server: serves the production build + a caching, throttled dataset proxy.
//
//   node bench/server.mjs --port 4800 --dist dist
//
// Routes
//   /kiln-render/...            static files from --dist (unthrottled, models a cached app)
//   /proxy/<host>/<path>        upstream GET via https, cached on disk in bench/cache/,
//                               then served through a shared throttled link
//   /__bench/config  POST       { latencyMs, bytesPerSec }   (0 = unthrottled)
//   /__bench/stats   GET        { requests, hits, misses, bytes, inflight }
//   /__bench/reset   POST       zero the counters
//
// HTTP/2 over TLS (self-signed, bench/certs) so the browser multiplexes like it
// does against a real CDN instead of capping at 6 HTTP/1.1 connections.

import http2 from 'node:http2';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 4800);
const DIST = path.resolve(args.dist ?? path.join(here, '..', 'dist'));
const CACHE = path.resolve(args.cache ?? path.join(here, 'cache'));
const SITE_PREFIX = '/kiln-render/';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain',
};

// ---------------------------------------------------------------------------
// Throttled link shared by every proxied response.
// ---------------------------------------------------------------------------
class Link {
  latencyMs = 0;
  bytesPerSec = 0;
  tokens = 0;
  last = performance.now();
  chunk = 16 * 1024;
  burst = 64 * 1024;

  configure({ latencyMs = 0, bytesPerSec = 0 }) {
    this.latencyMs = latencyMs;
    this.bytesPerSec = bytesPerSec;
    this.tokens = Math.min(this.burst, bytesPerSec);
    this.last = performance.now();
  }

  refill() {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + (this.bytesPerSec * (now - this.last)) / 1000);
    this.last = now;
  }

  async acquire(n) {
    if (this.bytesPerSec <= 0) return;
    for (;;) {
      this.refill();
      if (this.tokens >= n) { this.tokens -= n; return; }
      const waitMs = ((n - this.tokens) / this.bytesPerSec) * 1000;
      await sleep(Math.max(1, waitMs));
    }
  }

  async send(res, body) {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    if (this.bytesPerSec <= 0) { res.end(body); return; }
    for (let off = 0; off < body.length; off += this.chunk) {
      const slice = body.subarray(off, Math.min(off + this.chunk, body.length));
      await this.acquire(slice.length);
      if (res.destroyed) return;
      if (!res.write(slice)) await new Promise(r => res.once('drain', r));
    }
    res.end();
  }
}

const link = new Link();
const stats = { requests: 0, hits: 0, misses: 0, bytes: 0, inflight: 0, upstreamErrors: 0 };
const inflightFetches = new Map(); // cache key → promise (dedupe concurrent misses)

// ---------------------------------------------------------------------------
// Proxy cache
// ---------------------------------------------------------------------------
function cachePaths(host, upstreamPath, range) {
  const safe = upstreamPath.replace(/\.\./g, '_');
  let file = path.join(CACHE, host, safe);
  if (range) file += `.r${range.replace('bytes=', '').replace('-', '_')}`;
  return { body: file, meta: file + '.meta.json' };
}

async function readCached(p) {
  try {
    const meta = JSON.parse(await fsp.readFile(p.meta, 'utf8'));
    const body = meta.status === 404 || meta.status === 403 ? Buffer.alloc(0) : await fsp.readFile(p.body);
    return { meta, body };
  } catch { return null; }
}

async function fetchUpstream(host, upstreamPath, range, p) {
  const url = `https://${host}/${upstreamPath}`;
  const headers = range ? { Range: range } : {};
  const r = await fetch(url, { headers });
  const status = r.status;
  const body = Buffer.from(await r.arrayBuffer());
  const meta = {
    status,
    headers: pick(r.headers, ['content-type', 'content-range', 'content-length', 'accept-ranges', 'last-modified', 'etag', 'cache-control', 'expires']),
  };
  if (status === 200 || status === 206 || status === 404 || status === 403) {
    await fsp.mkdir(path.dirname(p.body), { recursive: true });
    if (status === 200 || status === 206) await fsp.writeFile(p.body, body);
    await fsp.writeFile(p.meta, JSON.stringify(meta));
  } else {
    stats.upstreamErrors++;
  }
  return { meta, body };
}

async function handleProxy(req, res, url) {
  const rest = url.pathname.slice('/proxy/'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return text(res, 400, 'bad proxy path');
  const host = rest.slice(0, slash);
  const upstreamPath = rest.slice(slash + 1);
  const range = req.headers['range'] || null;
  const p = cachePaths(host, upstreamPath, range);

  stats.requests++;
  stats.inflight++;
  try {
    let entry = await readCached(p);
    if (entry) {
      stats.hits++;
    } else {
      stats.misses++;
      const key = p.body;
      let pending = inflightFetches.get(key);
      if (!pending) {
        pending = fetchUpstream(host, upstreamPath, range, p).finally(() => inflightFetches.delete(key));
        inflightFetches.set(key, pending);
      }
      entry = await pending;
    }
    const h = { ...entry.meta.headers, ...cors() };
    delete h['content-length'];
    h['content-length'] = String(entry.body.length);
    // Upstream cache headers are forwarded as-is so Chrome's HTTP cache
    // behaves like it does against the real CDN (heuristic freshness).
    res.writeHead(entry.meta.status, h);
    stats.bytes += entry.body.length;
    await link.send(res, entry.body);
  } catch (e) {
    stats.upstreamErrors++;
    if (!res.headersSent) text(res, 502, `upstream failed: ${e.message}`);
    else res.end();
  } finally {
    stats.inflight--;
  }
}

// ---------------------------------------------------------------------------
// Static app files
// ---------------------------------------------------------------------------
async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname.slice(SITE_PREFIX.length));
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) return text(res, 403, 'forbidden');
  try {
    let st = await fsp.stat(file);
    if (st.isDirectory()) { file = path.join(file, 'index.html'); st = await fsp.stat(file); }
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    text(res, 404, `not found: ${rel}`);
  }
}

// ---------------------------------------------------------------------------
// Control endpoints
// ---------------------------------------------------------------------------
async function handleControl(req, res, url) {
  const op = url.pathname.slice('/__bench/'.length);
  if (op === 'stats') return json(res, { ...stats, link: { latencyMs: link.latencyMs, bytesPerSec: link.bytesPerSec } });
  if (op === 'reset') { Object.assign(stats, { requests: 0, hits: 0, misses: 0, bytes: 0, upstreamErrors: 0 }); return json(res, { ok: true }); }
  if (op === 'config') {
    const body = JSON.parse((await readBody(req)) || '{}');
    link.configure(body);
    return json(res, { ok: true, link: { latencyMs: link.latencyMs, bytesPerSec: link.bytesPerSec } });
  }
  text(res, 404, 'unknown control op');
}

// ---------------------------------------------------------------------------
// --plain: HTTP/1.1 without TLS. Used for direct-to-CDN runs, whose CORS
// allow-list names http://localhost:3000/3001; the app itself is tiny.
const PLAIN = !!args.plain;
const server = PLAIN
  ? http.createServer()
  : http2.createSecureServer({
    key: fs.readFileSync(path.join(here, 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(here, 'certs', 'cert.pem')),
    allowHTTP1: true,
  });

server.on('request', (req, res) => {
  const url = new URL(req.url, `${PLAIN ? 'http' : 'https'}://localhost:${PORT}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors()); return res.end(); }
  if (url.pathname.startsWith('/proxy/')) return void handleProxy(req, res, url);
  if (url.pathname.startsWith('/__bench/')) return void handleControl(req, res, url);
  if (url.pathname.startsWith(SITE_PREFIX)) return void handleStatic(req, res, url);
  text(res, 404, 'not found');
});

server.on('error', e => { console.error('[bench-server]', e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bench-server] ${PLAIN ? 'http' : 'https'}://localhost:${PORT}${SITE_PREFIX}app/  dist=${DIST}  cache=${CACHE}`);
});

// ---------------------------------------------------------------------------
function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'Range, Content-Type',
    'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges',
    'access-control-max-age': '86400',
  };
}
function text(res, status, s) { res.writeHead(status, { 'content-type': 'text/plain', ...cors() }); res.end(s); }
function json(res, obj) { res.writeHead(200, { 'content-type': 'application/json', ...cors() }); res.end(JSON.stringify(obj)); }
function pick(headers, names) { const o = {}; for (const n of names) { const v = headers.get(n); if (v) o[n] = v; } return o; }
function readBody(req) { return new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s)); }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; o[k] = v; }
  }
  return o;
}
