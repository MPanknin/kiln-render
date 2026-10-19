# Troubleshooting

Problems converting raw volumes to the [sharded binary](/data/sharded-binary) format.

- **"Could not determine dimensions":** the filename has no `WxHxD`. Pass them: `bun scripts/decompose-volume.ts data.raw 512 512 256`.
- **Out of memory on large volumes:** the script works in z-slabs, but very large volumes still need several GB of free RAM; 8 GB is a safe minimum.
- **Compressed contrast after 16-bit conversion:** the 8-bit conversion scales by the global min/max, so outliers squeeze the range. Use `--native` to keep 16-bit data and set the window in the viewer, or clip the raw data first.
