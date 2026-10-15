/**
 * 16-bit atlas formats: r16unorm when the device allows it, otherwise uint16 on
 * r16float stored as value - UINT16_FLOAT16_OFFSET (lossless up to 4096).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { detectBest16BitFormat } from '../src/core/volume.js';
import { computeHistogram } from '../src/core/histogram.js';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { getUint16ToFloat16Lut, uint16ToFloat16 } from '../src/utils/float16.js';

describe('detectBest16BitFormat', () => {
  beforeAll(() => {
    vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2 });
    vi.stubGlobal('GPUShaderStage', { COMPUTE: 4, FRAGMENT: 2 });
  });
  afterAll(() => vi.unstubAllGlobals());

  // Model WebGPU's non-throwing validation: createBindGroup returns an invalid
  // object, and the rejection is delivered only by popErrorScope().
  function device(tier1: boolean, filterable: string[] = ['r16float', 'r8unorm']) {
    let validationError: GPUError | null = null;
    const textures: { format: string; destroy: ReturnType<typeof vi.fn> }[] = [];
    const gpu = {
      features: new Set(tier1 ? ['texture-formats-tier1'] : []),
      pushErrorScope: vi.fn(() => { validationError = null; }),
      popErrorScope: vi.fn(() => Promise.resolve(validationError)),
      createTexture: vi.fn(({ format }: GPUTextureDescriptor) => {
        const texture = { format, destroy: vi.fn(), createView: () => ({ format }) };
        textures.push(texture);
        return texture;
      }),
      createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor),
      createBindGroup: vi.fn(({ layout, entries }: any) => {
        const binding = layout.entries[0].texture;
        expect(binding).toEqual({ sampleType: 'float', viewDimension: '3d' });
        if (!filterable.includes(entries[0].resource.format)) {
          validationError = { message: 'UnfilterableFloat does not match Float' } as GPUError;
        }
        return {};
      }),
    };
    return { gpu, device: gpu as unknown as GPUDevice, textures };
  }

  it('falls back when tier1 exposes r16unorm without filtering', async () => {
    const d = device(true);
    expect(await detectBest16BitFormat(d.device)).toBe('r16float');
    expect(d.textures.map(t => t.format)).toEqual(['r16unorm', 'r16float']);
    expect(d.gpu.popErrorScope).toHaveBeenCalledTimes(2);
    for (const t of d.textures) expect(t.destroy).toHaveBeenCalledOnce();
  });

  it('uses r16unorm only when its filterable binding validates', async () => {
    const d = device(true, ['r16unorm', 'r16float']);
    expect(await detectBest16BitFormat(d.device)).toBe('r16unorm');
    expect(d.textures).toHaveLength(1);
    expect(d.textures[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('skips r16unorm without tier1 and for signed/float source data', async () => {
    for (const [tier1, isFloat] of [[false, false], [true, true]]) {
      const d = device(tier1!);
      expect(await detectBest16BitFormat(d.device, isFloat)).toBe('r16float');
      expect(d.textures.map(t => t.format)).toEqual(['r16float']);
    }
  });

  it('checks asynchronous errors before selecting the r8unorm fallback', async () => {
    const d = device(true, ['r8unorm']);
    expect(await detectBest16BitFormat(d.device)).toBe('r8unorm');
    expect(d.textures.map(t => t.format)).toEqual(['r16unorm', 'r16float', 'r8unorm']);
  });

  it('balances scopes and cleans up when a probe throws synchronously', async () => {
    const d = device(true);
    d.gpu.createBindGroup.mockImplementationOnce(() => { throw new Error('unsupported'); });
    expect(await detectBest16BitFormat(d.device)).toBe('r16float');
    expect(d.gpu.pushErrorScope).toHaveBeenCalledTimes(2);
    expect(d.gpu.popErrorScope).toHaveBeenCalledTimes(2);
    for (const t of d.textures) expect(t.destroy).toHaveBeenCalledOnce();
  });

  it('rejects initialization if no candidate validates', async () => {
    const d = device(true, []);
    await expect(detectBest16BitFormat(d.device)).rejects.toThrow('No filterable atlas');
    for (const t of d.textures) expect(t.destroy).toHaveBeenCalledOnce();
  });
});

describe('uint16 on r16float', () => {
  it('histograms 12-bit data exactly like the raw values', () => {
    const values = Uint16Array.from({ length: 4097 }, (_, i) => i);
    const stored = computeHistogram([uint16ToFloat16(values)], 16, 4096, false, 0, 1, 'r16float');
    const raw = computeHistogram([values], 16, 4096, false, 0, 1, 'r16unorm');
    expect(Array.from(stored)).toEqual(Array.from(raw));
  });

  it('fills zero bricks with the stored form of 0', () => {
    const zeroBrick = (format: GPUTextureFormat, isFloat: boolean) =>
      (StreamingManager.prototype as any).getZeroBrick.call(
        { zeroBricks: new Map(), metadata: { isFloat } },
        { bitDepth: 16, format },
      ) as Uint16Array;

    expect(new Set(zeroBrick('r16float', false))).toEqual(new Set([getUint16ToFloat16Lut()[0]]));
    expect(new Set(zeroBrick('r16unorm', false))).toEqual(new Set([0]));
    expect(new Set(zeroBrick('r16float', true))).toEqual(new Set([0]));
  });
});
