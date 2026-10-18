# FAQ

## Which browsers are supported?

Kiln requires WebGPU. Support as of late 2026 (see the [WebGPU implementation status](https://github.com/gpuweb/gpuweb/wiki/implementation-status) for changes):

- **Chrome / Edge** 113+ on Windows, macOS and ChromeOS; 121+ on Android. On Linux, Chrome 144+ enables it for Intel Gen12+ GPUs and 147+ for NVIDIA on Wayland; other Linux setups need the `--enable-unsafe-webgpu` flag.
- **Safari** 26+ on macOS, iOS, iPadOS and visionOS.
- **Firefox** 141+ on Windows, and on Apple-silicon Macs from 145 (macOS 26) or 147. On Linux and Intel Macs only Nightly has it so far.

Make sure hardware acceleration is enabled in your browser settings.

If WebGPU is unavailable, `KilnViewer.create()` rejects with a descriptive error (e.g. "WebGPU not supported") rather than failing silently — the demo viewer surfaces that message on the page instead of showing a blank canvas.

## Can Kiln read my data?

- **OME-Zarr (NGFF v0.4/v0.5)** — compatible multiscale datasets load directly from a URL or local directory, with no Kiln-specific conversion. Input can be `uint8`, `uint16`, `int16` or `float32` (`float64` is read as `float32`); `uint16` is stored as `r16unorm` where the GPU supports it, otherwise like `int16` and `float32` as `r16float`.
- **Raw volumes** (and other formats) are converted once to Kiln's compressed [sharded binary format](/data/sharded-binary) with the bundled CLI, then streamed the same way.
- Full requirements are in the [Data Guide](/data/ome-zarr).

## Why won't my dataset load from S3 or my own server?

Almost always **CORS**. Kiln fetches data with cross-origin HTTP requests (including Range requests), so the bucket or server must return permissive CORS headers — `Access-Control-Allow-Origin`, and `Access-Control-Allow-Headers: Range` for sharded binary. See [Hosting for streaming](/data/hosting) for the S3/CDN configuration.

## How much VRAM does Kiln use?

Kiln uses a bounded GPU residency/atlas cache — ~1.3 GiB by default and configurable — for volume-residency resources (atlas texture + indirection table); this excludes render targets and other GPU allocations. See [Architecture](/architecture/memory-budget) for the accounting.

## What are the known rendering issues?

LOD transitions can produce brief visual discontinuities while bricks stream in. Brick boundary seams may be faintly visible in isosurface (ISO) mode, where normal estimation samples across brick edges. See [Known Issues](/reference/issues) for the current list.

## Can I use Kiln in my own application?

Yes. Install `kiln-render` from npm and use `KilnViewer.create()` — see the [Quick start](/guide/quick-start). If your app already has a WebGPU device and render loop, use `KilnEngine` instead ([Bring your own device and frame loop](/guide/quick-start#bring-your-own-device-and-frame-loop)). Kiln is Apache 2.0 licensed.
