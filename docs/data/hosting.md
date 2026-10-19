# Hosting

Any static host works. Two requirements:

- **CORS:** allow your viewer's origin (`Access-Control-Allow-Origin`) and the `Range` header.
- **Range requests:** needed for the sharded binary format and sharded Zarr v3. S3, CloudFront, Cloudflare and Vite's dev server support them without configuration.

## S3

```bash
aws s3 sync public/datasets/myvolume s3://my-bucket/datasets/myvolume
```

Then add a CORS rule to the bucket that allows `GET` and `HEAD`, the `Range` header and your origin.

## Local development

`bun run dev` serves the repository's `public/` folder under the viewer's base path:

```
http://localhost:3000/kiln-render/app/?dataset=http://localhost:3000/kiln-render/app/datasets/myvolume
```

## Example: raw volume to S3

```bash
bun scripts/decompose-volume.ts stagbeetle_832x832x494_uint16.raw public/datasets/stagbeetle --bits 16
aws s3 sync public/datasets/stagbeetle s3://my-bucket/datasets/stagbeetle
```
