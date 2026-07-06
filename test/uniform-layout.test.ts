/**
 * Uniform layout guard — COMPUTE_UNIFORMS / SLICE_UNIFORMS are the single source
 * of truth mirrored by both the WGSL struct and the DataView writes in Renderer.
 * A wrong offset or size silently corrupts every frame's uniforms, so this locks
 * the byte layout and the WGSL std140/std430 alignment rules the builder must obey.
 *
 * If a field is reordered/added, these assertions fail — forcing the WGSL struct
 * and the CPU-side writes to be updated deliberately, together.
 */
import { describe, it, expect } from 'vitest';
import { COMPUTE_UNIFORMS, SLICE_UNIFORMS } from '../src/shaders/uniform-layout.js';

describe('COMPUTE_UNIFORMS layout', () => {
  it('has the expected total size (multiple of 16)', () => {
    expect(COMPUTE_UNIFORMS.size).toBe(272);
    expect(COMPUTE_UNIFORMS.size % 16).toBe(0);
  });

  it('pins the critical field offsets', () => {
    expect(COMPUTE_UNIFORMS.offsets).toMatchObject({
      inverseViewProj: 0,
      cameraPos: 64,
      useIndirection: 76,   // scalar packed into the vec3 tail
      datasetSize: 80,
      clipMin: 144,
      densityScale: 156,    // scalar packed after clipMin's vec3
      channelColors: 176,
      channelWindowCenter: 240,
      channelWindowWidth: 256,
    });
  });

  it('emits one WGSL field line per uniform', () => {
    for (const name of Object.keys(COMPUTE_UNIFORMS.offsets)) {
      expect(COMPUTE_UNIFORMS.fields).toContain(`${name}:`);
    }
  });
});

describe('SLICE_UNIFORMS layout', () => {
  it('has the expected total size (multiple of 16)', () => {
    expect(SLICE_UNIFORMS.size).toBe(240);
    expect(SLICE_UNIFORMS.size % 16).toBe(0);
  });

  it('pins the critical field offsets', () => {
    expect(SLICE_UNIFORMS.offsets).toMatchObject({
      mvp: 0,
      normalizedSize: 64,
      datasetSize: 80,
      slicePositions: 112,
      channelColors: 144,
      channelWindowCenter: 208,
      channelWindowWidth: 224,
    });
  });
});

describe('WGSL alignment invariants', () => {
  // vec3 has 16-byte alignment but 12-byte size; the field after a vec3 must sit
  // at vec3_offset + 12 (packed into the padding), and 16-byte-aligned types must
  // land on 16-byte boundaries.
  it('packs scalars into the vec3 tail', () => {
    expect(COMPUTE_UNIFORMS.offsets.useIndirection - COMPUTE_UNIFORMS.offsets.cameraPos).toBe(12);
    expect(COMPUTE_UNIFORMS.offsets.densityScale - COMPUTE_UNIFORMS.offsets.clipMin).toBe(12);
  });

  it('16-byte-aligned members start on 16-byte boundaries', () => {
    for (const name of ['inverseViewProj', 'clipMin', 'clipMax', 'channelColors', 'channelWindowCenter', 'channelWindowWidth'] as const) {
      expect(COMPUTE_UNIFORMS.offsets[name] % 16).toBe(0);
    }
  });
});
