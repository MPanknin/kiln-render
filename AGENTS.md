# AGENTS.md

Instructions for coding agents working on Kiln. For humans: [CONTRIBUTING.md](CONTRIBUTING.md). The [architecture docs](docs/architecture/) explain the design.

Kiln is a WebGPU volume renderer that streams OME-Zarr out of core: 64³ bricks, an indirection table, a GPU atlas and a compute-shader ray marcher.

## Commands

Use **bun** only. Never npm, yarn or pnpm, and never add a second lockfile.

```bash
bun install
bunx tsc --noEmit          # type check (CI)
bun run test:run           # unit tests (CI)
bun run test:visual        # visual snapshot tests (real GPU, opens Chromium)
bun run dev                # single-channel viewer
bun run dev:multichannel   # multichannel viewer
bun run dev:site           # docs site
```

## Where things live

- `src/engine.ts`, `src/viewer.ts`: public entry points, options, viewer state
- `src/core/`: renderer, camera, transfer function, indirection, config, feature flags
- `src/streaming/`: brick selection and scheduling, atlas allocator, brick cache
- `src/data/`: Zarr providers, chunk workers, decompression
- `src/shaders/`: WGSL, assembled in `index.ts`; uniform layout in `uniform-layout.ts`
- `examples/`: the basic and multichannel viewers (UI, URL parameters), served at kilnrender.com/app/
- `docs/`: the VitePress site, kilnrender.com
- `docs/diagrams/`: SVG diagrams, referenced as plain Markdown images. The site inlines them (`markdown.config` in `docs/.vitepress/config.ts`) and colours them through the classes in `custom.css`, so use those classes instead of fixed colours. No ASCII-art diagrams
- `test/`: Vitest unit tests

## Principles

- Make the smallest change that works. No speculative abstractions, no drive-by refactors.
- Ask before adding dependencies, bumping versions, or touching release or workflow files.
- One change per PR. Logic changes get tests. Behaviour changes get docs and a CHANGELOG entry under `[Unreleased]`.
- Experimental behaviour goes behind a URL flag (`isFlagEnabled` in `src/core/feature-flags.ts`): off keeps the old behaviour. Once the new behaviour is confirmed, delete the flag. Workers can't read URL flags; read them on the main thread and pass them in the worker message.

## Invariants

- `src/shaders/uniform-layout.ts` is the single source for the WGSL uniform struct and the CPU writes. Append new fields at the end and update `test/uniform-layout.test.ts`.
- `LOGICAL_BRICK_SIZE`, `PHYSICAL_BRICK_SIZE`, `ATLAS_SIZE` and `MAX_BRICK_TRAVERSALS` in `common.wgsl` are replaced by regex in `shaders/index.ts`. Keep their names and declaration form.
- Bricks are 64³ voxels stored as 66³ with a one-voxel border. Every sample, including gradient taps, must stay inside the border.
- Indirection texel `w`: 0 = not loaded, 255 = known empty, otherwise level + 1. The finest loaded level wins.
- The base level is pinned in the atlas; eviction never removes it.

## Adding a render option

A new viewer-facing option touches all of these:

1. `src/shaders/uniform-layout.ts` and its test, plus the WGSL that reads it
2. `src/core/renderer.ts`: default value and uniform write
3. `src/engine.ts`: option and setter, carried over in `rebuildGpu`
4. `src/viewer.ts`: viewer state
5. `examples/*/src/main.ts` (URL parameter, share URL) and the UI control
6. `docs/guide/url-parameters.md`, and the parameter list in the redirect script in `docs/.vitepress/config.ts`
7. `CHANGELOG.md`

## Testing

- Headless Chromium on Linux destroys the WebGPU device on the first frame presented to a canvas. Run Chromium headed, under Xvfb on a machine without a display.
- Visual tests (`test/visual`) render scenes in the basic viewer until they converge and compare the canvases with `test/visual/baselines/<scene>-<platform>.png`. The Visual workflow runs them on the kilnrender GPU runner (NVIDIA T4) and fails on any other adapter; run it by hand with **update** to commit new Linux baselines. `bun run test:visual:update` writes baselines for your own machine.
- Every PR also deploys a preview to `kilnrender.com/preview/<branch>/`; say in the PR what to look at there.
- Performance: compare `?bench=1` with and without the feature flag on the preview.
- `test/ray-iso-feedback.html` and `test/dvr-gradient.html` are manual WebGPU checks that Vitest does not run: serve the repository root with Vite (`configFile: false`, the page in `optimizeDeps.entries`) and open the page. They compile the production compute shader and test the ray-feedback and DVR gradient functions on the GPU.
