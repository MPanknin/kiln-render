# Kiln compatibility sweep

2026-10-01 · Kiln 4fcad87 · 336 datasets from 28 lists (up to 15 per list)

**166 of 336 open (49%).** 143 of them with caveats.

## Why the rest don't open

| Reason | Datasets | Share of all | Example |
|---|---|---|---|
| HCS plate or well, not a single image | 148 | 44% | https://livingobjects.ebi.ac.uk/idr/share/ome2024-ngff-challenge/idr0090/190129.zarr<br>first field: https://livingobjects.ebi.ac.uk/idr/share/ome2024-ngff-challenge/idr0090/190129.zarr/B/7/0 |
| Unsupported axes or dimensions | 11 | 3% | https://livingobjects.ebi.ac.uk/idr/share/ome2024-ngff-challenge/idr0066/ExpA_VIP_ASLM_off_MIP_XZ_1084to1115.zarr<br>Array has 2 dimensions — a volume needs at least 3 |
| Metadata unreachable (404, 403 or network) | 8 | 2% | https://demo.data2-brain.esc.rzg.mpg.de/data/zarr3_experimental/62b17f19010000aa0075d7bb/color<br>HTTP network error |
| No OME-NGFF multiscales metadata | 3 | 1% | https://radosgw.public.os.wwu.de/n4bi-goe/Platynereis-H2B-TL.ome.zarr<br>No OME-NGFF multiscales metadata found |

HCS plates: the first field of 119 of 148 plates opens in Kiln on its own (80%).

## Caveats among datasets that open

| Caveat | Datasets | Share of opening |
|---|---|---|
| thin chunks (>32 chunks per brick) | 75 | 45% |
| 2D (single z-slice) | 48 | 29% |
| time series (first timepoint only) | 26 | 16% |
| legacy pyramid fallback | 5 | 3% |
| labels not shown | 4 | 2% |
| more than 4 channels (first 4 shown) | 3 | 2% |

## What the data looks like

From the 177 datasets whose level-0 metadata could be read.

| Data type | Datasets | Open |
|---|---|---|
| uint16 | 97 | 88 (91%) |
| uint8 | 75 | 73 (97%) |
| float32 | 4 | 4 (100%) |
| int16 | 1 | 1 (100%) |

| OME-NGFF version | Datasets | Open |
|---|---|---|
| 0.5 | 160 | 151 (94%) |
| 0.4 | 7 | 7 (100%) |
| 0.1 | 7 | 7 (100%) |
| 0.3 | 2 | 0 (0%) |
| 0.2 | 1 | 1 (100%) |

| Chunks per brick (level 0) | Datasets |
|---|---|
| 1–8 | 68 |
| 9–32 | 23 |
| 33–128 | 44 |
| over 128 | 31 |

| Z extent (level 0) | Datasets |
|---|---|
| 1 (2D) | 59 |
| 2–63 | 33 |
| 64–511 | 38 |
| 512+ | 47 |

| Size of level 0 (uncompressed) | Datasets |
|---|---|
| under 100 MB | 31 |
| 100 MB – 1 GB | 24 |
| 1–10 GB | 50 |
| over 10 GB | 72 |

| Storage | Datasets |
|---|---|
| sharded (Zarr v3) | 132 |
| unsharded (Zarr v3) | 28 |
| unsharded (Zarr v2) | 17 |

| Codecs | Datasets |
|---|---|
| sharding+bytes+blosc | 132 |
| bytes+zstd | 21 |
| blosc/lz4 | 16 |
| transpose+bytes | 7 |
| zstd | 1 |

## By source

| Source | Sampled | Open | Main blocker |
|---|---|---|---|
| BioImage Archive | 10 | 10 (100%) | – |
| Crick | 1 | 1 (100%) | – |
| IDR · idr0004_samples | 15 | 0 (0%) | HCS plate or well, not a single image (15) |
| IDR · idr0010_samples | 15 | 0 (0%) | HCS plate or well, not a single image (15) |
| IDR · idr0011_samples | 15 | 0 (0%) | HCS plate or well, not a single image (15) |
| IDR · idr0012_samples | 15 | 0 (0%) | HCS plate or well, not a single image (15) |
| IDR · idr0015_samples | 15 | 0 (0%) | HCS plate or well, not a single image (15) |
| IDR · idr0026_samples | 15 | 15 (100%) | – |
| IDR · idr0033_samples | 12 | 0 (0%) | HCS plate or well, not a single image (12) |
| IDR · idr0035_samples | 15 | 0 (0%) | HCS plate or well, not a single image (15) |
| IDR · idr0036_samples | 15 | 0 (0%) | HCS plate or well, not a single image (15) |
| IDR · idr0051_samples | 5 | 5 (100%) | – |
| IDR · idr0054_samples | 3 | 3 (100%) | – |
| IDR · idr0066_samples | 15 | 7 (47%) | Unsupported axes or dimensions (8) |
| IDR · idr0090_samples | 15 | 0 (0%) | HCS plate or well, not a single image (15) |
| IDR · idr0157_samples | 15 | 15 (100%) | – |
| IDR · other_samples | 7 | 7 (100%) | – |
| IDR OME-NGFF samples | 15 | 11 (73%) | HCS plate or well, not a single image (2) |
| JAX · KOMP_adult_lacZ | 15 | 15 (100%) | – |
| JAX · KOMP_histopathology | 15 | 15 (100%) | – |
| Kiln gallery | 11 | 11 (100%) | – |
| NFDI4BIOIMAGE · flamingo | 3 | 0 (0%) | No OME-NGFF multiscales metadata (3) |
| NFDI4BIOIMAGE · fzj | 3 | 2 (67%) | Unsupported axes or dimensions (1) |
| NFDI4BIOIMAGE · lin_samples | 15 | 15 (100%) | – |
| NFDI4BIOIMAGE · uni_muenster_samples | 15 | 1 (7%) | HCS plate or well, not a single image (14) |
| OME-Zarr Open SciVis | 15 | 15 (100%) | – |
| SSBD | 11 | 11 (100%) | – |
| Webknossos | 15 | 7 (47%) | Metadata unreachable (404, 403 or network) (8) |

Per-dataset details: `results.csv`.
