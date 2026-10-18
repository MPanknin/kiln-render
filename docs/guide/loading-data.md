# Loading data

## Remote datasets

Pass a URL. Kiln uses the sharded binary format if the URL serves a `volume.json`, OME-Zarr otherwise. See [OME-Zarr](/data/ome-zarr) for what is supported and [Hosting](/data/hosting) for CORS.

```typescript
import { KilnViewer, preValidateRemoteZarr } from 'kiln-render';

const issues = await preValidateRemoteZarr(url); // optional: reasons the dataset can't load, e.g. unsupported dtype
if (issues.length === 0) await KilnViewer.create(canvas, url);
```

## Local directories

Chrome and Edge only (File System Access API):

```typescript
import { KilnViewer, LocalZarrDataProvider, promptForZarrDirectory, preValidateLocalZarr } from 'kiln-render';

const handle = await promptForZarrDirectory(); // throws if the API is unavailable
if ((await preValidateLocalZarr(handle)).length === 0) {
  await KilnViewer.create(canvas, new LocalZarrDataProvider(handle));
}
```

The handle is stored for later visits; see [Local files](/data/local-files) for restoring it and for limitations.

## Multichannel

Datasets with a channel axis are detected automatically. See [Multichannel](/rendering/multichannel) for channel selection, colours and windows.

## Demo viewer

Click **Load** in the top bar to paste a URL or choose a local directory, or open a link directly:

```
https://kilnrender.com/app/?dataset=https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/kingsnake.ome.zarr
```

Opening a local directory replaces the URL with `?local=true`, so the dataset starts from default settings; reloading asks for permission to reopen it.
