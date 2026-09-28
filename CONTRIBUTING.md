# Contributing to Kiln

Thanks for your interest in Kiln! Bug reports, datasets that don't load, documentation fixes and code contributions are all welcome.

## Getting help

- **Questions and usage help:** open a thread in [GitHub Discussions](https://github.com/MPanknin/kiln-render/discussions), or ask on the [image.sc forum](https://forum.image.sc/) and mention Kiln.
- **Documentation:** start with the [Guide](docs/guide/introduction.md); the [FAQ](docs/guide/faq.md) and [Troubleshooting](docs/data/troubleshooting.md) pages cover the most common problems (CORS, unsupported datasets, WebGPU availability).

## Reporting bugs and dataset problems

Please use the [issue templates](https://github.com/MPanknin/kiln-render/issues/new/choose). They ask for the information needed to reproduce a problem:

- **Rendering or viewer bugs:** Kiln version, browser and version, operating system, GPU, and any errors from the browser console.
- **A dataset that won't load:** the rejection message the viewer shows, a URL to the dataset if it's public (or its metadata if not), and how it was written (for example `ome-zarr-py`, `bioformats2raw`, `zarr-python`).

Before reporting a loading problem with a remote dataset, check that the host returns CORS headers; see [Hosting](docs/data/hosting.md).

Security issues should **not** be reported in public issues; see [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 20 or newer (CI runs on Node 20) and a browser with WebGPU enabled to run the viewers.

```bash
git clone https://github.com/MPanknin/kiln-render.git
cd kiln-render
npm install

npm run dev                # single-channel demo viewer
npm run dev:multichannel   # multichannel demo viewer
npm run dev:site           # documentation site (VitePress)
```

### Project layout

| Path | Contents |
|------|----------|
| `src/core/` | Renderer, camera, volume and pyramid model, indirection, transfer functions |
| `src/data/` | Data providers: OME-Zarr (remote and local), sharded binary, fetch and decompression workers |
| `src/streaming/` | Streaming manager, atlas allocator, brick cache |
| `src/shaders/` | WGSL compute and render shaders |
| `src/engine.ts`, `src/viewer.ts` | Headless engine and the `KilnViewer` public API |
| `examples/` | The single-channel and multichannel demo viewers |
| `docs/` | Documentation site sources |
| `scripts/` | Dataset conversion tools |
| `test/` | Unit tests (Vitest) |

## Before opening a pull request

Run the same checks CI runs:

```bash
npx tsc --noEmit     # type check
npm run test:run     # unit tests
```

If your change touches the public API, exports or the library build, also run:

```bash
npm run lint:publish   # builds the library and validates the package shape and types
```

Unit tests don't need a GPU. For changes that affect rendering or streaming, please check the result in a WebGPU browser and include before/after screenshots in the pull request.

### Pull request guidelines

- Keep pull requests focused on one change. For larger features or refactors, open an issue or discussion first so we can agree on the approach.
- Add or update tests for logic changes (`test/*.test.ts`).
- Update the docs when behavior, options or supported formats change.
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md).
- Commit messages follow the existing prefix style: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `ci:`, `chore:`.

## License

Kiln is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution, you agree that it is licensed under the same terms, as described in section 5 of the license. There is no separate contributor license agreement.

## Code of conduct

Everyone participating in this project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
