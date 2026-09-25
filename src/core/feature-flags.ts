/**
 * URL-toggleable flags for A/B-testing perf patches during development.
 *
 * Not part of the public API (never barrel-exported, never imported into
 * src/index.ts) — this is a throwaway harness for the fetch-pattern audit.
 * Each patch that changes runtime behavior gets one flag named after its
 * patch id (e.g. "p2"). Convention:
 *   - flag OFF (default, or param absent) → previous/control behavior
 *   - flag ON  (?p2=1)                    → the patch's new behavior
 * Bench with both to compare, then once a patch is confirmed good, delete
 * the flag/guard from the code (and its entry below) — the new behavior
 * becomes the only behavior.
 *
 * Only readable on the main thread — a dedicated Worker's `self.location` is
 * the worker script's own URL, not the page's, so it can't see these params.
 * A flag that needs to affect worker-side code (e.g. zarr-chunk-worker.ts)
 * must be read here on the main thread and forwarded explicitly through the
 * existing `init`/`loadBrick` postMessage payload, the same way `is16bit` and
 * `targetFormat` are already threaded through — do not try to read
 * `self.location` from inside a worker.
 */

const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
const TRUTHY = new Set(['1', 'true', 'on']);

/** True if `?<name>=1` (or "true"/"on") is present in the page URL. */
export function isFlagEnabled(name: string): boolean {
  const raw = params?.get(name);
  return raw !== null && raw !== undefined && TRUTHY.has(raw.toLowerCase());
}

/** Names of all flags currently set to on — for logging/bench-report traceability. */
export function activeFlags(): string[] {
  if (!params) return [];
  return [...params.keys()].filter(k => TRUTHY.has((params.get(k) ?? '').toLowerCase()));
}
