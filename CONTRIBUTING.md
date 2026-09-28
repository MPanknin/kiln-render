# Contributing to Kiln

Thanks for your interest in Kiln! Bug reports, datasets that don't load, docs fixes and pull requests are all welcome.

- **Questions:** [GitHub Discussions](https://github.com/MPanknin/kiln-render/discussions)
- **Bugs and datasets that don't load:** [open an issue](https://github.com/MPanknin/kiln-render/issues/new/choose)
- **Security issues:** please report them privately, see [SECURITY.md](SECURITY.md)

## Development

You need Node.js 20 or newer and a browser with WebGPU.

```bash
npm install
npm run dev                # single-channel viewer
npm run dev:multichannel   # multichannel viewer
npm run dev:site           # documentation site
```

The [architecture docs](https://kilnrender.com/architecture/overview.html) explain how the pieces fit together.

Before opening a pull request, run the checks CI runs:

```bash
npx tsc --noEmit
npm run test:run
```

## Pull requests

- Keep each pull request to one change. For larger changes, open an issue first so we can agree on the approach.
- Add tests for logic changes, and update the docs when behavior or options change.
- For rendering changes, include before/after screenshots.

## License

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
