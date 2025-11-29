import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BRICK_SIZE, GRID_SIZE, ATLAS_SIZE } from './indirection.js';

// Test the constants and data logic without GPU
describe('Indirection Constants', () => {
  it('should have correct brick size', () => {
    expect(BRICK_SIZE).toBe(64);
  });

  it('should have correct grid size', () => {
    expect(GRID_SIZE).toBe(8);
  });

  it('should have correct atlas size', () => {
    expect(ATLAS_SIZE).toBe(512);
  });

  it('should have consistent dimensions', () => {
    expect(GRID_SIZE * BRICK_SIZE).toBe(ATLAS_SIZE);
  });
});

describe('Indirection Data Logic', () => {
  // Test the data array manipulation without GPU
  let data: Uint8Array;

  const setBrick = (
    virtualX: number, virtualY: number, virtualZ: number,
    atlasX: number, atlasY: number, atlasZ: number
  ) => {
    const idx = (virtualX + virtualY * GRID_SIZE + virtualZ * GRID_SIZE * GRID_SIZE) * 4;
    data[idx + 0] = atlasX * 32;
    data[idx + 1] = atlasY * 32;
    data[idx + 2] = atlasZ * 32;
    data[idx + 3] = 255;
  };

  const getBrick = (virtualX: number, virtualY: number, virtualZ: number) => {
    const idx = (virtualX + virtualY * GRID_SIZE + virtualZ * GRID_SIZE * GRID_SIZE) * 4;
    return {
      atlasX: data[idx + 0] / 32,
      atlasY: data[idx + 1] / 32,
      atlasZ: data[idx + 2] / 32,
      loaded: data[idx + 3] === 255,
    };
  };

  const clearBrick = (virtualX: number, virtualY: number, virtualZ: number) => {
    const idx = (virtualX + virtualY * GRID_SIZE + virtualZ * GRID_SIZE * GRID_SIZE) * 4;
    data[idx + 0] = 0;
    data[idx + 1] = 0;
    data[idx + 2] = 0;
    data[idx + 3] = 0;
  };

  beforeEach(() => {
    data = new Uint8Array(GRID_SIZE * GRID_SIZE * GRID_SIZE * 4);
  });

  it('should start with all bricks unloaded', () => {
    for (let z = 0; z < GRID_SIZE; z++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const brick = getBrick(x, y, z);
          expect(brick.loaded).toBe(false);
        }
      }
    }
  });

  it('should set brick mapping correctly', () => {
    setBrick(0, 0, 0, 0, 0, 0);
    const brick = getBrick(0, 0, 0);
    expect(brick.loaded).toBe(true);
    expect(brick.atlasX).toBe(0);
    expect(brick.atlasY).toBe(0);
    expect(brick.atlasZ).toBe(0);
  });

  it('should map virtual to different atlas position', () => {
    setBrick(7, 7, 7, 0, 0, 0);
    const brick = getBrick(7, 7, 7);
    expect(brick.loaded).toBe(true);
    expect(brick.atlasX).toBe(0);
    expect(brick.atlasY).toBe(0);
    expect(brick.atlasZ).toBe(0);
  });

  it('should handle all atlas positions', () => {
    for (let z = 0; z < GRID_SIZE; z++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          setBrick(x, y, z, x, y, z);
          const brick = getBrick(x, y, z);
          expect(brick.atlasX).toBe(x);
          expect(brick.atlasY).toBe(y);
          expect(brick.atlasZ).toBe(z);
        }
      }
    }
  });

  it('should clear brick correctly', () => {
    setBrick(3, 3, 3, 1, 2, 3);
    expect(getBrick(3, 3, 3).loaded).toBe(true);

    clearBrick(3, 3, 3);
    expect(getBrick(3, 3, 3).loaded).toBe(false);
  });

  it('should not affect other bricks when setting one', () => {
    setBrick(0, 0, 0, 1, 1, 1);
    setBrick(7, 7, 7, 2, 2, 2);

    expect(getBrick(0, 0, 0).atlasX).toBe(1);
    expect(getBrick(7, 7, 7).atlasX).toBe(2);
    expect(getBrick(1, 1, 1).loaded).toBe(false);
  });

  it('should encode atlas position in normalized range', () => {
    // Test that the encoding produces values suitable for shader lookup
    // atlasX * 32 / 255 should give approximately atlasX / 8
    setBrick(0, 0, 0, 4, 4, 4);
    const idx = 0;
    const normalizedX = data[idx + 0] / 255;
    // 4 * 32 / 255 ≈ 0.502, which represents brick 4 out of 8
    expect(normalizedX).toBeCloseTo(4 * 32 / 255, 2);
  });
});
