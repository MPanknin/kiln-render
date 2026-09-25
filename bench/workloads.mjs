// Bench workloads: the exact views users get from the gallery, plus fixed
// network profiles. `dataset` is the upstream URL; the runner rewrites it to
// go through the caching proxy so every run after warm-up is fully local.

export const PROFILES = {
  // Measured real-world link to the CDN was ~9.6 MB/s; 40 ms RTT.
  cdn: { latencyMs: 40, bytesPerSec: 10 * 1024 * 1024 },
  // Good office/fibre connection.
  fast: { latencyMs: 10, bytesPerSec: 60 * 1024 * 1024 },
  // No throttling — pure client-side cost.
  off: { latencyMs: 0, bytesPerSec: 0 },
};

/** @type {Record<string, {app: 'basic'|'multichannel', dataset: string, query: string, note: string}>} */
export const WORKLOADS = {
  zebrafish: {
    app: 'multichannel',
    dataset: 'https://uk1s3.embassy.ebi.ac.uk/bia-integrator-data/S-BSST410/IM4/IM4.zarr/0',
    query: 'up=-z&mode=mip&scale=0.50&cam=0.740%2C2.700%2C1.489%2C0.003%2C0.039%2C0.037&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.04%3B255%2C255%2C0%2C1.00%2C1%2C0.00%2C0.06%3B255%2C0%2C0%2C1.00%2C1%2C0.00%2C0.01%3B255%2C255%2C255%2C1.00%2C1%2C0.00%2C0.02&slice=256%2C256%2C52%2C1%2C1%2C1',
    note: '512²×103, 4ch uint16, whole-plane 512² chunks, 2 levels (XY-only)',
  },
  yeast: {
    app: 'multichannel',
    dataset: 'https://d39zu0xtgv0613.cloudfront.net/multichannel/4496763.zarr/4496763.zarr',
    query: 'up=-y&mode=slice&scale=0.50&cam=-0.380%2C3.140%2C1.261%2C-0.001%2C0.074%2C0.007&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.04%3B255%2C255%2C0%2C1.00%2C1%2C0.02%2C0.04%3B255%2C0%2C0%2C1.00%2C1%2C0.01%2C0.09%3B255%2C255%2C255%2C1.00%2C1%2C0.01%2C0.05&slice=1024%2C1024%2C13%2C1%2C1%2C1',
    note: '2048²×25, 4ch uint16, whole-plane 2048² chunks, 6 levels (XY-only)',
  },
  'yeast-mip': {
    app: 'multichannel',
    dataset: 'https://d39zu0xtgv0613.cloudfront.net/multichannel/4496763.zarr/4496763.zarr',
    query: 'up=-y&mode=mip&scale=0.50&cam=-0.380%2C3.140%2C1.261%2C-0.001%2C0.074%2C0.007&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.04%3B255%2C255%2C0%2C1.00%2C1%2C0.02%2C0.04%3B255%2C0%2C0%2C1.00%2C1%2C0.01%2C0.09%3B255%2C255%2C255%2C1.00%2C1%2C0.01%2C0.05&slice=1024%2C1024%2C13%2C1%2C1%2C1',
    note: 'same view as yeast but MIP — exercises volume streaming instead of one slice',
  },
  fly: {
    app: 'multichannel',
    dataset: 'https://d39zu0xtgv0613.cloudfront.net/Fly-eFISH/NP01_1_1_SS00790_AstA546_CCHa1_647_1x_LOL.chunked.zarr/',
    query: 'up=-z&mode=mip&scale=0.50&cam=0.390%2C4.230%2C2.087%2C-0.013%2C-0.016%2C0.060&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.41%3B255%2C255%2C0%2C1.00%2C1%2C0.00%2C0.19%3B255%2C0%2C0%2C1.00%2C1%2C0.00%2C0.41%3B255%2C255%2C255%2C1.00%2C1%2C0.00%2C0.11&slice=960%2C960%2C376%2C1%2C1%2C1',
    note: '1920²×752, 4ch uint16, 128³ chunks, 4 levels (XY-only; Z never downsampled)',
  },
  chameleon: {
    app: 'basic',
    dataset: 'https://d39zu0xtgv0613.cloudfront.net/chameleon-16bit',
    query: 'mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C1.497%2C0.108%2C0.001%2C-0.066',
    note: 'control: 1024²×1080 uint16, Kiln sharded binary (Range requests)',
  },
  beechnut: {
    app: 'basic',
    dataset: 'https://d39zu0xtgv0613.cloudfront.net/beechnut.ome.zarr',
    query: 'mode=dvr&wc=0.22&ww=0.14&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=-0.090%2C2.130%2C3.171%2C-0.072%2C-0.025%2C-0.013',
    note: 'control: cubic OME-Zarr, single channel, mixed last level',
  },
};

/** Build the page URL for a workload against a bench server. */
export function workloadUrl(origin, wl, extraQuery = '') {
  const appPath = wl.app === 'multichannel' ? '/kiln-render/app/multichannel/' : '/kiln-render/app/';
  const u = new URL(wl.dataset);
  const proxied = `${origin}/proxy/${u.host}${u.pathname}`;
  const q = new URLSearchParams(wl.query);
  q.set('dataset', proxied);
  let s = q.toString();
  if (extraQuery) s += '&' + extraQuery.replace(/^[?&]/, '');
  return `${origin}${appPath}?${s}`;
}
