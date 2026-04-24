# Known Issues

## Empty brick threshold is not bit-depth aware

`DatasetConfig.emptyBrickThreshold` (default: 100) is compared against raw integer brick stats.
- 8-bit: 100/255 ≈ 39% of range — reasonable
- 16-bit: 100/65535 ≈ 0.15% of range — effectively no culling

**Fix:** Normalize the threshold to 0–1 and compare against `(stats.max - window.min) / (window.max - window.min)` using the dataset's actual value range from `metadata.window`.

---

## Empty brick culling does not work for Zarr datasets

Brick stats (min/max) in the Zarr path are computed lazily during `assembleBrick()` in the worker and cached in `brickStatsCache`. The streaming manager calls `isBrickEmpty` **before** `loadBrick`, so `getBrickStats` always returns `null` on the first pass → `isBrickEmpty` returns `false` → all bricks are loaded regardless.

Culling only activates on re-visits via the CPU brick cache (i.e., after an eviction/reload cycle).

**Fix options:**
- Add a stats-only pre-pass for the coarsest Zarr LOD (fetch and scan without storing full brick data)
- Or accept the limitation and document it — Zarr culling is a future optimization

---

## Empty brick threshold cannot be determined automatically without a pre-pass

The threshold is inherently dataset-dependent (CT air vs. fluorescence background have different distributions). Automatic determination requires either:
- A histogram of brick max-values from the coarsest LOD (infrastructure already exists via `onBaseLodLoaded`)
- Or a global stats pre-pass before streaming begins

Currently the value must be set manually. A conservative normalized default (e.g. `0.02`) would be safer than the current `100`.
