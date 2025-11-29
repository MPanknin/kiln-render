import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BRICK_SIZE, GRID_SIZE, ATLAS_SIZE } from '../src/config.js';

// Test the constants and data logic without GPU
describe('Indirection Constants', () => {
  it('should have correct brick size', () => {
    expect(BRICK_SIZE).toBe(64);
  });

  it('should have correct grid size', () => {
    expect(GRID_SIZE).toBeGreaterThan(0);
    expect(Number.isInteger(GRID_SIZE)).toBe(true);
  });

  it('should have correct atlas size', () => {
    expect(ATLAS_SIZE).toBeGreaterThan(0);
    expect(Number.isInteger(ATLAS_SIZE)).toBe(true);
  });

  it('should have consistent dimensions', () => {
    expect(GRID_SIZE * BRICK_SIZE).toBe(ATLAS_SIZE);
  });
});

describe('Indirection Data Logic', () => {
  // Test the data array manipulation without GPU
  let data: Uint8Array;
  const SCALE = 256 / GRID_SIZE; // Dynamic scale based on grid size

  const setBrick = (
    virtualX: number, virtualY: number, virtualZ: number,
    atlasX: number, atlasY: number, atlasZ: number
  ) => {
    const idx = (virtualX + virtualY * GRID_SIZE + virtualZ * GRID_SIZE * GRID_SIZE) * 4;
    data[idx + 0] = atlasX * SCALE;
    data[idx + 1] = atlasY * SCALE;
    data[idx + 2] = atlasZ * SCALE;
    data[idx + 3] = 255;
  };

  const getBrick = (virtualX: number, virtualY: number, virtualZ: number) => {
    const idx = (virtualX + virtualY * GRID_SIZE + virtualZ * GRID_SIZE * GRID_SIZE) * 4;
    return {
      atlasX: data[idx + 0] / SCALE,
      atlasY: data[idx + 1] / SCALE,
      atlasZ: data[idx + 2] / SCALE,
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
    const lastIdx = GRID_SIZE - 1;
    setBrick(lastIdx, lastIdx, lastIdx, 0, 0, 0);
    const brick = getBrick(lastIdx, lastIdx, lastIdx);
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
          // Use toBeCloseTo for floating point precision issues with byte encoding
          expect(brick.atlasX).toBeCloseTo(x, 1);
          expect(brick.atlasY).toBeCloseTo(y, 1);
          expect(brick.atlasZ).toBeCloseTo(z, 1);
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
    const lastIdx = GRID_SIZE - 1;
    setBrick(0, 0, 0, 1, 1, 1);
    setBrick(lastIdx, lastIdx, lastIdx, 2, 2, 2);

    expect(getBrick(0, 0, 0).atlasX).toBeCloseTo(1, 1);
    expect(getBrick(lastIdx, lastIdx, lastIdx).atlasX).toBeCloseTo(2, 1);
    expect(getBrick(1, 1, 1).loaded).toBe(false);
  });

  it('should encode atlas position in normalized range', () => {
    // Test that the encoding produces values suitable for shader lookup
    const testBrick = Math.floor(GRID_SIZE / 2); // Use middle brick
    setBrick(0, 0, 0, testBrick, testBrick, testBrick);
    const idx = 0;
    const normalizedX = data[idx + 0] / 255;
    // Should represent the brick position normalized to 0-1 range
    expect(normalizedX).toBeCloseTo(testBrick * SCALE / 255, 2);
  });
});
