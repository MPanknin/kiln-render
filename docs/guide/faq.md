# FAQ

## Which browsers are supported?

Any with WebGPU and hardware acceleration enabled. As of late 2026 ([current status](https://github.com/gpuweb/gpuweb/wiki/implementation-status)):

- **Chrome / Edge** 113+ on Windows, macOS and ChromeOS; 121+ on Android. On Linux, 144+ for Intel Gen12+ GPUs and 147+ for NVIDIA on Wayland; other setups need `--enable-unsafe-webgpu`.
- **Safari** 26+ on macOS, iOS, iPadOS and visionOS.
- **Firefox** 141+ on Windows; on Apple-silicon Macs 145+ (macOS 26) or 147+. Linux and Intel Macs: Nightly only.

Without WebGPU, `KilnViewer.create()` rejects with an error, which the demo shows on the page.

## Can Kiln read my data?

- **OME-Zarr** (NGFF v0.4/v0.5) loads directly from a URL or local directory: `uint8`, `uint16`, `int16`, `float32` (`float64` is read as `float32`). See [OME-Zarr](/data/ome-zarr).
- **Raw volumes** are converted once to the [sharded binary format](/data/sharded-binary) with the bundled CLI.

## Why won't my dataset load from S3 or my own server?

Almost always CORS. The server must send `Access-Control-Allow-Origin` for your site, and allow the `Range` header for sharded binary and sharded Zarr. See [Hosting](/data/hosting).

## Why are there 404s in the browser console?

Kiln looks for metadata that may not exist: the other Zarr version's root document, and the `labels` group, which most datasets don't have. A missing document is a normal answer, but the browser still logs the 404. They don't affect loading.

## TypeScript 7 reports duplicate WebGPU identifiers

TypeScript 7 includes the WebGPU types in its DOM library, and Kiln's types also load `@webgpu/types`. Set `skipLibCheck: true` in your `tsconfig.json` until a later Kiln release drops the bundled copy.

## How much VRAM does Kiln use?

The atlas and indirection table stay within a fixed budget, ~1.3 GiB by default (`atlasBudgetBytes`), whatever the dataset size. Render targets come on top. See [Memory budget](/architecture/memory-budget).

## What are the known rendering issues?

See [Known issues](/reference/issues).

## Can I use Kiln in my own application?

Yes, it's on npm under Apache 2.0. Use `KilnViewer` ([Quick start](/guide/quick-start)), or `KilnEngine` if your app already has a WebGPU device and render loop ([Bring your own device](/guide/quick-start#bring-your-own-device-and-frame-loop)).
