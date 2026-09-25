# Streaming bench

Reproducible A/B measurements of Kiln's streaming pipeline: headless Chromium with a real
WebGPU adapter, driven against a local server that serves a production build and proxies the
datasets through an on-disk cache behind a throttled link. Removes CDN variance from the
comparison; a run's numbers come from `examples/shared/bench.ts` (`?bench=1`).

## One-time setup

```bash
npm install                      # includes playwright
npx playwright install chromium
# self-signed cert for the HTTP/2 server (Chrome must multiplex like against a CDN)
mkdir -p bench/certs && openssl req -x509 -newkey rsa:2048 -nodes -keyout bench/certs/key.pem \
  -out bench/certs/cert.pem -subj "/CN=localhost" -days 3650 \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

The runner trusts the cert by SPKI hash (`--ignore-certificate-errors-spki-list`), not by
ignoring certificate errors, because Chrome refuses to HTTP-cache responses from a connection
it considers broken and that would charge repeat chunk fetches to the network.

## Running

```bash
npm run build && npm run build:multichannel
cp -R dist bench/dists/base            # snapshot: never bench a dist you are rebuilding
node bench/run.mjs --profiles cdn --runs 3 --label mytest \
  --workloads zebrafish,fly,chameleon \
  --variants 'control=@bench/dists/base,exp=flag=1@bench/dists/other'
```

- `--variants name=query[@dist]`: `query` is appended to the page URL (feature flags), `@dist`
  serves that build; variants with different dists get their own server. Runs are interleaved.
- `--profiles cdn|fast|off` (see `workloads.mjs`), `--orbit 35` adds a camera-jump phase.
- The first pass per workload warms the proxy cache unthrottled; `bench/cache/` grows to a few GB.
- Output: `bench/results/<label>/summary.md` plus per-run JSON, PNG and console log.
  `node bench/summarize.mjs bench/results/<label> --baseline control` rebuilds the table with Δ%.

Long runs: `nohup node bench/run.mjs ... > bench/results/<label>.log 2>&1 &`.

## Judging

Compare first content, `ch0 done`, base done and converge at equal wire bytes and identical
converged screenshots. Requests/bytes are diagnostics, not the target.
