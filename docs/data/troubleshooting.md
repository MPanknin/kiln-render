# Troubleshooting

Common issues when converting raw volumes to the [sharded binary](/data/sharded-binary) format.

## "Could not determine dimensions"

Specify dimensions explicitly:

```bash
bun scripts/decompose-volume.ts data.raw 512 512 256
```

## Large volumes run out of memory

The script processes data in z-slabs to limit memory usage, but very large volumes may still require significant RAM. Ensure at least 8GB of free RAM.

## 16-bit normalization looks wrong

The script uses global min/max for normalization. If the volume has outliers, contrast may be compressed. Options:
1. Pre-process the raw data to adjust the value range
2. Use `--native` to keep the 16-bit data unconverted (stored internally as `r16float`, not bit-exact) and adjust contrast with windowing in the viewer
