/**
 * Compatibility sweep: runs the viewer's own dataset checks (metadata parsing,
 * validation, pyramid fallback, level limit) against public OME-Zarr datasets
 * and reports how many open and why the rest don't. Nothing is rendered; one
 * chunk per dataset is fetched and decoded to check the codec.
 *
 *   bun scripts/compat-sweep/sweep.ts [--per-list 15] [--out sweep-out] [--list urls.txt]
 *
 * Sources: the OME-NGFF Challenge 2024 sample lists, the IDR OME-NGFF samples
 * table, the OME-Zarr Open SciVis collection and the Kiln gallery. Up to
 * --per-list datasets are sampled evenly from each list. --list checks only the
 * URLs in a file instead. CI: .github/workflows/compat-sweep.yml.
 */
import { plugin } from 'bun';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open, root, registry } from 'zarrita';
import blosc from 'numcodecs/blosc';
import lz4 from 'numcodecs/lz4';
import zstd from 'numcodecs/zstd';

// The Zarr provider imports its chunk worker through Vite (`?worker&inline`);
// under bun that import resolves to a stub that only answers setup messages.
plugin({
  name: 'kiln-stub-worker',
  setup(build) {
    build.onResolve({ filter: /\?worker/ }, () => ({ path: new URL('./stub-worker.js', import.meta.url).pathname }));
  },
});
const src = (path: string) => new URL(`../../src/${path}`, import.meta.url).href;
const { ZarrDataProvider } = await import(src('data/zarr-provider.ts'));
const { UnsupportedDatasetError } = await import(src('data/data-provider.ts'));
const { isNativePyramidRejection } = await import(src('data/pyramid-fallback.ts'));
const { LEGACY_HINT } = await import(src('data/base-zarr-provider.ts'));
const { TolerantFetchStore } = await import(src('data/tolerant-fetch-store.ts'));
const { MAX_LOD_LEVELS } = await import(src('shaders/uniform-layout.ts'));

// Same codec registrations as the chunk worker (zarr-chunk-worker.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
registry.set('blosc', async () => blosc as any);
registry.set('lz4', async () => lz4 as any);
registry.set('zstd', async () => zstd as any);

// Kiln logs per dataset (ranges, fallbacks, version warnings); keep CI output to one line per dataset.
const quiet = (fn: (...a: unknown[]) => void) => (...a: unknown[]) => {
  const first = String(a[0] ?? '');
  if (first.startsWith('[Kiln]') || first.startsWith('[ZarrWorker]') || first.startsWith('Failed to load brick')) return;
  fn(...a);
};
console.log = quiet(console.log.bind(console));
console.warn = quiet(console.warn.bind(console));

const ORIGIN = 'https://kilnrender.com';
const FETCH_TIMEOUT_MS = 20_000;
const DATASET_TIMEOUT_MS = 120_000;
const CONCURRENCY = 8;
const CHALLENGE_INDEX = 'https://raw.githubusercontent.com/ome/ome2024-ngff-challenge/main/samples/ngff_samples.csv';
const IDR_SAMPLES = 'https://raw.githubusercontent.com/IDR/ome-ngff-samples/main/_data/table.csv';
const OPEN_SCIVIS = 'https://raw.githubusercontent.com/InsightSoftwareConsortium/OMEZarrOpenSciVisDatasets/main/README.md';
const GALLERY = new URL('../../docs/.vitepress/theme/gallery-data.ts', import.meta.url);

type Json = Record<string, any>;
interface Dataset { source: string; url: string }

// ─── Dataset catalog ────────────────────────────────────────────────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

/** Up to n items, evenly spaced, so a large list contributes a spread rather than its first rows. */
function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]!);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}

const baseName = (url: string) => url.split('/').pop()!.replace(/\.csv$/, '');

/** A sample list is either an index of further lists (rows ending in .csv) or a list of datasets. */
async function loadList(url: string, label: string, perList: number, depth = 0): Promise<Dataset[]> {
  if (depth > 3) return [];
  let rows: string[][];
  try { rows = parseCsv(await fetchText(url)); } catch (e) {
    process.stderr.write(`skipping list ${url}: ${(e as Error).message}\n`);
    return [];
  }
  if (rows.length === 0) return [];
  const header = rows[0]!.map(h => h.trim().toLowerCase());
  const headerless = header[0]!.startsWith('http');
  const urlIdx = headerless ? 0 : ['url', 'file path'].map(h => header.indexOf(h)).find(i => i >= 0) ?? -1;
  if (urlIdx < 0) return [];
  const srcIdx = headerless ? -1 : header.indexOf('source');
  const body = headerless ? rows : rows.slice(1);

  const datasets: Dataset[] = [];
  const nested: Promise<Dataset[]>[] = [];
  for (const row of body) {
    const u = row[urlIdx]?.trim();
    if (!u?.startsWith('http')) continue;
    const name = srcIdx >= 0 && row[srcIdx]?.trim() ? row[srcIdx]!.trim() : label;
    if (u.endsWith('.csv')) nested.push(loadList(u, depth === 0 ? name : `${label} · ${baseName(u)}`, perList, depth + 1));
    else datasets.push({ source: label, url: u });
  }
  return [...sample(datasets, perList), ...(await Promise.all(nested)).flat()];
}

async function openSciVis(perList: number): Promise<Dataset[]> {
  try {
    const readme = await fetchText(OPEN_SCIVIS);
    const urls = [...readme.matchAll(/\*\*Dataset HTTPS URL:\*\*\s*(\S+)/g)].map(m => m[1]!);
    return sample(urls.map(url => ({ source: 'OME-Zarr Open SciVis', url })), perList);
  } catch { return []; }
}

function gallery(): Dataset[] {
  const lines = readFileSync(GALLERY, 'utf8').split('\n').filter(l => !l.trim().startsWith('//'));
  const urls = lines.flatMap(l => [...l.matchAll(/dataset=([^&'"]+)/g)].map(m => decodeURIComponent(m[1]!)));
  return [...new Set(urls)].map(url => ({ source: 'Kiln gallery', url }));
}

/** Trailing slashes stripped (as the viewer does), duplicates across lists dropped. */
function dedupe(datasets: Dataset[]): Dataset[] {
  const seen = new Set<string>();
  return datasets
    .map(d => ({ ...d, url: d.url.replace(/\/+$/, '') }))
    .filter(d => !seen.has(d.url) && (seen.add(d.url), true));
}

async function catalog(perList: number): Promise<Dataset[]> {
  const parts = await Promise.all([
    loadList(CHALLENGE_INDEX, 'NGFF Challenge', perList),
    loadList(IDR_SAMPLES, 'IDR OME-NGFF samples', perList),
    openSciVis(perList),
  ]);
  return dedupe([...gallery(), ...parts.flat()]);
}

// ─── Structural probe (raw metadata, independent of Kiln) ──────────────────

interface Fetched { json: Json | null; status: number; acao: string | null }

async function getJson(url: string): Promise<Fetched> {
  try {
    const res = await fetch(url, { headers: { Origin: ORIGIN }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const acao = res.headers.get('access-control-allow-origin');
    if (!res.ok) return { json: null, status: res.status, acao };
    try { return { json: JSON.parse(await res.text()), status: res.status, acao }; } catch { return { json: null, status: -2, acao }; }
  } catch { return { json: null, status: -1, acao: null }; }
}

interface Group { format: 2 | 3; attrs: Json; acao: string | null }

async function readGroup(base: string): Promise<Group | { status: number }> {
  const v3 = await getJson(`${base}/zarr.json`);
  if (v3.json?.node_type === 'group') return { format: 3, attrs: v3.json.attributes ?? {}, acao: v3.acao };
  const v2 = await getJson(`${base}/.zattrs`);
  if (v2.json) return { format: 2, attrs: v2.json, acao: v2.acao };
  return { status: [v3.status, v2.status].find(s => s !== 404) ?? 404 };
}

async function firstField(url: string, attrs: Json): Promise<string | undefined> {
  let wellUrl = url;
  let wellAttrs: Json = attrs;
  const wellPath = (attrs.plate ?? attrs.ome?.plate)?.wells?.[0]?.path;
  if (wellPath) {
    const well = await readGroup(`${url}/${wellPath}`);
    if ('status' in well) return undefined;
    wellUrl = `${url}/${wellPath}`;
    wellAttrs = well.attrs;
  }
  const image = (wellAttrs.well ?? wellAttrs.ome?.well)?.images?.[0]?.path;
  return image === undefined ? undefined : `${wellUrl}/${image}`;
}

const multiscalesOf = (attrs: Json): Json | undefined => (attrs.ome?.multiscales ?? attrs.multiscales)?.[0];

function dtypeName(raw: string): string {
  const m = /^[<>|=]?([uifb])(\d+)$/.exec(raw);
  if (!m) return raw;
  const bits = Number(m[2]) * 8;
  return { u: `uint${bits}`, i: `int${bits}`, f: `float${bits}`, b: 'bool' }[m[1] as 'u' | 'i' | 'f' | 'b'];
}
const BYTES: Record<string, number> = { uint8: 1, int8: 1, bool: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, uint64: 8, int64: 8, float64: 8 };

interface Probe {
  reachable: boolean;
  status?: number;
  zarrFormat?: 2 | 3;
  version?: string;
  plate: boolean;
  /** First field image of a plate or well, checked separately: would opening a field be enough? */
  plateField?: string;
  imagePrefix: string;
  axes: string[];
  shape?: number[];
  chunks?: number[];
  shards?: number[];
  dtype?: string;
  codecs?: string;
  levels: number;
  levelPaths: string[];
  labels: boolean;
  omero: boolean;
  cors: 'ok' | 'missing' | 'unknown';
}

async function probe(url: string): Promise<Probe> {
  const out: Probe = { reachable: false, plate: false, imagePrefix: '', axes: [], levels: 0, levelPaths: [], labels: false, omero: false, cors: 'unknown' };
  const rootGroup = await readGroup(url);
  if ('status' in rootGroup) return { ...out, status: rootGroup.status };
  out.reachable = true;
  out.zarrFormat = rootGroup.format;
  out.cors = rootGroup.acao === '*' || rootGroup.acao === ORIGIN ? 'ok' : 'missing';
  const attrs = rootGroup.attrs;
  out.plate = Boolean(attrs.plate ?? attrs.ome?.plate ?? attrs.well ?? attrs.ome?.well);
  if (out.plate) out.plateField = await firstField(url, attrs);

  // Same lookup order as the viewer: root multiscales, else the bioformats2raw image "0".
  let imageAttrs = attrs;
  let ms = multiscalesOf(attrs);
  if (!ms && !out.plate) {
    const sub = await readGroup(`${url}/0`);
    if (!('status' in sub) && multiscalesOf(sub.attrs)) { imageAttrs = sub.attrs; ms = multiscalesOf(sub.attrs); out.imagePrefix = '0/'; }
  }
  if (!ms) return out;

  out.version = String(imageAttrs.ome?.version ?? ms.version ?? '');
  out.omero = Boolean(imageAttrs.omero ?? imageAttrs.ome?.omero);
  out.levelPaths = (ms.datasets ?? []).map((d: Json) => String(d.path));
  out.levels = out.levelPaths.length;
  const img = `${url}/${out.imagePrefix}`.replace(/\/$/, '');

  const arrayKey = rootGroup.format === 3 ? 'zarr.json' : '.zarray';
  const [arr, labels] = await Promise.all([
    out.levelPaths[0] !== undefined ? getJson(`${img}/${out.levelPaths[0]}/${arrayKey}`) : Promise.resolve(null),
    getJson(`${img}/labels/${rootGroup.format === 3 ? 'zarr.json' : '.zattrs'}`),
  ]);
  out.labels = Boolean(labels.json);
  const a = arr?.json;
  if (a) {
    out.shape = a.shape;
    if (rootGroup.format === 3) {
      out.dtype = String(a.data_type);
      const grid = a.chunk_grid?.configuration?.chunk_shape as number[] | undefined;
      const codecs = (a.codecs ?? []) as Json[];
      const shard = codecs.find(c => c.name === 'sharding_indexed');
      if (shard) {
        out.shards = grid;
        out.chunks = shard.configuration?.chunk_shape;
        out.codecs = ['sharding', ...((shard.configuration?.codecs ?? []) as Json[]).map(c => c.name)].join('+');
      } else {
        out.chunks = grid;
        out.codecs = codecs.map(c => c.name).join('+');
      }
    } else {
      out.dtype = dtypeName(String(a.dtype));
      out.chunks = a.chunks;
      out.codecs = [a.compressor?.cname ? `${a.compressor.id}/${a.compressor.cname}` : (a.compressor?.id ?? 'none'), ...((a.filters ?? []) as Json[]).map(f => f.id)].join('+');
    }
  }
  const raw = ms.axes as unknown[] | undefined;
  out.axes = raw?.length
    ? raw.map(ax => (typeof ax === 'string' ? ax : String((ax as Json).name ?? '')).toLowerCase())
    : (out.shape?.length === 5 ? ['t', 'c', 'z', 'y', 'x'] : ['z', 'y', 'x'].slice(-(out.shape?.length ?? 3)));
  return out;
}

// ─── Kiln's verdict (the viewer's own code) ─────────────────────────────────

interface KilnResult {
  ok: boolean;
  reasons: string[];
  error?: string;
  pyramid?: 'native' | 'legacy';
  fallback?: string;
  chunksPerBrick?: number;
  channels?: number;
  dims?: [number, number, number];
}

/** Mirrors the engine: initializeWithPyramidFallback (unrolled to keep the fallback reason) and the level limit. */
async function kilnCheck(url: string): Promise<KilnResult> {
  const provider = new ZarrDataProvider(url);
  try {
    let pyramid: 'native' | 'legacy' = 'native';
    let fallback: string | undefined;
    provider.setPyramidPolicy('native');
    let metadata;
    try {
      metadata = await provider.initialize();
    } catch (e) {
      if (!isNativePyramidRejection(e)) throw e;
      fallback = (e as { reasons: string[] }).reasons.filter(r => r !== LEGACY_HINT).join('; ');
      pyramid = 'legacy';
      provider.setPyramidPolicy('legacy');
      metadata = await provider.initialize();
    }
    if (metadata.levels.length > MAX_LOD_LEVELS) {
      return { ok: false, reasons: [`${metadata.levels.length} pyramid levels exceed the supported ${MAX_LOD_LEVELS}`] };
    }
    const finest = metadata.levels.find((l: { lod: number }) => l.lod === 0);
    const [gx, gy, gz] = finest?.brickGrid ?? [1, 1, 1];
    return {
      ok: true, reasons: [], pyramid, fallback,
      chunksPerBrick: provider.estimateBrickCost(0, gx >> 1, gy >> 1, gz >> 1),
      channels: metadata.numChannels, dims: metadata.dimensions,
    };
  } catch (e) {
    if (e instanceof UnsupportedDatasetError) return { ok: false, reasons: e.reasons.filter((r: string) => r !== LEGACY_HINT) };
    return { ok: false, reasons: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    provider.dispose();
  }
}

/** Fetch and decode the centre chunk of the coarsest level, as a worker would. */
async function decodeCheck(url: string, p: Probe): Promise<'ok' | 'missing-chunk' | string> {
  try {
    const store = new TolerantFetchStore(url);
    const path = `${p.imagePrefix}${p.levelPaths[p.levelPaths.length - 1]}`;
    const arr = await open(root(store).resolve(path), { kind: 'array' });
    const coords = arr.shape.map((s, i) => Math.floor((Math.ceil(s / arr.chunks[i]!) - 1) / 2));
    const before = store.bytesFetched;
    await arr.getChunk(coords);
    return store.bytesFetched > before ? 'ok' : 'missing-chunk';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ─── Classification ─────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<string, string> = {
  'opens': 'Opens',
  'unreachable': 'Metadata unreachable (404, 403 or network)',
  'hcs-plate': 'HCS plate or well, not a single image',
  'not-ome-ngff': 'No OME-NGFF multiscales metadata',
  'dtype': 'Unsupported data type',
  'axes': 'Unsupported axes or dimensions',
  'pyramid': 'Pyramid levels not supported',
  'no-cors': 'Host sends no CORS header (browser blocks it)',
  'decode': 'Chunk fails to decode',
  'url-not-zarr': 'URL without ".zarr" (viewer treats it as sharded binary)',
  'error': 'Other error',
};

interface Result extends Dataset {
  category: string;
  detail: string;
  caveats: string[];
  probe: Probe;
  kiln?: KilnResult;
  decode?: string;
  /** For plates: does the first field open on its own? */
  fieldOpens?: boolean;
  ms: number;
}

function axisSize(p: Probe, name: string): number {
  const i = p.axes.indexOf(name);
  return i >= 0 && p.shape ? p.shape[i] ?? 1 : 1;
}

function classify(d: Dataset, p: Probe, k: KilnResult | undefined, decode: string | undefined): { category: string; detail: string; caveats: string[] } {
  if (!p.reachable) return { category: 'unreachable', detail: `HTTP ${p.status === -1 ? 'network error' : p.status}`, caveats: [] };
  if (p.plate) return { category: 'hcs-plate', detail: p.plateField ? `first field: ${p.plateField}` : 'plate/well metadata at the root', caveats: [] };
  if (k && !k.ok) {
    const text = [...k.reasons, k.error].filter(Boolean).join('; ');
    const category = /multiscales/i.test(text) ? 'not-ome-ngff'
      : /data type/i.test(text) ? 'dtype'
        : /axes|axis|dimension|spatial/i.test(text) ? 'axes'
          : /level|pyramid|scale|factor/i.test(text) ? 'pyramid'
            : 'error';
    return { category, detail: text, caveats: [] };
  }
  if (p.cors === 'missing') return { category: 'no-cors', detail: 'no Access-Control-Allow-Origin', caveats: [] };
  if (decode && decode !== 'ok' && decode !== 'missing-chunk') return { category: 'decode', detail: decode, caveats: [] };
  if (!d.url.includes('.zarr')) return { category: 'url-not-zarr', detail: 'opens once the URL is treated as Zarr', caveats: [] };

  const caveats: string[] = [];
  if (axisSize(p, 't') > 1) caveats.push('time series (first timepoint only)');
  if ((k?.channels ?? 1) > 4 || axisSize(p, 'c') > 4) caveats.push('more than 4 channels (first 4 shown)');
  if (k?.pyramid === 'legacy') caveats.push('legacy pyramid fallback');
  if ((k?.dims?.[2] ?? 2) <= 1) caveats.push('2D (single z-slice)');
  if ((k?.chunksPerBrick ?? 0) > 32) caveats.push('thin chunks (>32 chunks per brick)');
  if (p.labels) caveats.push('labels not shown');
  return { category: 'opens', detail: '', caveats };
}

async function check(d: Dataset): Promise<Result> {
  const t0 = performance.now();
  const p = await probe(d.url);
  let k: KilnResult | undefined;
  let decode: string | undefined;
  if (p.reachable && !p.plate) {
    k = await kilnCheck(d.url);
    if (k.ok && p.levelPaths.length > 0) decode = await decodeCheck(d.url, p);
  }
  const fieldOpens = p.plate && p.plateField ? (await kilnCheck(p.plateField)).ok : undefined;
  return { ...d, ...classify(d, p, k, decode), probe: p, kiln: k, decode, fieldOpens, ms: Math.round(performance.now() - t0) };
}

function withTimeout(d: Dataset, ms: number): Promise<Result> {
  const empty: Probe = { reachable: false, plate: false, imagePrefix: '', axes: [], levels: 0, levelPaths: [], labels: false, omero: false, cors: 'unknown' };
  return Promise.race([
    check(d).catch(e => ({ ...d, category: 'error', detail: e instanceof Error ? e.message : String(e), caveats: [], probe: empty, ms: 0 })),
    new Promise<Result>(r => setTimeout(() => r({ ...d, category: 'error', detail: `timed out after ${ms / 1000} s`, caveats: [], probe: empty, ms }), ms)),
  ]);
}

// ─── Report ─────────────────────────────────────────────────────────────────

const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : '–');

function countBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of items) { const k = key(it); m.set(k, [...(m.get(k) ?? []), it]); }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

function sizeOf(r: Result): number | undefined {
  const { shape, dtype } = r.probe;
  if (!shape || !dtype || !BYTES[dtype]) return undefined;
  return shape.reduce((a, b) => a * b, 1) * BYTES[dtype]!;
}

/** Counts per bucket in bucket order (small to large), skipping empty buckets. */
function bucketRows<T>(items: T[], value: (t: T) => number | undefined, edges: [number, string][]): (string | number)[][] {
  const labels = [...edges.map(e => e[1]), 'unknown'];
  const counts = new Map(labels.map(l => [l, 0]));
  for (const it of items) { const b = bucket(value(it), edges); counts.set(b, counts.get(b)! + 1); }
  return labels.filter(l => counts.get(l)! > 0).map(l => [l, counts.get(l)!]);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function bucket(n: number | undefined, edges: [number, string][], fallback = 'unknown'): string {
  if (n === undefined) return fallback;
  for (const [max, label] of edges) if (n <= max) return label;
  return edges[edges.length - 1]![1];
}

function report(results: Result[], perList: number, commit: string): string {
  const opens = results.filter(r => r.category === 'opens');
  const withCaveats = opens.filter(r => r.caveats.length > 0);
  const failing = results.filter(r => r.category !== 'opens');
  const readable = results.filter(r => r.probe.shape);
  const L: string[] = [];
  const table = (head: string[], rows: (string | number)[][]) => {
    L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`), '');
  };
  const opensShare = (rs: Result[]) => `${rs.filter(r => r.category === 'opens').length} (${pct(rs.filter(r => r.category === 'opens').length, rs.length)})`;

  L.push('# Kiln compatibility sweep', '');
  L.push(`${new Date().toISOString().slice(0, 10)} · Kiln ${commit} · ${plural(results.length, 'dataset')} from ${plural(new Set(results.map(r => r.source)).size, 'list')} (up to ${perList} per list)`, '');
  L.push(`**${opens.length} of ${results.length} open (${pct(opens.length, results.length)}).** ${withCaveats.length} of them with caveats.`, '');

  L.push('## Why the rest don\'t open', '');
  table(['Reason', 'Datasets', 'Share of all', 'Example'],
    countBy(failing, r => r.category).map(([c, rs]) => [CATEGORY_LABEL[c] ?? c, rs.length, pct(rs.length, results.length), `${rs[0]!.url}<br>${rs[0]!.detail.slice(0, 120)}`]));

  const plates = results.filter(r => r.category === 'hcs-plate');
  if (plates.length) {
    const fields = plates.filter(r => r.fieldOpens).length;
    L.push(`HCS plates: the first field of ${fields} of ${plural(plates.length, 'plate')} opens in Kiln on its own (${pct(fields, plates.length)}).`, '');
  }

  L.push('## Caveats among datasets that open', '');
  table(['Caveat', 'Datasets', 'Share of opening'],
    countBy(withCaveats.flatMap(r => r.caveats.map(c => ({ c }))), x => x.c).map(([c, xs]) => [c, xs.length, pct(xs.length, opens.length)]));

  L.push('## What the data looks like', '', `From the ${readable.length} datasets whose level-0 metadata could be read.`, '');
  table(['Data type', 'Datasets', 'Open'], countBy(readable, r => r.probe.dtype ?? 'unknown').map(([k, rs]) => [k, rs.length, opensShare(rs)]));
  table(['OME-NGFF version', 'Datasets', 'Open'], countBy(readable, r => r.probe.version || 'unknown').map(([k, rs]) => [k, rs.length, opensShare(rs)]));
  const cpb = results.filter(r => r.kiln?.chunksPerBrick !== undefined);
  table(['Chunks per brick (level 0)', 'Datasets'],
    bucketRows(cpb, r => r.kiln!.chunksPerBrick, [[8, '1–8'], [32, '9–32'], [128, '33–128'], [Infinity, 'over 128']]));
  table(['Z extent (level 0)', 'Datasets'],
    bucketRows(readable, r => axisSize(r.probe, 'z'), [[1, '1 (2D)'], [63, '2–63'], [511, '64–511'], [Infinity, '512+']]));
  table(['Size of level 0 (uncompressed)', 'Datasets'],
    bucketRows(readable, sizeOf, [[1e8, 'under 100 MB'], [1e9, '100 MB – 1 GB'], [1e10, '1–10 GB'], [Infinity, 'over 10 GB']]));
  table(['Storage', 'Datasets'], countBy(readable, r => (r.probe.shards ? 'sharded (Zarr v3)' : `unsharded (Zarr v${r.probe.zarrFormat})`)).map(([k, rs]) => [k, rs.length]));
  table(['Codecs', 'Datasets'], countBy(readable, r => r.probe.codecs ?? 'unknown').slice(0, 8).map(([k, rs]) => [k, rs.length]));

  L.push('## By source', '');
  table(['Source', 'Sampled', 'Open', 'Main blocker'],
    countBy(results, r => r.source).sort((a, b) => a[0].localeCompare(b[0])).map(([s, rs]) => {
      const top = countBy(rs.filter(r => r.category !== 'opens'), r => r.category)[0];
      return [s, rs.length, opensShare(rs), top ? `${CATEGORY_LABEL[top[0]] ?? top[0]} (${top[1].length})` : '–'];
    }));
  L.push('Per-dataset details: `results.csv`.', '');
  return L.join('\n');
}

const csvCell = (v: unknown) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function toCsv(results: Result[]): string {
  const head = ['source', 'url', 'category', 'detail', 'caveats', 'version', 'zarr_format', 'dtype', 'axes', 'shape', 'chunks', 'shards', 'codecs',
    'levels', 'pyramid', 'pyramid_fallback', 'chunks_per_brick', 'labels', 'omero', 'cors', 'decode', 'plate_field_opens', 'ms'];
  const rows = results.map(r => [r.source, r.url, r.category, r.detail, r.caveats.join('; '), r.probe.version, r.probe.zarrFormat, r.probe.dtype,
    r.probe.axes.join(''), r.probe.shape?.join('x'), r.probe.chunks?.join('x'), r.probe.shards?.join('x'), r.probe.codecs, r.probe.levels,
    r.kiln?.pyramid, r.kiln?.fallback, r.kiln?.chunksPerBrick, r.probe.labels, r.probe.omero, r.probe.cors, r.decode, r.fieldOpens, r.ms]);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

// ─── Main ───────────────────────────────────────────────────────────────────

const argv = Bun.argv.slice(2);
const arg = (name: string, fallback: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback; };
const perList = Number(arg('per-list', '15'));
const outDir = arg('out', 'sweep-out');
const listFile = arg('list', '');
const commit = process.env.GITHUB_SHA?.slice(0, 7) ?? 'local';

const datasets: Dataset[] = listFile
  ? dedupe(readFileSync(listFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(url => ({ source: 'list', url })))
  : await catalog(perList);
process.stdout.write(`Checking ${datasets.length} datasets…\n`);

const results: Result[] = new Array(datasets.length);
let next = 0, done = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < datasets.length) {
    const i = next++;
    const r = await withTimeout(datasets[i]!, DATASET_TIMEOUT_MS);
    results[i] = r;
    process.stdout.write(`[${++done}/${datasets.length}] ${r.category.padEnd(12)} ${r.url}${r.detail ? ` — ${r.detail.slice(0, 100)}` : ''}\n`);
  }
}));

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/REPORT.md`, report(results, perList, commit));
writeFileSync(`${outDir}/results.csv`, toCsv(results));
const opened = results.filter(r => r.category === 'opens').length;
process.stdout.write(`\n${opened} of ${results.length} open (${pct(opened, results.length)}). Report: ${outDir}/REPORT.md\n`);
process.exit(0);
