import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeAxes, extractMultiscales, validateZarrSupport } from '../src/data/zarr-validator.js';

// ---------------------------------------------------------------------------
// normalizeAxes
// ---------------------------------------------------------------------------

describe('normalizeAxes', () => {
  it('returns zyx spatial defaults when axes is absent', () => {
    const axes = normalizeAxes(undefined);
    expect(axes).toEqual([
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ]);
  });

  it('returns zyx spatial defaults when axes is null', () => {
    const axes = normalizeAxes(null);
    expect(axes).toEqual([
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ]);
  });

  it('returns zyx spatial defaults when axes is an empty array', () => {
    expect(normalizeAxes([])).toEqual([
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ]);
  });

  it('normalises v0.4 string array ["z","y","x"] to spatial type', () => {
    const axes = normalizeAxes(['z', 'y', 'x']);
    expect(axes).toEqual([
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ]);
  });

  it('infers channel type for "c" axis in v0.4 string form', () => {
    const axes = normalizeAxes(['c', 'z', 'y', 'x']);
    expect(axes[0]).toEqual({ name: 'c', type: 'channel' });
    expect(axes[1]).toEqual({ name: 'z', type: 'space' });
  });

  it('infers time type for "t" axis in v0.4 string form', () => {
    const axes = normalizeAxes(['t', 'z', 'y', 'x']);
    expect(axes[0]).toEqual({ name: 't', type: 'time' });
  });

  it('normalises v0.5 typed object array', () => {
    const raw = [
      { name: 'z', type: 'space', unit: 'micrometer' },
      { name: 'y', type: 'space', unit: 'micrometer' },
      { name: 'x', type: 'space', unit: 'micrometer' },
    ];
    const axes = normalizeAxes(raw);
    expect(axes).toEqual([
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ]);
  });

  it('normalises v0.5 typed objects with channel and time', () => {
    const raw = [
      { name: 't', type: 'time' },
      { name: 'c', type: 'channel' },
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ];
    const axes = normalizeAxes(raw);
    expect(axes[0]).toEqual({ name: 't', type: 'time' });
    expect(axes[1]).toEqual({ name: 'c', type: 'channel' });
  });

  it('falls back gracefully when name or type fields are missing', () => {
    const axes = normalizeAxes([{ name: 'z' }, { type: 'space' }, {}]);
    expect(axes[0]).toEqual({ name: 'z', type: 'space' });
    expect(axes[1]).toEqual({ name: '', type: 'space' });
    expect(axes[2]).toEqual({ name: '', type: 'space' });
  });

  it('infers channel type from name when type field is absent in v0.5 object form', () => {
    const axes = normalizeAxes([{ name: 'c' }, { name: 'z' }, { name: 'y' }, { name: 'x' }]);
    expect(axes[0]).toEqual({ name: 'c', type: 'channel' });
    expect(axes[1]).toEqual({ name: 'z', type: 'space' });
  });

  it('infers time type from name when type field is absent in v0.5 object form', () => {
    const axes = normalizeAxes([{ name: 't' }, { name: 'z' }, { name: 'y' }, { name: 'x' }]);
    expect(axes[0]).toEqual({ name: 't', type: 'time' });
  });

  it('explicit type field takes precedence over name-based inference', () => {
    // Unusual but valid — trust the explicit type over the name
    const axes = normalizeAxes([{ name: 'c', type: 'space' }]);
    expect(axes[0]).toEqual({ name: 'c', type: 'space' });
  });
});

// ---------------------------------------------------------------------------
// extractMultiscales
// ---------------------------------------------------------------------------

describe('extractMultiscales', () => {
  const ds = [{ path: '0' }, { path: '1' }];

  it('returns null when attrs has no multiscales', () => {
    expect(extractMultiscales({})).toBeNull();
    expect(extractMultiscales({ foo: 'bar' })).toBeNull();
  });

  it('reads v0.4 root-level multiscales', () => {
    const attrs = { multiscales: [{ datasets: ds, version: '0.4' }] };
    const ms = extractMultiscales(attrs);
    expect(ms).not.toBeNull();
    expect(ms!.datasets).toEqual(ds);
    expect(ms!.version).toBe('0.4');
  });

  it('reads v0.5 ome.multiscales', () => {
    const attrs = { ome: { multiscales: [{ datasets: ds, version: '0.5' }] } };
    const ms = extractMultiscales(attrs);
    expect(ms).not.toBeNull();
    expect(ms!.datasets).toEqual(ds);
  });

  it('prefers ome.multiscales over root-level multiscales', () => {
    const attrs = {
      ome: { multiscales: [{ datasets: [{ path: 'ome' }] }] },
      multiscales: [{ datasets: [{ path: 'root' }] }],
    };
    const ms = extractMultiscales(attrs);
    expect(ms!.datasets[0]!.path).toBe('ome');
  });

  it('returns null when ome object has no multiscales', () => {
    expect(extractMultiscales({ ome: {} })).toBeNull();
  });

  it('returns null when multiscales array is empty', () => {
    expect(extractMultiscales({ multiscales: [] })).toBeNull();
  });

  it('always returns the first entry', () => {
    const attrs = {
      multiscales: [
        { datasets: [{ path: 'first' }] },
        { datasets: [{ path: 'second' }] },
      ],
    };
    expect(extractMultiscales(attrs)!.datasets[0]!.path).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// validateZarrSupport
// ---------------------------------------------------------------------------

describe('validateZarrSupport', () => {
  const spatialAxes = ['z', 'y', 'x'];
  const shape3d = [512, 512, 512];

  it('accepts uint8 with 3-d spatial axes', () => {
    const ms = { datasets: [{ path: '0' }], axes: spatialAxes };
    expect(validateZarrSupport(ms, shape3d, 'uint8')).toEqual([]);
  });

  it('accepts uint16 with 3-d spatial axes', () => {
    const ms = { datasets: [{ path: '0' }], axes: spatialAxes };
    expect(validateZarrSupport(ms, shape3d, 'uint16')).toEqual([]);
  });

  it('rejects float32', () => {
    const ms = { datasets: [{ path: '0' }], axes: spatialAxes };
    const reasons = validateZarrSupport(ms, shape3d, 'float32');
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons[0]).toMatch(/float32/);
  });

  it('rejects float64', () => {
    const ms = { datasets: [{ path: '0' }], axes: spatialAxes };
    const reasons = validateZarrSupport(ms, shape3d, 'float64');
    expect(reasons.length).toBeGreaterThan(0);
  });

  it('rejects int32', () => {
    const ms = { datasets: [{ path: '0' }], axes: spatialAxes };
    expect(validateZarrSupport(ms, shape3d, 'int32').length).toBeGreaterThan(0);
  });

  it('does not reject time-series datasets (warns, loads t=0)', () => {
    const ms = { datasets: [{ path: '0' }], axes: ['t', 'z', 'y', 'x'] };
    const reasons = validateZarrSupport(ms, [1, 512, 512, 512], 'uint16');
    expect(reasons).toEqual([]);
  });

  it('does not reject multi-channel datasets (warns, loads ch=0)', () => {
    const ms = { datasets: [{ path: '0' }], axes: ['c', 'z', 'y', 'x'] };
    const reasons = validateZarrSupport(ms, [2, 512, 512, 512], 'uint16');
    expect(reasons).toEqual([]);
  });

  it('accepts absent axes (defaults to zyx)', () => {
    const ms = { datasets: [{ path: '0' }] };
    expect(validateZarrSupport(ms, shape3d, 'uint8')).toEqual([]);
  });

  it('returns an empty array (no rejection) for v0.4 version string', () => {
    const ms = { datasets: [{ path: '0' }], axes: spatialAxes, version: '0.4' };
    expect(validateZarrSupport(ms, shape3d, 'uint16')).toEqual([]);
  });

  it('does not reject a 4-channel dataset and emits no warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ms = { datasets: [{ path: '0' }], axes: ['c', 'z', 'y', 'x'] };
    const reasons = validateZarrSupport(ms, [4, 512, 512, 512], 'uint16');
    expect(reasons).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/channels/));
    warnSpy.mockRestore();
  });

  it('does not reject a 5-channel dataset but warns that only 4 channels will be rendered', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ms = { datasets: [{ path: '0' }], axes: ['c', 'z', 'y', 'x'] };
    const reasons = validateZarrSupport(ms, [5, 512, 512, 512], 'uint16');
    // Should still be loadable — no rejection reasons
    expect(reasons).toEqual([]);
    // But it must have warned the user
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/5 channels/));
    warnSpy.mockRestore();
  });

  it('does not reject a 2-channel dataset (no warning needed)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ms = { datasets: [{ path: '0' }], axes: ['c', 'z', 'y', 'x'] };
    const reasons = validateZarrSupport(ms, [2, 512, 512, 512], 'uint16');
    expect(reasons).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/channels/));
    warnSpy.mockRestore();
  });
});
