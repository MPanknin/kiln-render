# Local files

Local `.zarr` or `.ome.zarr` directories open without a server through the File System Access API, in Chrome and Edge only.

```typescript
import { KilnViewer, LocalZarrDataProvider, promptForZarrDirectory, preValidateLocalZarr } from 'kiln-render';

const handle = await promptForZarrDirectory(); // also stores the handle in IndexedDB
const issues = await preValidateLocalZarr(handle); // optional
const viewer = await KilnViewer.create(canvas, new LocalZarrDataProvider(handle));
```

On a later visit, reuse the stored handle:

```typescript
import { getStoredHandle, requestPermission, clearHandle } from 'kiln-render';

const handle = await getStoredHandle();
if (handle && await requestPermission(handle)) {
  const viewer = await KilnViewer.create(canvas, new LocalZarrDataProvider(handle));
}
await clearHandle(); // forget it
```

## Differences from HTTP

- Chunk reads and brick assembly run on the main thread, not in the worker pool.
- Each chunk file is read whole.
- Sharded Zarr v3 stores can't be read yet: reading a chunk out of a shard needs partial reads. Serve them over HTTP instead.
