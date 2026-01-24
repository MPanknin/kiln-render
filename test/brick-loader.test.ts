import { describe, it, expect } from 'vitest';
import {
  formatToBitDepth,
  bitDepthToFormat,
  type VolumeFormat,
  type BitDepth,
} from '../src/streaming/brick-loader.js';

describe('Brick Loader Format Utilities', () => {
  describe('formatToBitDepth', () => {
    it('should convert uint8 to 8-bit', () => {
      expect(formatToBitDepth('uint8')).toBe(8);
    });

    it('should convert uint16 to 16-bit', () => {
      expect(formatToBitDepth('uint16')).toBe(16);
    });
  });

  describe('bitDepthToFormat', () => {
    it('should convert 8-bit to uint8', () => {
      expect(bitDepthToFormat(8)).toBe('uint8');
    });

    it('should convert 16-bit to uint16', () => {
      expect(bitDepthToFormat(16)).toBe('uint16');
    });
  });

  describe('round-trip conversion', () => {
    it('should round-trip uint8 correctly', () => {
      const format: VolumeFormat = 'uint8';
      const bitDepth = formatToBitDepth(format);
      const backToFormat = bitDepthToFormat(bitDepth);
      expect(backToFormat).toBe(format);
    });

    it('should round-trip uint16 correctly', () => {
      const format: VolumeFormat = 'uint16';
      const bitDepth = formatToBitDepth(format);
      const backToFormat = bitDepthToFormat(bitDepth);
      expect(backToFormat).toBe(format);
    });

    it('should round-trip 8-bit correctly', () => {
      const bitDepth: BitDepth = 8;
      const format = bitDepthToFormat(bitDepth);
      const backToBitDepth = formatToBitDepth(format);
      expect(backToBitDepth).toBe(bitDepth);
    });

    it('should round-trip 16-bit correctly', () => {
      const bitDepth: BitDepth = 16;
      const format = bitDepthToFormat(bitDepth);
      const backToBitDepth = formatToBitDepth(format);
      expect(backToBitDepth).toBe(bitDepth);
    });
  });
});

describe('Brick Data Types', () => {
  describe('8-bit data', () => {
    it('should handle Uint8Array correctly', () => {
      const data = new Uint8Array([0, 127, 255]);
      expect(data.length).toBe(3);
      expect(data[0]).toBe(0);
      expect(data[1]).toBe(127);
      expect(data[2]).toBe(255);
      expect(data.BYTES_PER_ELEMENT).toBe(1);
    });

    it('should have correct byte length for brick size', () => {
      const physicalSize = 66; // 64 + 2 padding
      const brickVoxels = physicalSize ** 3;
      const data = new Uint8Array(brickVoxels);
      expect(data.byteLength).toBe(287496); // 66^3
    });
  });

  describe('16-bit data', () => {
    it('should handle Uint16Array correctly', () => {
      const data = new Uint16Array([0, 32767, 65535]);
      expect(data.length).toBe(3);
      expect(data[0]).toBe(0);
      expect(data[1]).toBe(32767);
      expect(data[2]).toBe(65535);
      expect(data.BYTES_PER_ELEMENT).toBe(2);
    });

    it('should have correct byte length for brick size', () => {
      const physicalSize = 66; // 64 + 2 padding
      const brickVoxels = physicalSize ** 3;
      const data = new Uint16Array(brickVoxels);
      expect(data.byteLength).toBe(574992); // 66^3 * 2
    });

    it('should be exactly 2x the size of 8-bit for same voxel count', () => {
      const voxelCount = 66 ** 3;
      const data8 = new Uint8Array(voxelCount);
      const data16 = new Uint16Array(voxelCount);
      expect(data16.byteLength).toBe(data8.byteLength * 2);
    });
  });

  describe('16-bit to 8-bit conversion simulation', () => {
    it('should normalize 16-bit values to 8-bit range', () => {
      // Simulate the conversion that happens during non-native 16-bit processing
      const input16 = new Uint16Array([0, 32768, 65535]);
      const globalMin = 0;
      const globalMax = 65535;
      const range = globalMax - globalMin;

      const output8 = new Uint8Array(input16.length);
      for (let i = 0; i < input16.length; i++) {
        const normalized = Math.round(((input16[i]! - globalMin) / range) * 255);
        output8[i] = Math.max(0, Math.min(255, normalized));
      }

      expect(output8[0]).toBe(0);
      expect(output8[1]).toBe(128); // 32768/65535 * 255 ≈ 128
      expect(output8[2]).toBe(255);
    });

    it('should handle custom min/max ranges', () => {
      // Volume with values only between 1000-5000
      const input16 = new Uint16Array([1000, 3000, 5000]);
      const globalMin = 1000;
      const globalMax = 5000;
      const range = globalMax - globalMin;

      const output8 = new Uint8Array(input16.length);
      for (let i = 0; i < input16.length; i++) {
        const normalized = Math.round(((input16[i]! - globalMin) / range) * 255);
        output8[i] = Math.max(0, Math.min(255, normalized));
      }

      expect(output8[0]).toBe(0);   // min maps to 0
      expect(output8[1]).toBe(128); // middle maps to 128
      expect(output8[2]).toBe(255); // max maps to 255
    });
  });
});

describe('Cache Key Generation', () => {
  it('should generate unique keys for different bricks', () => {
    const makeKey = (lod: number, bx: number, by: number, bz: number) =>
      `lod${lod}:${bx}-${by}-${bz}`;

    const key1 = makeKey(0, 0, 0, 0);
    const key2 = makeKey(0, 1, 0, 0);
    const key3 = makeKey(1, 0, 0, 0);

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key2).not.toBe(key3);
  });

  it('should generate consistent keys', () => {
    const makeKey = (lod: number, bx: number, by: number, bz: number) =>
      `lod${lod}:${bx}-${by}-${bz}`;

    expect(makeKey(2, 3, 4, 5)).toBe('lod2:3-4-5');
    expect(makeKey(0, 0, 0, 0)).toBe('lod0:0-0-0');
  });
});

describe('16-bit Data Integrity', () => {
  describe('Native 16-bit precision', () => {
    it('should preserve full 16-bit precision in Uint16Array', () => {
      // Test critical values across the 16-bit range
      const testValues = [
        0,      // Minimum
        1,      // Near minimum
        255,    // 8-bit max
        256,    // Just above 8-bit
        32767,  // Half of max
        32768,  // Just above half
        65534,  // Near maximum
        65535,  // Maximum
      ];

      const data = new Uint16Array(testValues);
      for (let i = 0; i < testValues.length; i++) {
        expect(data[i]).toBe(testValues[i]);
      }
    });

    it('should maintain precision for adjacent values', () => {
      // Adjacent 16-bit values must remain distinguishable
      // This tests that we don't lose the low bits
      for (let i = 0; i < 1000; i++) {
        const val = i * 65;
        const data = new Uint16Array([val, val + 1]);
        expect(data[1] - data[0]).toBe(1);
      }
    });

    it('should handle ArrayBuffer views correctly', () => {
      // 16-bit data stored in ArrayBuffer for transfer
      const buffer = new ArrayBuffer(8);
      const view16 = new Uint16Array(buffer);
      view16[0] = 0;
      view16[1] = 32768;
      view16[2] = 65535;
      view16[3] = 12345;

      // Verify round-trip through ArrayBuffer
      const view16b = new Uint16Array(buffer);
      expect(view16b[0]).toBe(0);
      expect(view16b[1]).toBe(32768);
      expect(view16b[2]).toBe(65535);
      expect(view16b[3]).toBe(12345);
    });
  });

  describe('Byte order (endianness)', () => {
    it('should handle little-endian encoding correctly', () => {
      // WebGPU and most systems use little-endian
      const buffer = new ArrayBuffer(4);
      const view16 = new Uint16Array(buffer);
      const view8 = new Uint8Array(buffer);

      // Write 0x1234 (4660 decimal)
      view16[0] = 0x1234;
      // In little-endian: low byte first
      expect(view8[0]).toBe(0x34);  // Low byte
      expect(view8[1]).toBe(0x12);  // High byte

      // Write 0xABCD
      view16[1] = 0xABCD;
      expect(view8[2]).toBe(0xCD);  // Low byte
      expect(view8[3]).toBe(0xAB);  // High byte
    });

    it('should round-trip through byte representation', () => {
      const original = new Uint16Array([0, 1000, 32768, 50000, 65535]);
      const buffer = original.buffer;

      // Create new view from same buffer
      const restored = new Uint16Array(buffer);

      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBe(original[i]);
      }
    });
  });

  describe('Normalization precision', () => {
    it('should normalize 16-bit to 0-1 float with high precision', () => {
      // Simulates GPU normalization (r16unorm texture)
      // r16unorm maps 0->0.0, 65535->1.0
      const testCases: [number, number][] = [
        [0, 0.0],
        [65535, 1.0],
        [32767, 32767 / 65535],  // ~0.499992
        [32768, 32768 / 65535],  // ~0.500008
      ];

      for (const [input, expected] of testCases) {
        const normalized = input / 65535;
        expect(normalized).toBeCloseTo(expected, 5);
      }
    });

    it('should distinguish adjacent 16-bit values in normalized form', () => {
      // Critical: adjacent 16-bit values must produce different floats
      const val1 = 32767;
      const val2 = 32768;
      const norm1 = val1 / 65535;
      const norm2 = val2 / 65535;

      expect(norm2).toBeGreaterThan(norm1);
      // Difference should be ~1.5e-5
      expect(norm2 - norm1).toBeCloseTo(1 / 65535, 6);
    });

    it('should preserve 16-bit resolution through float normalization', () => {
      // Verify we can recover the original 16-bit value from normalized float
      for (let i = 0; i < 100; i++) {
        const original = Math.floor(Math.random() * 65536);
        const normalized = original / 65535;
        const recovered = Math.round(normalized * 65535);
        expect(recovered).toBe(original);
      }
    });
  });

  describe('Windowing function integrity', () => {
    // Test the windowing logic that maps a sub-range to 0-1
    const applyWindow = (density: number, windowCenter: number, windowWidth: number): number => {
      const halfWidth = windowWidth * 0.5;
      const minVal = windowCenter - halfWidth;
      const maxVal = windowCenter + halfWidth;
      return Math.max(0, Math.min(1, (density - minVal) / Math.max(windowWidth, 0.001)));
    };

    it('should pass through full range when window is 0.5/1.0', () => {
      // Default window: center=0.5, width=1.0 -> maps 0-1 to 0-1
      expect(applyWindow(0, 0.5, 1.0)).toBeCloseTo(0);
      expect(applyWindow(0.5, 0.5, 1.0)).toBeCloseTo(0.5);
      expect(applyWindow(1, 0.5, 1.0)).toBeCloseTo(1);
    });

    it('should expand narrow range to full output', () => {
      // Window: center=0.3, width=0.2 -> maps 0.2-0.4 to 0-1
      expect(applyWindow(0.2, 0.3, 0.2)).toBeCloseTo(0);
      expect(applyWindow(0.3, 0.3, 0.2)).toBeCloseTo(0.5);
      expect(applyWindow(0.4, 0.3, 0.2)).toBeCloseTo(1);
    });

    it('should clamp values outside window', () => {
      // Values outside window should clamp to 0 or 1
      expect(applyWindow(0.1, 0.5, 0.2)).toBeCloseTo(0);  // Below window
      expect(applyWindow(0.9, 0.5, 0.2)).toBeCloseTo(1);  // Above window
    });

    it('should handle typical CT windowing scenario', () => {
      // Simulate CT: data range 0-65535 normalized, viewing soft tissue window
      // Soft tissue: ~40 HU center, ~400 HU width in typical range
      // Normalized to 0-1: center ~0.5, width ~0.1
      const windowCenter = 0.5;
      const windowWidth = 0.1;  // Narrow window for contrast

      // Values at window edges
      expect(applyWindow(0.45, windowCenter, windowWidth)).toBeCloseTo(0);
      expect(applyWindow(0.55, windowCenter, windowWidth)).toBeCloseTo(1);

      // Value at center
      expect(applyWindow(0.5, windowCenter, windowWidth)).toBeCloseTo(0.5);
    });

    it('should preserve relative ordering through windowing', () => {
      // Values within window should maintain their relative order
      const windowCenter = 0.6;
      const windowWidth = 0.3;

      const values = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75];
      const windowed = values.map(v => applyWindow(v, windowCenter, windowWidth));

      for (let i = 1; i < windowed.length; i++) {
        expect(windowed[i]).toBeGreaterThanOrEqual(windowed[i - 1]!);
      }
    });
  });

  describe('Brick data simulation', () => {
    it('should handle full brick of 16-bit data', () => {
      const physicalSize = 66;
      const brickVoxels = physicalSize ** 3;

      // Create brick with gradient data
      const data = new Uint16Array(brickVoxels);
      for (let i = 0; i < brickVoxels; i++) {
        // Create unique values that span the full range
        data[i] = Math.floor((i / brickVoxels) * 65535);
      }

      // Verify data integrity
      expect(data[0]).toBe(0);
      expect(data[brickVoxels - 1]).toBe(65534); // Near max

      // Verify middle values
      const midIndex = Math.floor(brickVoxels / 2);
      expect(data[midIndex]).toBeCloseTo(32767, -2); // Allow some tolerance
    });

    it('should maintain precision in sparse data', () => {
      // Simulates volume with lots of empty space and sparse high values
      const data = new Uint16Array(1000);

      // Set specific high-precision values at sparse locations
      data[0] = 0;
      data[100] = 12345;
      data[500] = 54321;
      data[999] = 65535;

      // Verify exact values are preserved
      expect(data[0]).toBe(0);
      expect(data[100]).toBe(12345);
      expect(data[500]).toBe(54321);
      expect(data[999]).toBe(65535);

      // Verify zeros are maintained
      expect(data[50]).toBe(0);
      expect(data[200]).toBe(0);
    });
  });
});
