# Security Policy

## Supported versions

Security fixes are released for the latest minor version of the `kiln-render` package and deployed to the hosted viewer at [kilnrender.com](https://kilnrender.com).

| Version | Supported |
|---------|-----------|
| 0.4.x   | Yes       |
| < 0.4   | No        |

## Reporting a vulnerability

Please **do not** report security issues in public GitHub issues or discussions.

Report them privately through GitHub's [private vulnerability reporting](https://github.com/MPanknin/kiln-render/security/advisories/new). Include a description of the issue, steps or a dataset to reproduce it, and the affected version.

You can expect an acknowledgement within a week. Once a fix is available, it will be released and the advisory published, with credit to the reporter unless you prefer otherwise.

## Scope

Kiln runs entirely in the browser and loads data from URLs or local directories chosen by the user or supplied through viewer URL parameters. Issues of particular interest include:

- script injection through URL parameters or dataset metadata (for example channel names or other strings shown in the UI)
- crafted dataset metadata or chunk data that causes the viewer to hang, exhaust memory, or read outside expected bounds
- a dataset or URL parameter causing network requests the user didn't intend

Out of scope:

- CORS or access-control configuration of third-party data hosts
- bugs in browsers' WebGPU implementations or GPU drivers (please report those to the browser vendor)
