# Hosting for streaming

Host the [sharded binary](/data/sharded-binary) output directory on any server that supports HTTP Range requests.

## Amazon S3

```bash
aws s3 sync public/datasets/myvolume s3://my-bucket/datasets/myvolume
```

Ensure CORS is configured to allow Range requests from your domain.

## Local development

Vite's dev server supports Range requests out of the box:

```bash
bun run dev
# Volume available at http://localhost:5173/datasets/myvolume/volume.json
```

## CDN

Most CDNs (CloudFront, Cloudflare, etc.) support Range requests without special configuration.

## Complete example (sharded binary)

Converting the Stag Beetle dataset:

```bash
# Download raw volume
curl -O https://example.com/stagbeetle_832x832x494_uint16.raw

# Convert to streaming format
bun scripts/decompose-volume.ts \
  stagbeetle_832x832x494_uint16.raw \
  public/datasets/stagbeetle \
  --bits 16

# Upload to S3
aws s3 sync public/datasets/stagbeetle s3://my-bucket/datasets/stagbeetle
```
